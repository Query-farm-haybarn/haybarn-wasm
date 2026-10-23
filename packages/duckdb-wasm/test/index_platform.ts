import * as duckdb from '../src/';
import { composeWorkerBridges, installVgiOAuthBridge, installVgiWebWorkerBridge } from '../src/vgi';

// Haybarn: the platform functions the engine gives extensions (OAuth popup, page origin, Web Crypto, SHA-256, the VGI
// worker: transport), through the haybarn_platform_test extension of the local repository
// (lib/test/extensions/haybarn_platform_test), on both bundles (karma/platform-chrome.cjs, a cross-origin isolated
// page). On the threads bundle an extension calls them from the query thread or a DuckDB worker, a pthread: the ones
// that need the worker's globals or the page must still work from there.

const BUNDLES: Record<string, duckdb.DuckDBBundle> = {
    base: {
        mainModule: '/static/duckdb-base.wasm',
        mainWorker: '/static/duckdb-browser-base.worker.js',
        pthreadWorker: null,
    },
    threads: {
        mainModule: '/static/duckdb-threads.wasm',
        mainWorker: '/static/duckdb-browser-threads.worker.js',
        pthreadWorker: '/static/duckdb-browser-threads.pthread.worker.js',
    },
};

/** The VGI worker of the tests, served same-origin by karma */
const ECHO_WORKER = '/base/packages/duckdb-wasm/test/vgi_echo_worker.js';
/** The app's OAuth redirect target, served by karma */
const CALLBACK = '/base/packages/duckdb-wasm-app/static/oauth-callback.html';
const INTERRUPTED = /INTERRUPT/i;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sql = (s: string) => s.replace(/'/g, "''");

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Replace window.open for one login: `answer` decides what the "popup" does */
function fakePopup(answer: (url: string) => Window | null): { urls: string[]; restore: () => void } {
    const original = window.open;
    const urls: string[] = [];
    window.open = ((url?: string | URL) => {
        urls.push(String(url));
        return answer(String(url));
    }) as typeof window.open;
    return { urls, restore: () => (window.open = original) };
}

/** A popup that lands on the callback page with `query`, in an iframe: the page relays it over BroadcastChannel */
function callbackPopup(query: string): Window {
    const frame = document.createElement('iframe');
    frame.src = `${CALLBACK}?${query}`;
    document.body.appendChild(frame);
    return { close: () => frame.remove() } as unknown as Window;
}

for (const variant of ['base', 'threads']) {
    const threads = variant === 'threads';
    describe(`Platform functions for extensions (${variant})`, () => {
        let worker: Worker;
        let db: duckdb.AsyncDuckDB;
        let conn: duckdb.AsyncDuckDBConnection;
        const scalar = async (query: string) => (await conn.query(query)).getChildAt(0)!.get(0);
        const id = () => conn.useUnsafe((_, c) => c);

        beforeAll(async () => {
            worker = new Worker(BUNDLES[variant].mainWorker!);
            composeWorkerBridges(installVgiOAuthBridge, installVgiWebWorkerBridge())(worker);
            db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
            await db.instantiate(BUNDLES[variant].mainModule, BUNDLES[variant].pthreadWorker);
            await db.open({
                extensionRepository: new URL('/extensions', location.href).href,
                allowUnsignedExtensions: true,
            });
            const c = await db.connect();
            // The extension imports every platform function: it loads only if all of them link
            await c.query('INSTALL haybarn_platform_test');
            await c.query('LOAD haybarn_platform_test');
            await c.close();
        });
        afterAll(async () => {
            await db.terminate();
        });
        beforeEach(async () => {
            conn = await db.connect();
            if (threads) await conn.query('SET threads = 4');
        });
        afterEach(async () => {
            await conn.close();
        });

        it('hashes with SHA-256, on every thread', async () => {
            expect(await scalar("SELECT haybarn_platform_sha256('abc')")).toEqual(await sha256Hex('abc'));
            expect(await scalar("SELECT haybarn_platform_sha256('')")).toEqual(await sha256Hex(''));
            await conn.query('CREATE TABLE numbers AS SELECT range AS i FROM range(300000)');
            expect(
                Number(await scalar('SELECT count(DISTINCT haybarn_platform_sha256(i::VARCHAR)) FROM numbers')),
            ).toEqual(300000);
            expect(await scalar('SELECT haybarn_platform_sha256(i::VARCHAR) FROM numbers WHERE i = 299999')).toEqual(
                await sha256Hex('299999'),
            );
            await conn.query('DROP TABLE numbers');
        });

        it('fills random bytes from Web Crypto, every 64 KiB chunk', async () => {
            const n = (1 << 20) + 5;
            expect(await scalar(`SELECT haybarn_platform_random_chunks(${n})`)).toEqual(Math.ceil(n / 65536));
            const a = await scalar('SELECT haybarn_platform_random(16)');
            const b = await scalar('SELECT haybarn_platform_random(16)');
            expect(a.length).toEqual(32);
            expect(a).not.toEqual(b);
        });

        it('knows the page origin', async () => {
            expect(await scalar('SELECT haybarn_platform_page_origin()')).toEqual(location.origin);
        });

        it('opens the OAuth popup and returns the code the callback page relays', async () => {
            const popup = fakePopup(() => callbackPopup('code=code-123&state=s1'));
            try {
                const url = 'https://idp.example.com/authorize?client_id=x&state=s1';
                expect(await scalar(`SELECT haybarn_platform_open_auth('${sql(url)}', 20000)`)).toEqual('code-123');
                expect(popup.urls).toEqual([url]);
            } finally {
                popup.restore();
            }
        });

        it('reports an OAuth error from the callback page', async () => {
            const popup = fakePopup(() => callbackPopup('error=access_denied&error_description=Nope'));
            try {
                expect(await scalar("SELECT haybarn_platform_open_auth('https://idp.example.com/a', 20000)")).toEqual(
                    'error: Nope',
                );
            } finally {
                popup.restore();
            }
        });

        it('reports a blocked popup', async () => {
            const popup = fakePopup(() => null);
            try {
                expect(await scalar("SELECT haybarn_platform_open_auth('https://idp.example.com/a', 20000)")).toEqual(
                    'error: Popup blocked by browser',
                );
            } finally {
                popup.restore();
            }
        });

        it('times out a login nobody completes', async () => {
            const popup = fakePopup(() => ({ close: () => {} }) as unknown as Window);
            try {
                const started = performance.now();
                expect(await scalar("SELECT haybarn_platform_open_auth('https://idp.example.com/a', 3000)")).toEqual(
                    'error: Authentication timed out',
                );
                expect(performance.now() - started).toBeLessThan(10000);
            } finally {
                popup.restore();
            }
        });

        if (!threads) {
            it('has no worker: transport without shared memory', async () => {
                await expectAsync(
                    conn.query(`SELECT haybarn_platform_vgi_exchange('${ECHO_WORKER}', 'hello')`),
                ).toBeRejectedWithError(/vgi_wasm_ensure_worker failed/);
            });
            return;
        }

        it('exchanges a request with a VGI worker the page spawns', async () => {
            expect(await scalar(`SELECT haybarn_platform_vgi_exchange('${ECHO_WORKER}', 'hello')`)).toEqual(
                'echo:hello',
            );
            // Longer than the ring in both directions
            const long = 'x'.repeat(1000) + 'end';
            expect(await scalar(`SELECT haybarn_platform_vgi_exchange('${ECHO_WORKER}', '${long}')`)).toEqual(
                `echo:${long}`,
            );
        });

        it('exchanges from DuckDB worker threads at once, every answer intact', async () => {
            // Requests of 1 to ~300 bytes (longer than the 256-byte ring), from 4 threads at once, in several rounds:
            // a reader that takes the writer's close for the end of the data before draining the ring truncates one
            const exchanges = Number(new URLSearchParams(location.search).get('exchanges') || 0) || 4000;
            const rounds = 5;
            await conn.query('CREATE TABLE numbers AS SELECT range AS i FROM range(800000)');
            const step = Math.floor(800000 / (exchanges / rounds));
            for (let round = 0; round < rounds; round++) {
                const request = `repeat(i::VARCHAR || '-', 1 + ((i // ${step} + ${round}) % 50))`;
                const wrong = await conn.query(`SELECT * FROM (
                        SELECT i, haybarn_platform_vgi_exchange('${ECHO_WORKER}', ${request}) AS answer,
                            'echo:' || ${request} AS expected
                        FROM numbers WHERE i % ${step} = 0
                    ) WHERE answer IS DISTINCT FROM expected`);
                expect(wrong.numRows).withContext(`round ${round}`).toEqual(0);
                expect(wrong.toArray().slice(0, 3).map(r => `${r.i}: ${r.answer} != ${r.expected}`)).toEqual([]);
            }
            await conn.query('DROP TABLE numbers');
        });

        it('reports a terminal transport error of the worker', async () => {
            await expectAsync(
                conn.query(`SELECT haybarn_platform_vgi_exchange('${ECHO_WORKER}', 'fail')`),
            ).toBeRejectedWithError(/terminal transport error 7\/9/);
            expect(await scalar(`SELECT haybarn_platform_vgi_exchange('${ECHO_WORKER}', 'after')`)).toEqual(
                'echo:after',
            );
        });

        it('interrupts a read the worker never answers', async () => {
            const handle = await db.getInterruptHandle(id());
            let interruptedAt = 0;
            const query = conn.query(`SELECT haybarn_platform_vgi_exchange('${ECHO_WORKER}', 'hang')`).then(
                () => null,
                e => [e, performance.now() - interruptedAt] as const,
            );
            await sleep(500);
            interruptedAt = performance.now();
            duckdb.interruptConnection(handle!);
            const outcome = await query;
            expect(outcome).not.toBeNull();
            expect(String(outcome![0])).toMatch(INTERRUPTED);
            expect(outcome![1]).toBeLessThan(2000);
            expect(await scalar(`SELECT haybarn_platform_vgi_exchange('${ECHO_WORKER}', 'again')`)).toEqual(
                'echo:again',
            );
        });

        it('refuses a worker script of another origin', async () => {
            await expectAsync(
                conn.query("SELECT haybarn_platform_vgi_exchange('https://example.com/vgi.js', 'hello')"),
            ).toBeRejectedWithError(/vgi_wasm_ensure_worker failed/);
        });
    });
}

describe('Platform functions without the page bridges (threads)', () => {
    it('report that OAuth is not available', async () => {
        const worker = new Worker(BUNDLES.threads.mainWorker!);
        const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
        await db.instantiate(BUNDLES.threads.mainModule, BUNDLES.threads.pthreadWorker);
        await db.open({
            extensionRepository: new URL('/extensions', location.href).href,
            allowUnsignedExtensions: true,
        });
        const conn = await db.connect();
        await conn.query('INSTALL haybarn_platform_test');
        await conn.query('LOAD haybarn_platform_test');
        const result = await conn.query("SELECT haybarn_platform_open_auth('https://idp.example.com/a', 1000)");
        expect(result.getChildAt(0)!.get(0)).toMatch(/^error: OAuth is not available/);
        await conn.close();
        await db.terminate();
    });
});
