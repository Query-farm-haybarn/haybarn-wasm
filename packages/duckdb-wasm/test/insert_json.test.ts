import * as arrow from 'apache-arrow';
import * as duckdb from '../src/';
import { DuckDBDataProtocol } from '../src/';
import { Column, compareTable } from './table_test';

function describeBrowser(description: string, specDefinitions: () => void): void {
    if (typeof window !== 'undefined') {
        describe(description, specDefinitions);
    }
}

const encoder = new TextEncoder();

interface JSONInsertTest {
    name: string;
    input: string;
    options: duckdb.JSONInsertOptions;
    query: string;
    expectedColumns: Column[];
}

const JSON_INSERT_TESTS: JSONInsertTest[] = [
    {
        name: 'rows_integers',
        input: `[
            {"a":1, "b":2, "c":3},
            {"a":4, "b":5, "c":6},
            {"a":7, "b":8, "c":9},
        ]`,
        options: {
            schema: 'main',
            name: 'foo',
        },
        query: 'SELECT * FROM main.foo',
        expectedColumns: [
            { name: 'a', values: [1, 4, 7] },
            { name: 'b', values: [2, 5, 8] },
            { name: 'c', values: [3, 6, 9] },
        ],
    },
    {
        name: 'cols_integers',
        input: `{
            "a": [1, 4, 7],
            "b": [2, 5, 8],
            "c": [3, 6, 9]
        }`,
        options: {
            schema: 'main',
            name: 'foo',
        },
        query: 'SELECT * FROM main.foo',
        expectedColumns: [
            { name: 'a', values: [1, 4, 7] },
            { name: 'b', values: [2, 5, 8] },
            { name: 'c', values: [3, 6, 9] },
        ],
    },
    {
        name: 'options_1',
        input: `[
            {"a":1, "b":2, "c":3},
            {"a":4, "b":5, "c":6},
            {"a":7, "b":8, "c":9},
        ]`,
        options: {
            schema: 'main',
            name: 'foo',
            shape: duckdb.JSONTableShape.ROW_ARRAY,
            columns: {
                a: new arrow.Int16(),
                b: new arrow.Int32(),
                c: new arrow.Utf8(),
            },
        },
        query: 'SELECT * FROM main.foo',
        expectedColumns: [
            { name: 'a', values: [1, 4, 7] },
            { name: 'b', values: [2, 5, 8] },
            { name: 'c', values: ['3', '6', '9'] },
        ],
    },
    {
        name: 'cols_ragged',
        input: `{
            "a": [1, 2, 3],
            "b": ["x"],
        }`,
        options: {
            schema: 'main',
            name: 'foo',
        },
        query: 'SELECT * FROM main.foo',
        expectedColumns: [
            { name: 'a', values: [1, 2, 3] },
            { name: 'b', values: ['x', null, null] },
        ],
    },
    {
        name: 'cols_typed',
        input: `{
            "a": [1, 4, 7],
            "b": [2, 5, 8]
        }`,
        options: {
            schema: 'main',
            name: 'foo',
            shape: duckdb.JSONTableShape.COLUMN_OBJECT,
            // Both differ from the inferred BIGINT. (arrow JS reports Type.Int for every
            // integer width, so arrowToSQLType sends any of them as int32.)
            columns: {
                a: new arrow.Utf8(),
                b: new arrow.Int32(),
            },
        },
        query: 'SELECT typeof(a) AS ta, typeof(b) AS tb, a FROM main.foo',
        expectedColumns: [
            { name: 'ta', values: ['VARCHAR', 'VARCHAR', 'VARCHAR'] },
            { name: 'tb', values: ['INTEGER', 'INTEGER', 'INTEGER'] },
            { name: 'a', values: ['1', '4', '7'] },
        ],
    },
    {
        name: 'rows_typed_without_shape',
        input: `[{"a":1}, {"a":2}]`,
        options: {
            schema: 'main',
            name: 'foo',
            columns: {
                a: new arrow.Utf8(),
            },
        },
        query: 'SELECT typeof(a) AS ta, a FROM main.foo',
        expectedColumns: [
            { name: 'ta', values: ['VARCHAR', 'VARCHAR'] },
            { name: 'a', values: ['1', '2'] },
        ],
    },
    {
        name: 'rows_missing_keys',
        input: `  [
            {"a":1},
            {"a":2, "b":"x"},
            {"b":"y", "c":null}
        ]`,
        options: {
            schema: 'main',
            name: 'foo',
        },
        query: 'SELECT a, b FROM main.foo',
        expectedColumns: [
            { name: 'a', values: [1, 2, null] },
            { name: 'b', values: [null, 'x', 'y'] },
        ],
    },
    {
        name: 'rows_nested',
        input: `[
            {"a":{"x":1,"y":[1,2]}, "b":NaN},
            {"a":{"x":2,"y":[]}, "b":1.5}
        ]`,
        options: {
            schema: 'main',
            name: 'foo',
        },
        query: 'SELECT a.x AS x, len(a.y)::INTEGER AS n, isnan(b) AS nan FROM main.foo',
        expectedColumns: [
            { name: 'x', values: [1, 2] },
            { name: 'n', values: [2, 0] },
            { name: 'nan', values: [true, false] },
        ],
    },
    {
        name: 'rows_empty_typed',
        input: `[]`,
        options: {
            schema: 'main',
            name: 'foo',
            columns: {
                a: new arrow.Int32(),
            },
        },
        query: `SELECT count(*)::INTEGER AS n, (SELECT data_type FROM information_schema.columns WHERE table_name = 'foo') AS t FROM main.foo`,
        expectedColumns: [
            { name: 'n', values: [0] },
            { name: 't', values: ['INTEGER'] },
        ],
    },
];

