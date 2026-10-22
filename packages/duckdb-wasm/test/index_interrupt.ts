import * as duckdb from '../src/';

// Haybarn: interrupting queries and reading their progress, on both bundles (karma/interrupt-chrome.cjs, a cross-origin
// isolated page). On the threads bundle the worker is inside the call that runs a query until it returns, so only
// shared memory reaches a running query: getInterruptHandle, and cancelPendingQuery, which goes through it.

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

/** A query that runs for minutes */
const ENDLESS = 'SELECT sum(i) FROM range(1000000000000) t(i)';
/** The interrupt error of the engine */
const INTERRUPTED = /INTERRUPT/i;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Settle a promise into [result, error, milliseconds after `since`] */
async function settle<T>(promise: Promise<T>, since: () => number): Promise<[T | null, any, number]> {
    try {
        const result = await promise;
        return [result, null, performance.now() - since()];
    } catch (e) {
        return [null, e, performance.now() - since()];
    }
}

/** Run a pending query to its end, as AsyncDuckDBConnection.send does, without fetching the result */
async function runPending(db: duckdb.AsyncDuckDB, conn: number, text: string): Promise<Uint8Array> {
    let header = await db.startPendingQuery(conn, text);
    while (header === null) {
        header = await db.pollPendingQuery(conn);
    }
    return header;
}

