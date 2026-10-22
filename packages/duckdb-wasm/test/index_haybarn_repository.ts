import * as duckdb from '../src/';

// Haybarn: the loadable bundles against the published Haybarn extension repository
// (haybarn-extensions.query.farm/core/v2.0.0/<platform>/), with signature checks on. Unlike the other suites
// this one uses no local repository and does not allow unsigned extensions, so it proves the bundle's default
// repository, the https upgrade of its http:// URL, and the engine's Haybarn trust root against what CI publishes.
for (const variant of ['base', 'threads']) {
    const platform = variant === 'threads' ? 'wasm_threads' : 'wasm_eh';
    describe(`Haybarn extension repository (${variant})`, () => {
        it('autoloads and installs signed core extensions', async () => {
            const worker = new Worker(`/static/duckdb-browser-${variant}.worker.js`);
            const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
            let stage = 'instantiate';
            let timer: ReturnType<typeof setTimeout>;
            const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    worker.terminate();
                    reject(new Error(`Haybarn repository ${variant} timed out during ${stage}`));
                }, 150000);
            });
            const run = async () => {
                await db.instantiate(
                    `/static/duckdb-${variant}.wasm`,
                    variant === 'threads' ? '/static/duckdb-browser-threads.pthread.worker.js' : undefined,
                );
                await db.open({ allowUnsignedExtensions: false });
                const conn = await db.connect();
                const query = async (sql: string) => {
                    stage = sql;
                    return conn.query(sql);
                };
                const scalar = async (sql: string) => (await query(sql)).getChildAt(0)!.get(0);

                expect(await scalar('SELECT version()')).toEqual('v2.0.0');
                expect(await scalar("SELECT current_setting('allow_unsigned_extensions')")).toEqual(false);

                // parquet is not linked into the loadable bundles, reading a file autoloads it
                const parquet = `${location.origin}/data/uni/studenten.parquet`;
                expect(Number(await scalar(`SELECT count(*) FROM '${parquet}'`))).toEqual(8);

                await query('INSTALL httpfs');
                await query('LOAD httpfs');
                await query('INSTALL inet');
                await query('LOAD inet');
                expect(String(await scalar("SELECT host('192.168.1.5/24'::INET)"))).toEqual('192.168.1.5');

                const loaded = await query(
                    `SELECT extension_name, install_mode, extension_version FROM duckdb_extensions()
                     WHERE loaded AND extension_name IN ('httpfs', 'inet', 'parquet') ORDER BY extension_name`,
                );
                expect(loaded.numRows).toEqual(3);
                for (const row of loaded.toArray()) {
                    expect(String(row.install_mode)).toEqual('REPOSITORY');
                    expect(String(row.extension_version)).not.toEqual('');
                }
                // The repository URL the bundle resolves, from the error for an extension that does not exist
                await expectAsync(query('LOAD haybarn_no_such_extension')).toBeRejectedWithError(
                    new RegExp(
                        `https://haybarn-extensions\\.query\\.farm/core/v2\\.0\\.0/${platform}/haybarn_no_such_extension\\.duckdb_extension\\.wasm`,
                    ),
                );

                // httpfs reads over the browser's HTTP client once loaded
                expect(Number(await scalar(`SELECT count(*) FROM '${parquet}'`))).toEqual(8);
                await conn.close();
            };
            try {
                await Promise.race([run(), deadline]);
            } finally {
                clearTimeout(timer!);
                await db.terminate();
            }
        }, 160000);
    });
}

// Haybarn: the browser HTTP client that httpfs uses in wasm, with the signed httpfs from the repository. The karma
// fixture (karma/haybarn-repository-chrome.cjs) logs every request's headers and fails a GET whose If-Match is not the
// file's strong ETag, as a server that pins a range read's bytes does.
interface FixtureRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
    status: number;
}
const FIXTURE_CSV = `${location.origin}/haybarn-fixture/etag.csv`;
// encodeURI() would turn this into a%20b,%22c%22
const RAW_HEADER_VALUE = 'a b,"c"';

async function fixtureLog(): Promise<FixtureRequest[]> {
    return (await (await fetch('/haybarn-fixture/log')).json()) as FixtureRequest[];
}

async function withHttpfs(
    variant: string,
    worker: Worker,
    body: (query: (sql: string) => Promise<any>, scalar: (sql: string) => Promise<any>) => Promise<void>,
): Promise<void> {
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
    let stage = 'instantiate';
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            worker.terminate();
            reject(new Error(`HTTP client ${variant} timed out during ${stage}`));
        }, 150000);
    });
    const run = async () => {
        await db.instantiate(
            new URL(`/static/duckdb-${variant}.wasm`, location.href).href,
            variant === 'threads'
                ? new URL('/static/duckdb-browser-threads.pthread.worker.js', location.href).href
                : undefined,
        );
        await db.open({ allowUnsignedExtensions: false });
        const conn = await db.connect();
        const query = async (sql: string) => {
            stage = sql;
            return conn.query(sql);
        };
        const scalar = async (sql: string) => (await query(sql)).getChildAt(0)!.get(0);
        await query('INSTALL httpfs');
        await query('LOAD httpfs');
        await query('SET enable_external_file_cache=false');
        await body(query, scalar);
        await conn.close();
    };
    try {
        await Promise.race([run(), deadline]);
    } finally {
        clearTimeout(timer!);
        await db.terminate();
    }
}

