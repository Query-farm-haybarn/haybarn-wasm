/**
 * Haybarn: extension loading and the pthread pool on the threads bundle, against the published Haybarn extension
 * repository (haybarn-extensions.query.farm/core/v2.0.0/wasm_threads/) with signature checks on. Run with
 * karma/threads-pool-chrome.cjs (cross-origin isolated, needs network access).
 *
 * - Repeated fresh instances, each loading remote extensions with the scheduler's workers live: explicit
 *   INSTALL/LOAD with the bindings' `SET threads=1` bracket switched off, and autoloads inside queries, which no
 *   bracket can cover.
 * - Pool exhaustion: a statement that needs more threads than the pool holds does not hang (pthread_create fails
 *   with EAGAIN beyond the pool and the scheduler keeps the threads it got), and the database keeps working.
 * - A parallel query that fails on a scheduler thread while the others call into the main thread settles.
 *
 * Every step has a deadline, so a hang fails with the iteration and the statement it hung in.
 */
import * as duckdb from '../src/';

const BUNDLE: duckdb.DuckDBBundle = {
    mainModule: '/static/duckdb-threads.wasm',
    mainWorker: '/static/duckdb-browser-threads.worker.js',
    pthreadWorker: '/static/duckdb-browser-threads.pthread.worker.js',
};

const args: string[] = (globalThis as any).__karma__?.config?.args ?? [];
const arg = (name: string, fallback: string) => {
    const hit = args.find(a => a.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1) : fallback;
};
/** POOL_ITERATIONS: fresh instances in the load stress test */
const ITERATIONS = Number(arg('iterations', '20'));
/** POOL_BRACKET=1: keep the bindings' SET threads=1 bracket around explicit loads (it is off by default here) */
const BRACKET = arg('bracket', '0') === '1';
/** Deadline of one statement */
const STEP_TIMEOUT = 60000;

const log = (m: string) => console.log(`[threads-pool] ${m}`);

class Hang extends Error {}

async function deadline<T>(what: string, run: Promise<T>, ms = STEP_TIMEOUT): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Hang(`hung for ${ms}ms in: ${what}`)), ms);
    });
    try {
        return await Promise.race([run, timeout]);
    } finally {
        clearTimeout(timer!);
    }
}

async function openInstance(config: duckdb.DuckDBConfig) {
    const worker = new Worker(BUNDLE.mainWorker!);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    try {
        await deadline('instantiate', db.instantiate(BUNDLE.mainModule, BUNDLE.pthreadWorker));
        await deadline('open', db.open(config));
        const conn = await deadline('connect', db.connect());
        return { worker, db, conn };
    } catch (e) {
        worker.terminate();
        throw e;
    }
}