for (const variant of ['base', 'threads']) {
    const threads = variant === 'threads';
    describe(`Query interrupt and progress (${variant})`, () => {
        let worker: Worker;
        let db: duckdb.AsyncDuckDB;
        let conn: duckdb.AsyncDuckDBConnection;
        const id = () => conn.useUnsafe((_, c) => c);

        beforeAll(async () => {
            worker = new Worker(BUNDLES[variant].mainWorker!);
            db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
            await db.instantiate(BUNDLES[variant].mainModule, BUNDLES[variant].pthreadWorker);
            await db.open({});
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

        it('hands out the interrupt flag and the progress slot only in shared memory', async () => {
            const interrupt = await db.getInterruptHandle(id());
            const progress = await db.getProgressHandle(id());
            if (threads) {
                expect(interrupt!.memory instanceof SharedArrayBuffer).toBeTrue();
                expect(progress!.memory instanceof SharedArrayBuffer).toBeTrue();
                expect(progress!.offset % 8).toEqual(0);
                expect(new Uint8Array(interrupt!.memory, interrupt!.offset, 1)[0]).toEqual(0);
            } else {
                expect(interrupt).toBeNull();
                expect(progress).toBeNull();
            }
            // Between polls the worker answers on every bundle
            const snapshot = await db.getQueryProgress(id());
            expect(snapshot).not.toBeNull();
            expect(snapshot!.running).toBeFalse();
        });

        if (threads) {
            it('interrupts a blocking runQuery from the page', async () => {
                const handle = await db.getInterruptHandle(id());
                let interruptedAt = 0;
                const query = settle(conn.query(ENDLESS), () => interruptedAt);
                await sleep(500);
                interruptedAt = performance.now();
                duckdb.interruptConnection(handle!);
                const [result, error, ms] = await query;
                expect(result).toBeNull();
                expect(String(error)).toMatch(INTERRUPTED);
                expect(ms).toBeLessThan(1500);
                // The flag was cleared and the connection works
                expect(new Uint8Array(handle!.memory, handle!.offset, 1)[0]).toEqual(0);
                expect(Number((await conn.query('SELECT 42 AS a')).getChildAt(0)!.get(0))).toEqual(42);
            });

            it('interrupts a query waiting for tasks on DuckDB threads', async () => {
                // With 4 threads the calling thread runs out of tasks and waits for the scheduler threads
                // (QueryResult::CompleteInternal's bounded wait, wait_for_tasks_instead_of_spinning.patch): an
                // interrupt must still end the query promptly, for runQuery and for a pending query
                for (const pending of [false, true]) {
                    const handle = await db.getInterruptHandle(id());
                    let interruptedAt = 0;
                    const sql = 'SELECT count(DISTINCT i % 1000003) FROM range(10000000000) t(i)';
                    const run: Promise<unknown> = pending ? runPending(db, id(), sql) : conn.query(sql);
                    const query = settle(run, () => interruptedAt);
                    await sleep(700);
                    interruptedAt = performance.now();
                    if (pending) {
                        expect(await conn.cancelSent()).toBeTrue();
                    } else {
                        duckdb.interruptConnection(handle!);
                    }
                    const [result, error, ms] = await query;
                    expect(result).toBeNull();
                    expect(String(error)).toMatch(/INTERRUPT|canceled/i);
                    expect(ms).toBeLessThan(1500);
                    expect(Number((await conn.query('SELECT 42 AS a')).getChildAt(0)!.get(0))).toEqual(42);
                }
            });

            it('leaves a statement that suppresses interrupts alone', async () => {
                const handle = await db.getInterruptHandle(id());
                const flag = new Uint8Array(handle!.memory, handle!.offset, 1);
                // INTERRUPTS_SUPPRESSED, as after a COMMIT; set between statements, the next one resets it
                Atomics.store(flag, 0, 2);
                duckdb.interruptConnection(handle!);
                expect(Atomics.load(flag, 0)).toEqual(2);
                expect(Number((await conn.query('SELECT 1 AS a')).getChildAt(0)!.get(0))).toEqual(1);
                expect(Atomics.load(flag, 0)).toEqual(0);
            });
        }

        it('cancelSent interrupts the poll that runs and invalidates the transaction', async () => {
            // One poll runs the query for 2 s on the calling thread (one DuckDB thread: no other thread runs its
            // tasks, so the poll does not return early); the cancel must not wait for it
            await db.open({ query: { queryPollingInterval: 2000 } });
            conn = await db.connect();
            await conn.query('SET threads = 1');
            await conn.query('BEGIN');
            await conn.query('CREATE TABLE t (i BIGINT)');
            let cancelledAt = 0;
            const insert = settle(
                runPending(db, id(), 'INSERT INTO t SELECT i FROM range(100000000000) tbl(i)'),
                () => cancelledAt,
            );
            await sleep(500);
            cancelledAt = performance.now();
            expect(await conn.cancelSent()).toBeTrue();
            const [result, error, ms] = await insert;
            expect(result).toBeNull();
            if (threads) {
                // The running poll was interrupted
                expect(String(error)).toMatch(INTERRUPTED);
                expect(ms).toBeLessThan(1500);
            } else {
                // The cancel was read after the poll
                expect(String(error)).toMatch(/canceled/);
            }
            // A half-run INSERT must not be committable, as with a native interrupt
            await expectAsync(conn.query('SELECT count(*) FROM t')).toBeRejectedWithError(/aborted/i);
            await conn.query('ROLLBACK');
            await expectAsync(conn.query('SELECT count(*) FROM t')).toBeRejectedWithError(/does not exist/i);
            expect(Number((await conn.query('SELECT 42 AS a')).getChildAt(0)!.get(0))).toEqual(42);
            await db.open({});
        });

        it('cancels the pending query through registerCancelSAB', async () => {
            await db.open({ query: { queryPollingInterval: 2000 } });
            conn = await db.connect();
            if (threads) await conn.query('SET threads = 4');
            const sab = new SharedArrayBuffer(4);
            db.registerCancelSAB(sab);
            let cancelledAt = 0;
            const query = settle(runPending(db, id(), ENDLESS), () => cancelledAt);
            await sleep(500);
            cancelledAt = performance.now();
            Atomics.store(new Int32Array(sab), 0, 1);
            const [result, error, ms] = await query;
            expect(result).toBeNull();
            expect(String(error)).toMatch(/INTERRUPT|canceled/i);
            // Threads: within the watcher interval plus the engine's next check. Base: the poll ends first
            expect(ms).toBeLessThan(threads ? 1500 : 4000);
            expect(Atomics.load(new Int32Array(sab), 0)).toEqual(0);
            expect(Number((await conn.query('SELECT 42 AS a')).getChildAt(0)!.get(0))).toEqual(42);
            await db.open({});
        });

        it('reports the progress of a running query', async () => {
            await conn.query('SET enable_progress_bar = true');
            await conn.query('CREATE OR REPLACE TABLE p AS SELECT i FROM range(20000000) t(i)');
            const pushed: number[] = [];
            (db as any)._onExecutionProgress.push((p: duckdb.ProgressEntry) => pushed.push(Number(p.percentage)));
            const query = 'SELECT count(*) FROM p a, range(20) r WHERE (a.i + r.range) % 1000003 = 0';
            if (threads) {
                const handle = await db.getProgressHandle(id());
                const seen: duckdb.QueryProgress[] = [];
                const run = conn.query(query);
                let done = false;
                run.finally(() => (done = true)).catch(() => {});
                while (!done) {
                    const snapshot = duckdb.readQueryProgress(handle!);
                    if (snapshot && snapshot.running) seen.push(snapshot);
                    await sleep(20);
                }
                const table = await run;
                expect(Number(table.getChildAt(0)!.get(0))).toBeGreaterThan(0);
                // Read while the worker was busy inside runQuery
                const percentages = seen.map(s => s.percentage).filter(p => p >= 0);
                expect(new Set(percentages).size).toBeGreaterThan(1);
                for (let i = 1; i < percentages.length; ++i) {
                    expect(percentages[i]).toBeGreaterThanOrEqual(percentages[i - 1]);
                }
                const final = duckdb.readQueryProgress(handle!)!;
                expect(final.running).toBeFalse();
                expect(final.percentage).toBeGreaterThan(percentages[0]);
            } else {
                await conn.query(query);
            }
            // The progress updates the worker posts, also from the query pthread of the threads bundle
            expect(pushed.length).toBeGreaterThan(0);
            const after = await db.getQueryProgress(id());
            expect(after!.running).toBeFalse();
            expect(after!.percentage).toBeGreaterThan(0);
            (db as any)._onExecutionProgress = [];
        });
    });
}
