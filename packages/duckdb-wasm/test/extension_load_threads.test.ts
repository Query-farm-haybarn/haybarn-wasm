import * as duckdb from '../src/';

// No such extension: each LOAD fails after it has gone single-threaded
const MISSING = 'LOAD haybarn_no_such_extension';

export function testExtensionLoadThreadsAsync(db: () => duckdb.AsyncDuckDB): void {
    let conn: duckdb.AsyncDuckDBConnection;
    let initialThreads = 1;

    const threads = async () =>
        Number((await conn.query("SELECT current_setting('threads') AS t")).getChildAt(0)!.get(0));

    describe('Single-threaded extension loads', () => {
        beforeEach(async () => {
            conn = await db().connect();
            initialThreads = await threads();
        });
        afterEach(async () => {
            await conn.query(`SET threads=${initialThreads}`);
            await conn.close();
        });

        /** Only threaded builds go single-threaded for a LOAD */
        const multiThreaded = async () => {
            try {
                await conn.query('SET threads=4');
                return true;
            } catch (e) {
                return false;
            }
        };

        it('restores the thread count after consecutive loads', async () => {
            if (!(await multiThreaded())) {
                pending('single-threaded build');
                return;
            }
            await expectAsync(conn.query(MISSING)).toBeRejected();
            await expectAsync(conn.query(MISSING)).toBeRejected();
            expect(await threads()).toEqual(4);
        });

        it('restores the thread count outside an aborted transaction', async () => {
            if (!(await multiThreaded())) {
                pending('single-threaded build');
                return;
            }
            await conn.query('BEGIN');
            // Goes single-threaded, then fails and aborts the transaction
            await expectAsync(conn.query(MISSING)).toBeRejected();
            // Restoring the thread count runs before this, and must not fail it
            await conn.query('ROLLBACK');
            expect(await threads()).toEqual(4);
        });
    });
}
