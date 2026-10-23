import * as duckdb from '../src/';

// Haybarn: extension prefetch on both bundles (karma/prefetch-chrome.cjs, a cross-origin isolated page), with
// signature checks on. The local extensions of this build are served signed with a throwaway key the karma server
// makes at startup, trusted through CREATE EXTENSION REPOSITORY, and the server counts the downloads: a LOAD that took
// a prefetched extension downloads nothing. The last spec prefetches from the published Haybarn repository.

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

/** Local extensions of the build, as named in the repository */
const LOCAL = ['json', 'parquet', 'icu', 'tpch', 'autocomplete'];
/** Published core extensions, with a query that needs each */
const PUBLISHED: Record<string, string> = {
    parquet: "SELECT count(*) FROM parquet_metadata('/no-such-file.parquet')",
    icu: "SELECT strftime(TIMESTAMPTZ '2020-01-01 00:00:00+00', '%Y')",
    json: `SELECT json_valid('{"a": 1}')`,
    inet: "SELECT host(INET '192.168.1.5/24')",
    excel: "SELECT excel_text(1234.5, '#,##0.00')",
};
const UNSIGNED = /signature is either missing or invalid/i;

const log = async (): Promise<Record<string, number>> => (await fetch('/haybarn-ext/log')).json();

for (const variant of ['base', 'threads']) {
    const platform = variant === 'threads' ? 'wasm_threads' : 'wasm_eh';
    const file = (mode: string, name: string) => `/haybarn-ext/${mode}/v2.0.0/${platform}/${name}.duckdb_extension.wasm`;

    describe(`Extension prefetch (${variant})`, () => {
        let worker: Worker;
        let db: duckdb.AsyncDuckDB;
        let conn: duckdb.AsyncDuckDBConnection;
        let key: string;
        const run = (query: string) => conn.query(query);
        const scalar = async (query: string) => (await conn.query(query)).getChildAt(0)!.get(0);

        /**
         * A fresh database, signatures on, that trusts the throwaway key for the three test repositories. They are
         * stored in the home directory, which outlives the database, so the first call creates them.
         */
        const reopen = async () => {
            await conn?.close();
            // The trusted repositories are files under the home directory, by default opfs://home on a page, where a
            // file is only readable once prepared: the tests keep them in memory
            await db.open({ allowUnsignedExtensions: false, homeDirectory: '/haybarn-prefetch-home' });
            conn = await db.connect();
            await run("SET allow_extension_repositories = 'allowed'");
            for (const mode of ['signed', 'tampered', 'stall']) {
                const prefix = new URL(`/haybarn-ext/${mode}`, location.href).href;
                await run(`CREATE EXTENSION REPOSITORY IF NOT EXISTS hb_${mode} WITH PREFIX '${prefix}' USING PUBLIC KEY '${key}'`);
            }
        };

        beforeAll(async () => {
            key = await (await fetch('/haybarn-ext/key')).text();
            worker = new Worker(BUNDLES[variant].mainWorker!);
            db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
            await db.instantiate(BUNDLES[variant].mainModule, BUNDLES[variant].pthreadWorker);
        });
        afterAll(async () => {
            await conn?.close();
            await db.terminate();
        });
        beforeEach(async () => {
            await fetch('/haybarn-ext/reset');
            await reopen();
        });

        it('loads prefetched extensions without downloading them again', async () => {
            for (const name of LOCAL) await run(`INSTALL ${name} FROM hb_signed`);
            const held = await db.prefetchExtensions(LOCAL);
            expect([...held].sort()).toEqual([...LOCAL].sort());
            const downloads = await log();
            for (const name of LOCAL) expect(downloads[file('signed', name)]).toEqual(1);

            for (const name of LOCAL) await run(`LOAD ${name} FROM hb_signed`);
            expect(await log()).toEqual(downloads);
            const loaded = await scalar(
                `SELECT count(*)::INTEGER FROM duckdb_extensions() WHERE loaded AND extension_name IN (${LOCAL.map(n => `'${n}'`).join(', ')})`,
            );
            expect(loaded).toEqual(LOCAL.length);
            expect(await scalar(`SELECT json_valid('{"a": 1}')`)).toBeTrue();
            expect(await scalar('SELECT count(*)::INTEGER FROM tpch_queries()')).toEqual(22);
            // Loaded now, so there is nothing left to prefetch
            expect(await db.prefetchExtensions(LOCAL)).toEqual([]);
        });

        it('loads without a prefetch, hashing the file in the engine', async () => {
            await run('INSTALL json FROM hb_signed');
            await run('LOAD json FROM hb_signed');
            expect(await scalar(`SELECT json_valid('{"a": 1}')`)).toBeTrue();
            expect((await log())[file('signed', 'json')]).toEqual(1);
        });

        it('refuses a tampered extension, prefetched or not', async () => {
            await run('INSTALL json FROM hb_tampered');
            expect(await db.prefetchExtensions(['json'])).toEqual(['json']);
            await expectAsync(run('LOAD json FROM hb_tampered')).toBeRejectedWithError(UNSIGNED);
            // The LOAD took the prefetched file and rejected it, it did not download it again
            expect((await log())[file('tampered', 'json')]).toEqual(1);
            await expectAsync(run('LOAD tpch FROM hb_tampered')).toBeRejectedWithError(UNSIGNED);
            expect((await log())[file('tampered', 'tpch')]).toEqual(1);
            // The module compiled from the tampered bytes is gone: the genuine extension loads and works
            await run('INSTALL json FROM hb_signed');
            await run('LOAD json FROM hb_signed');
            expect(await scalar(`SELECT json_valid('{"a": 1}')`)).toBeTrue();
        });

        it('drops prefetched extensions that no LOAD took when the database is reset', async () => {
            await run('INSTALL json FROM hb_signed');
            expect(await db.prefetchExtensions(['json'])).toEqual(['json']);
            await conn.close();
            conn = null as any;
            await db.reset();
            await reopen();
            await run('INSTALL json FROM hb_signed');
            await run('LOAD json FROM hb_signed');
            expect((await log())[file('signed', 'json')]).toEqual(2);
        });

        it('leaves a stalled download to LOAD after the timeout', async () => {
            await run('INSTALL json FROM hb_stall');
            const started = performance.now();
            expect(await db.prefetchExtensions(['json'], 1000)).toEqual([]);
            expect(performance.now() - started).toBeLessThan(10000);
            await run('LOAD json FROM hb_stall');
            expect(await scalar(`SELECT json_valid('{"a": 1}')`)).toBeTrue();
            expect((await log())[file('stall', 'json')]).toEqual(2);
        });

        it('skips names it cannot prefetch', async () => {
            await run('INSTALL json FROM hb_signed');
            expect(await db.prefetchExtensions(['json', 'haybarn_no_such_extension'])).toEqual(['json']);
            await run('LOAD json FROM hb_signed');
        });

        it('prefetches signed extensions from the Haybarn repository', async () => {
            await conn.close();
            await db.open({ allowUnsignedExtensions: false });
            conn = await db.connect();
            const names = Object.keys(PUBLISHED);
            const held = await db.prefetchExtensions(names);
            expect([...held].sort()).toEqual([...names].sort());
            for (const name of names) await run(`LOAD ${name}`);
            for (const name of names) {
                if (name === 'parquet') {
                    await expectAsync(run(PUBLISHED[name])).toBeRejectedWithError(/no-such-file/);
                } else {
                    expect(await scalar(PUBLISHED[name])).toBeTruthy();
                }
            }
        });
    });
}