describe('Haybarn threads bundle: extension loads and the pthread pool', () => {
    it(
        `loads remote extensions with live scheduler threads, ${ITERATIONS} fresh instances`,
        async () => {
            const parquet = `${location.origin}/data/uni/studenten.parquet`;
            for (let i = 0; i < ITERATIONS; i++) {
                const t0 = performance.now();
                const { worker, db, conn } = await openInstance({
                    allowUnsignedExtensions: false,
                    singleThreadedExtensionLoad: BRACKET,
                });
                const scalar = async (sql: string) => {
                    const r = await deadline(`iteration ${i}: ${sql}`, conn.query(sql));
                    return r.getChildAt(0)?.get(0);
                };
                try {
                    expect(Number(await scalar("SELECT current_setting('threads')"))).toEqual(4);
                    // Warm the scheduler's workers, then load with them live
                    expect(Number(await scalar('SELECT count(DISTINCT i % 1000) FROM range(2000000) t(i)'))).toEqual(
                        1000,
                    );
                    // Autoloads inside queries: parquet for a file, inet for a type, both while the statement runs
                    expect(Number(await scalar(`SELECT count(*) FROM '${parquet}'`))).toEqual(8);
                    expect(String(await scalar("SELECT host('192.168.1.5/24'::INET)"))).toEqual('192.168.1.5');
                    // Explicit loads of remote extensions, not bracketed
                    await scalar('INSTALL httpfs');
                    await scalar('LOAD httpfs');
                    await scalar('INSTALL fts FROM core');
                    await scalar('LOAD fts');
                    // A parallel query between loads, then an autoload inside a parallel query (excel's text())
                    expect(Number(await scalar('SELECT sum(i) FROM range(1000000) t(i)'))).toEqual(499999500000);
                    expect(
                        Number(
                            await scalar(
                                "SELECT count(*) FROM range(200000) t(i) WHERE text(i::DOUBLE, '0.00') LIKE '%.00'",
                            ),
                        ),
                    ).toEqual(200000);
                    await scalar('LOAD tpch');
                    await scalar('CALL dbgen(sf = 0.01)');
                    expect(Number(await scalar('SELECT count(*) FROM lineitem'))).toBeGreaterThan(50000);
                    const loaded = await deadline(
                        `iteration ${i}: duckdb_extensions()`,
                        conn.query(
                            `SELECT extension_name FROM duckdb_extensions()
                         WHERE loaded AND install_mode = 'REPOSITORY' ORDER BY extension_name`,
                        ),
                    );
                    const names = loaded.toArray().map(r => String(r.extension_name));
                    expect(names).toEqual(
                        jasmine.arrayContaining(['excel', 'fts', 'httpfs', 'inet', 'parquet', 'tpch']),
                    );
                    await conn.close();
                } finally {
                    await db.terminate();
                    worker.terminate();
                }
                log(`iteration ${i} ok ${Math.round(performance.now() - t0)}ms`);
            }
        },
        ITERATIONS * 6 * STEP_TIMEOUT,
    );

    it(
        'runs a statement that needs more threads than the pool holds without hanging',
        async () => {
            const { worker, db, conn } = await openInstance({ allowUnsignedExtensions: false });
            try {
                // One call that starts more threads than the pool holds, then waits for all of them (the second SET
                // joins them). A worker added to the pool during a call only starts once the call returns, so this
                // hung for good before the pool was strict; now pthread_create fails with EAGAIN beyond the pool and
                // the scheduler runs with the threads it got
                const t0 = performance.now();
                await deadline(
                    'SET threads = 64; SET threads = 1',
                    conn.query('SET threads = 64; SET threads = 1'),
                    30000,
                );
                log(`64 threads requested and joined in ${Math.round(performance.now() - t0)}ms`);
                // The same within a load: dlopen waits for every live thread to sync the new module
                await deadline('SET threads = 64; LOAD inet', conn.query('SET threads = 64; LOAD inet'), 30000);
                expect(String((await conn.query("SELECT host('10.1.2.3/8'::INET)")).getChildAt(0)?.get(0))).toEqual(
                    '10.1.2.3',
                );
                // The database keeps working, and the scheduler can be resized again once the pool was refilled
                for (const threads of [4, 8, 2, 8]) {
                    await deadline(`SET threads = ${threads}`, conn.query(`SET threads = ${threads}`));
                    const r = await deadline(
                        `parallel query at ${threads} threads`,
                        conn.query('SELECT count(DISTINCT i % 1000) FROM range(3000000) t(i)'),
                    );
                    expect(Number(r.getChildAt(0)?.get(0))).toEqual(1000);
                }
                await deadline('LOAD after exhaustion', conn.query('LOAD fts'));
                await conn.close();
            } finally {
                await db.terminate();
                worker.terminate();
            }
        },
        10 * STEP_TIMEOUT,
    );

    it(
        'settles parallel queries that fail while scheduler threads call into the main thread',
        async () => {
            // The 2.0 counterpart of 1.5's VGI worker-error deadlock: a parallel scan whose worker threads read a
            // registered buffer through the main thread fails on one of them, and the query's cancellation must not
            // wait on a main thread that stopped serving them
            const { worker, db, conn } = await openInstance({ allowUnsignedExtensions: false });
            try {
                const rows = 1500000;
                const lines: string[] = ['a,b'];
                for (let i = 0; i < rows; i++) lines.push(`${i},${i % 97}`);
                await db.registerFileText('pool_big.csv', lines.join('\n'));
                const sql = `SELECT count(*) FROM read_csv('pool_big.csv') WHERE CASE WHEN a = 1000000 THEN error('boom') ELSE b >= 0 END`;
                for (let i = 0; i < 20; i++) {
                    await expectAsync(deadline(`failing scan ${i}`, conn.query(sql))).toBeRejectedWithError(/boom/);
                    const r = await deadline(
                        `scan after failure ${i}`,
                        conn.query(`SELECT count(*) FROM 'pool_big.csv'`),
                    );
                    expect(Number(r.getChildAt(0)?.get(0))).toEqual(rows);
                }
                // A fresh connection is not stuck behind a frozen engine
                const other = await db.connect();
                expect(Number((await deadline('SELECT 42', other.query('SELECT 42'))).getChildAt(0)?.get(0))).toEqual(
                    42,
                );
                await other.close();
                await conn.close();
            } finally {
                await db.terminate();
                worker.terminate();
            }
        },
        30 * STEP_TIMEOUT,
    );
});
