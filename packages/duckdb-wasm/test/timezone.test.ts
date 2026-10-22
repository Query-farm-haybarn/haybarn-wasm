import * as duckdb from '../src/';
import * as arrow from 'apache-arrow';

// TIMESTAMP WITH TIME ZONE columns carry the session TimeZone in their Arrow type, as the engine's own Arrow export
// does, instead of always UTC (upstream duckdb-wasm#2251). The instant itself never changes.
const QUERY = "SELECT TIMESTAMPTZ '2026-05-22 11:46:26+00' AS t";

// The TimeZone setting comes with icu, which the static bundles do not link (loadable ones autoload it)
const NO_ICU = /TimeZone.*icu extension/;

function timezoneOf(schema: arrow.Schema): string | null | undefined {
    const type = schema.fields[0].type;
    expect(arrow.DataType.isTimestamp(type)).toBeTrue();
    return (type as arrow.Timestamp).timezone;
}

export function testTimeZone(db: () => duckdb.DuckDBBindings): void {
    let conn: duckdb.DuckDBConnection;
    beforeEach(() => {
        conn = db().connect();
    });
    afterEach(() => {
        conn.close();
    });

    describe('TimeZone', () => {
        it('TIMESTAMPTZ uses the session time zone', () => {
            try {
                conn.query("SET TimeZone='UTC'");
            } catch (e: any) {
                if (NO_ICU.test(String(e))) return pending('no icu in this bundle');
                throw e;
            }
            const utc = conn.query(QUERY);
            expect(timezoneOf(utc.schema)).toEqual('UTC');

            conn.query("SET TimeZone='America/New_York'");
            const ny = conn.query(QUERY);
            expect(timezoneOf(ny.schema)).toEqual('America/New_York');
            expect(ny.getChildAt(0)?.get(0)).toEqual(utc.getChildAt(0)?.get(0));
        });
    });
}

export function testTimeZoneAsync(db: () => duckdb.AsyncDuckDB): void {
    let conn: duckdb.AsyncDuckDBConnection;
    beforeEach(async () => {
        conn = await db().connect();
    });
    afterEach(async () => {
        await conn.close();
    });

    const setTimeZone = async (zone: string) => {
        try {
            await conn.query(`SET TimeZone='${zone}'`);
            return true;
        } catch (e: any) {
            if (NO_ICU.test(String(e))) return false;
            throw e;
        }
    };

    describe('TimeZone Async', () => {
        it('TIMESTAMPTZ uses the session time zone', async () => {
            if (!(await setTimeZone('Asia/Tokyo'))) return pending('no icu in this bundle');
            const table = await conn.query(QUERY);
            expect(timezoneOf(table.schema)).toEqual('Asia/Tokyo');
        });

        it('streamed TIMESTAMPTZ uses the session time zone', async () => {
            if (!(await setTimeZone('Europe/Berlin'))) return pending('no icu in this bundle');
            const reader = await conn.send(QUERY);
            const batches = [];
            for await (const batch of reader) {
                batches.push(batch);
            }
            expect(batches.length).toBeGreaterThan(0);
            expect(timezoneOf(batches[0].schema)).toEqual('Europe/Berlin');
        });
    });
}