const JSON_INSERT_ERROR_TESTS: { input: string; error: string }[] = [
    { input: '[]', error: "specify 'columns' to insert an empty array" },
    { input: '[1, 2, 3]', error: 'must contain objects' },
    { input: '{"a": [1], "b": 2}', error: "field 'b' must be an array" },
    { input: '42', error: 'must be an array of row objects or an object of column arrays' },
    { input: '', error: 'must be an array of row objects or an object of column arrays' },
];

function escapeRegExp(s: string): RegExp {
    return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/// compareTable only checks shape and names, so compare the values as well.
/// BigInts are normalized to numbers so the expectations can use plain literals.
function compareValues(table: arrow.Table, expected: Column[]): void {
    compareTable(table, expected);
    for (let i = 0; i < expected.length; ++i) {
        const col = table.getChildAt(i)!;
        const have = [];
        for (let j = 0; j < col.length; ++j) {
            const v = col.get(j);
            have.push(typeof v === 'bigint' ? Number(v) : v);
        }
        expect(have).withContext(expected[i].name).toEqual(expected[i].values);
    }
}

/// A row array well beyond read_json's default 16 MB maximum_object_size
const LARGE_ROWS = 400000;
function largeRowArray(): Uint8Array {
    const rows = [];
    for (let i = 0; i < LARGE_ROWS; ++i) {
        rows.push(`{"id":${i},"name":"some reasonably long string value"}`);
    }
    const buffer = encoder.encode(`[${rows.join(',')}]`);
    expect(buffer.length).toBeGreaterThan(16 * 1024 * 1024);
    return buffer;
}

const TEST_FILE = 'TEST';

export function testJSONInsert(db: () => duckdb.DuckDBBindings): void {
    let conn: duckdb.DuckDBConnection;

    beforeEach(async () => {
        db().flushFiles();
        conn = db().connect();
    });
    afterEach(async () => {
        conn.close();
        await db().flushFiles();
        await db().dropFiles();
    });
    describe('JSON Insert Sync', () => {
        for (const test of JSON_INSERT_TESTS) {
            it(test.name, () => {
                conn.query(`DROP TABLE IF EXISTS ${test.options.schema || 'main'}.${test.options.name}`);
                const buffer = encoder.encode(test.input);
                db().registerFileBuffer(TEST_FILE, buffer);
                conn.insertJSONFromPath(TEST_FILE, test.options);
                const results = conn.query(test.query);
                compareValues(results, test.expectedColumns);
            });
        }
        for (const test of JSON_INSERT_ERROR_TESTS) {
            it(`error ${JSON.stringify(test.input)}`, () => {
                conn.query('DROP TABLE IF EXISTS main.foo');
                db().registerFileBuffer(TEST_FILE, encoder.encode(test.input));
                expect(() => conn.insertJSONFromPath(TEST_FILE, { name: 'foo' })).toThrowError(
                    escapeRegExp(test.error),
                );
            });
        }
        it('append', () => {
            conn.query('DROP TABLE IF EXISTS main.foo');
            db().registerFileBuffer(TEST_FILE, encoder.encode('[{"a":1},{"a":2}]'));
            conn.insertJSONFromPath(TEST_FILE, { name: 'foo' });
            conn.insertJSONFromPath(TEST_FILE, { name: 'foo', create: false });
            compareValues(conn.query('SELECT sum(a)::INTEGER AS s FROM main.foo'), [{ name: 's', values: [6] }]);
        });
        it('larger than default object size', () => {
            conn.query('DROP TABLE IF EXISTS main.foo');
            db().registerFileBuffer(TEST_FILE, largeRowArray());
            conn.insertJSONFromPath(TEST_FILE, { name: 'foo' });
            compareValues(conn.query('SELECT count(*)::INTEGER AS n, max(id)::INTEGER AS m FROM main.foo'), [
                { name: 'n', values: [LARGE_ROWS] },
                { name: 'm', values: [LARGE_ROWS - 1] },
            ]);
        });
    });
}

export function testJSONInsertAsync(db: () => duckdb.AsyncDuckDB): void {
    let conn: duckdb.AsyncDuckDBConnection;

    beforeEach(async () => {
        await db().flushFiles();
        conn = await db().connect();
    });
    afterEach(async () => {
        await conn.close();
        await db().flushFiles();
        await db().dropFiles();
    });
    describe('JSON Insert Buffer Async', () => {
        for (const test of JSON_INSERT_TESTS) {
            it(test.name, async () => {
                await conn.query(`DROP TABLE IF EXISTS ${test.options.schema || 'main'}.${test.options.name}`);
                const buffer = encoder.encode(test.input);
                await db().registerFileBuffer(TEST_FILE, buffer);
                await conn.insertJSONFromPath(TEST_FILE, test.options);
                const results = await conn.query(test.query);
                compareValues(results, test.expectedColumns);
            });
        }
        for (const test of JSON_INSERT_ERROR_TESTS) {
            it(`error ${JSON.stringify(test.input)}`, async () => {
                await conn.query('DROP TABLE IF EXISTS main.foo');
                await db().registerFileBuffer(TEST_FILE, encoder.encode(test.input));
                await expectAsync(conn.insertJSONFromPath(TEST_FILE, { name: 'foo' })).toBeRejectedWithError(
                    escapeRegExp(test.error),
                );
            });
        }
        it('append', async () => {
            await conn.query('DROP TABLE IF EXISTS main.foo');
            await db().registerFileBuffer(TEST_FILE, encoder.encode('[{"a":1},{"a":2}]'));
            await conn.insertJSONFromPath(TEST_FILE, { name: 'foo' });
            await conn.insertJSONFromPath(TEST_FILE, { name: 'foo', create: false });
            compareValues(await conn.query('SELECT sum(a)::INTEGER AS s FROM main.foo'), [{ name: 's', values: [6] }]);
        });
        it('larger than default object size', async () => {
            await conn.query('DROP TABLE IF EXISTS main.foo');
            await db().registerFileBuffer(TEST_FILE, largeRowArray());
            await conn.insertJSONFromPath(TEST_FILE, { name: 'foo' });
            compareValues(await conn.query('SELECT count(*)::INTEGER AS n, max(id)::INTEGER AS m FROM main.foo'), [
                { name: 'n', values: [LARGE_ROWS] },
                { name: 'm', values: [LARGE_ROWS - 1] },
            ]);
        });
    });

    describeBrowser('JSON Insert Blob Async', () => {
        for (const test of JSON_INSERT_TESTS) {
            it(test.name, async () => {
                await conn.query(`DROP TABLE IF EXISTS ${test.options.schema || 'main'}.${test.options.name}`);
                const buffer = encoder.encode(test.input);
                const blob = new Blob([buffer]);
                await db().registerFileHandle(TEST_FILE, blob, DuckDBDataProtocol.BROWSER_FILEREADER, false);
                await conn.insertJSONFromPath(TEST_FILE, test.options);
                const results = await conn.query(test.query);
                compareValues(results, test.expectedColumns);
            });
        }
    });
}