function expectFixtureHeaders(log: FixtureRequest[]) {
    const requests = log.filter(r => r.path === '/haybarn-fixture/etag.csv');
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
        expect(request.status).not.toEqual(412);
        expect(request.headers['x-haybarn-raw']).toEqual(RAW_HEADER_VALUE);
    }
    // httpfs pins its reads to the strong ETag, which reaches the server as sent
    const conditional = requests.filter(r => r.method === 'GET' && r.headers['if-match'] !== undefined);
    expect(conditional.length).toBeGreaterThan(0);
    for (const request of conditional) {
        expect(request.headers['if-match']).toEqual('"abc-10"');
    }
}

for (const variant of ['base', 'threads']) {
    describe(`Haybarn HTTP client (${variant})`, () => {
        it('sends header values as they are, so ETag preconditions match', async () => {
            await fetch('/haybarn-fixture/reset');
            await withHttpfs(
                variant,
                new Worker(`/static/duckdb-browser-${variant}.worker.js`),
                async (query, scalar) => {
                    await query(`CREATE SECRET fixture_headers (
                        TYPE HTTP, SCOPE '${location.origin}/haybarn-fixture/',
                        EXTRA_HTTP_HEADERS MAP {'X-Haybarn-Raw': '${RAW_HEADER_VALUE.replace(/'/g, "''")}'}
                    )`);
                    expect(Number(await scalar(`SELECT count(*) FROM read_csv('${FIXTURE_CSV}')`))).toEqual(3);
                },
            );
            expectFixtureHeaders(await fixtureLog());
        }, 160000);
    });
}

describe('Haybarn HTTP client (base)', () => {
    it('does not log request headers', async () => {
        // A worker whose console is forwarded to this page, so whatever the HTTP client logs can be inspected
        const channel = new BroadcastChannel(`haybarn-console-${Math.random()}`);
        const messages: string[] = [];
        channel.onmessage = event => messages.push(String(event.data));
        const workerURL = new URL('/static/duckdb-browser-base.worker.js', location.href).href;
        const wrapper = `
            const channel = new BroadcastChannel(${JSON.stringify(channel.name)});
            for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
                const original = console[level].bind(console);
                console[level] = (...args) => {
                    try { channel.postMessage(args.map(arg => String(arg)).join(' ')); } catch (e) {}
                    original(...args);
                };
            }
            importScripts(${JSON.stringify(workerURL)});
            console.log('haybarn-console-ready');
        `;
        const worker = new Worker(URL.createObjectURL(new Blob([wrapper], { type: 'text/javascript' })));
        const token = 'haybarn-secret-token-1f2e3d';
        try {
            await withHttpfs('base', worker, async (query, scalar) => {
                await query(`CREATE SECRET fixture_auth (
                    TYPE HTTP, SCOPE '${location.origin}/haybarn-fixture/',
                    EXTRA_HTTP_HEADERS MAP {'Authorization': 'Bearer ${token}', 'X-Haybarn-Raw': '${RAW_HEADER_VALUE.replace(/'/g, "''")}'}
                )`);
                expect(Number(await scalar(`SELECT count(*) FROM read_csv('${FIXTURE_CSV}')`))).toEqual(3);
            });
            // let the last forwarded messages arrive
            await new Promise(resolve => setTimeout(resolve, 200));
        } finally {
            channel.close();
        }
        expect(messages).toContain('haybarn-console-ready');
        const leaked = messages.filter(m => m.includes(token) || m.includes(RAW_HEADER_VALUE));
        expect(leaked).toEqual([]);
        // the header did reach the server
        const requests = (await fixtureLog()).filter(r => r.headers['authorization'] === `Bearer ${token}`);
        expect(requests.length).toBeGreaterThan(0);
    }, 160000);

});

describe('Haybarn HTTP client (threads)', () => {
    // The threads bundle's shared memory is reserved up front and grows in place; the base bundle's
    // has to be reallocated to grow, which Chrome refuses at this size
    it('reads and sends correctly with more than 2 GiB of heap', async () => {
        await fetch('/haybarn-fixture/reset');
        await withHttpfs('threads', new Worker('/static/duckdb-browser-threads.worker.js'), async (query, scalar) => {
            // No spilling: in a browser temp files live in JS memory
            await query("SET memory_limit='3.8GB'");
            await query("SET temp_directory=''");
            // Keep more than 2 GiB alive, so the request's header table and the response buffers land above
            // 2 GiB, where a signed pointer reads and writes the wrong memory. Small strings keep every
            // intermediate chunk small.
            await query(
                'CREATE TABLE ballast AS SELECT repeat(chr(65 + (i % 26)::INT), 32768) || i::VARCHAR AS s ' +
                    'FROM range(70000) t(i)',
            );
            expect(Number(await scalar('SELECT sum(memory_usage_bytes) FROM duckdb_memory()'))).toBeGreaterThan(2 ** 31);
            await query(`CREATE SECRET fixture_headers (
                TYPE HTTP, SCOPE '${location.origin}/haybarn-fixture/',
                EXTRA_HTTP_HEADERS MAP {'X-Haybarn-Raw': '${RAW_HEADER_VALUE.replace(/'/g, "''")}'}
            )`);
            for (let i = 0; i < 5; i++) {
                expect(await scalar(`SELECT string_agg(name, ',' ORDER BY id) FROM read_csv('${FIXTURE_CSV}')`)).toEqual(
                    'duck,goose,swan',
                );
            }
        });
        expectFixtureHeaders(await fixtureLog());
    }, 160000);
});
