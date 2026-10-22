<p align="center">
  <a href="https://query.farm/products/haybarn/"><img src="https://raw.githubusercontent.com/Query-farm-haybarn/.github/haybarn/profile/assets/haybarn-icon.png" alt="Haybarn" width="120" height="120"></a>
</p>
<p align="center">
  <a href="https://query.farm"><img src="https://query.farm/media-kit/logo/wordmark-light.png" alt="Query.Farm" height="28"></a>
</p>

[![npm](https://img.shields.io/npm/v/@haybarn/haybarn-wasm?logo=npm)](https://www.npmjs.com/package/@haybarn/haybarn-wasm/v/latest)
[![Main](https://github.com/Query-farm-haybarn/haybarn-wasm/actions/workflows/main.yml/badge.svg?branch=haybarn-2.0)](https://github.com/Query-farm-haybarn/haybarn-wasm/actions/workflows/main.yml)
[![status](https://img.shields.io/badge/build-haybarn--status.query.farm-58a6ff)](https://haybarn-status.query.farm)

**Haybarn-Wasm**

Haybarn-Wasm is Query Farm LLC's WebAssembly distribution of [Haybarn](https://query.farm/products/haybarn/) — a derived distribution of [DuckDB](https://duckdb.org) ("Haybarn, powered by DuckDB"). This is the 2.0 line, built on DuckDB v2.0.0. The wasm binary is built against the Haybarn engine fork, so `INSTALL <extension>` resolves to the Haybarn extension repository at [`haybarn-extensions.query.farm`](https://haybarn-status.query.farm) and validates against the Haybarn signing trust root.

The public API mirrors `@duckdb/duckdb-wasm` 2.0. Existing duckdb-wasm code ports by rewriting the import:

```ts
// before
import * as duckdb from '@duckdb/duckdb-wasm';
// after
import * as duckdb from '@haybarn/haybarn-wasm';
```

This is a hard fork of [duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm). See [HAYBARN.md](https://github.com/Query-farm-haybarn/haybarn-wasm/blob/haybarn-2.0/HAYBARN.md) for the relationship to upstream.

## Instantiation
cdn(jsdelivr)  
```ts
import * as duckdb from '@haybarn/haybarn-wasm';

const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();

// Select a bundle based on browser checks
const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

const worker_url = URL.createObjectURL(
  new Blob([`importScripts("${bundle.mainWorker!}");`], {type: 'text/javascript'})
);

// Instantiate the asynchronous version of Haybarn-Wasm
const worker = new Worker(worker_url);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
URL.revokeObjectURL(worker_url);
```

webpack  
```ts
import * as duckdb from '@haybarn/haybarn-wasm';
import duckdb_wasm from '@haybarn/haybarn-wasm/dist/duckdb-base.wasm';
const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    base: {
        mainModule: duckdb_wasm,
        mainWorker: new URL('@haybarn/haybarn-wasm/dist/duckdb-browser-base.worker.js', import.meta.url).toString(),
    },
};
// Select a bundle based on browser checks
const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
// Instantiate the asynchronous version of Haybarn-Wasm
const worker = new Worker(bundle.mainWorker!);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
```
vite  
```ts
import * as duckdb from '@haybarn/haybarn-wasm';
import duckdb_wasm from '@haybarn/haybarn-wasm/dist/duckdb-base.wasm?url';
import duckdb_worker from '@haybarn/haybarn-wasm/dist/duckdb-browser-base.worker.js?url';

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    base: {
        mainModule: duckdb_wasm,
        mainWorker: duckdb_worker,
    },
};
// Select a bundle based on browser checks
const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
// Instantiate the asynchronous version of Haybarn-Wasm
const worker = new Worker(bundle.mainWorker!);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
```
static served (manually download the files from https://cdn.jsdelivr.net/npm/@haybarn/haybarn-wasm/dist/)
```ts
import * as duckdb from '@haybarn/haybarn-wasm';

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    base: {
        mainModule: 'change/me/../duckdb-base.wasm',
        mainWorker: 'change/me/../duckdb-browser-base.worker.js',
    },
};
// Select a bundle based on browser checks
const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
// Instantiate the asynchronous version of Haybarn-Wasm
const worker = new Worker(bundle.mainWorker!);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
```  

## Loading extensions

Extensions are fetched from `https://haybarn-extensions.query.farm/{core,community}/v2.0.0/<platform>/`, where the
platform is `wasm_eh` for the `base` bundle and `wasm_threads` for the `threads` bundle. Every extension is checked
against the Haybarn signing key before it is loaded.

```sql
INSTALL httpfs;             -- core/v2.0.0/wasm_eh/httpfs.duckdb_extension.wasm
LOAD httpfs;

INSTALL h3 FROM community;  -- community/v2.0.0/wasm_eh/h3.duckdb_extension.wasm
LOAD h3;
```

Parquet, JSON and ICU autoload on first use. For the catalog and per-platform availability, see
[haybarn-status.query.farm](https://haybarn-status.query.farm).


## Data Import

```ts
// Data can be inserted from an existing arrow.Table
await c.insertArrowTable(existingTable, { name: 'arrow_table' });
// ..., from a raw Arrow IPC stream
const c = await db.connect();
const streamResponse = await fetch(`someapi`);
const streamReader = streamResponse.body.getReader();
const streamInserts = [];
while (true) {
    const { value, done } = await streamReader.read();
    if (done) break;
    streamInserts.push(c.insertArrowFromIPCStream(value, { name: 'streamed' }));
}
await Promise.all(streamInserts);

// ..., from CSV files
// (interchangeable: registerFile{Text,Buffer,URL,Handle})
await db.registerFileText(`data.csv`, '1|foo\n2|bar\n');
// ... with typed insert options
await c.insertCSVFromPath('data.csv', {
    schema: 'main',
    name: 'foo',
    detect: false,
    header: false,
    delimiter: '|',
    columns: {
        col1: new arrow.Int32(),
        col2: new arrow.Utf8(),
    },
});

// ..., from JSON documents in row-major format
await db.registerFileText(
    'rows.json',
    `[
    { "col1": 1, "col2": "foo" },
    { "col1": 2, "col2": "bar" },
]`,
);
// ... or column-major format
await db.registerFileText(
    'columns.json',
    `{
    "col1": [1, 2],
    "col2": ["foo", "bar"]
}`,
);
// ... with typed insert options
await c.insertJSONFromPath('rows.json', { name: 'rows' });
await c.insertJSONFromPath('columns.json', { name: 'columns' });

// ... from a Javascript array
const myArray = [
  {
    name: 'Dan',
    age: 32,
    numberOfPets: 3
  }
];
const encoder = new TextEncoder();
const buffer = encoder.encode(myArray);
await db.registerFileBuffer(myTableName, buffer);
await c.insertJSONFromPath(myTableName, {
  schema: 'main',
  name: 'foo',
});

// ..., from Parquet files
const pickedFile: File = letUserPickFile();
await db.registerFileHandle('local.parquet', pickedFile, DuckDBDataProtocol.BROWSER_FILEREADER, true);
await db.registerFileURL('remote.parquet', 'https://origin/remote.parquet', DuckDBDataProtocol.HTTP, false);
const res = await fetch('https://origin/remote.parquet');
await db.registerFileBuffer('buffer.parquet', new Uint8Array(await res.arrayBuffer()));

// ..., by specifying URLs in the SQL text
await c.query(`
    CREATE TABLE direct AS
        SELECT * FROM "https://origin/remote.parquet"
`);
// ..., or by executing raw insert statements
await c.query(`INSERT INTO existing_table
    VALUES (1, "foo"), (2, "bar")`);

// Close the connection to release memory
await c.close();
```

## Query Execution

```ts
// Either materialize the query result
await conn.query<{ v: arrow.Int }>(`
    SELECT * FROM generate_series(1, 100) t(v)
`);
// ..., or fetch the result chunks lazily
for await (const batch of await conn.send<{ v: arrow.Int }>(`
    SELECT * FROM generate_series(1, 100) t(v)
`)) {
    // ...
}
// Close the connection to release memory
await conn.close();
```

## Prepared Statements

```ts
// Prepare query
const stmt = await conn.prepare(`SELECT v + ? FROM generate_series(0, 10000) as t(v);`);
// ... and run the query with materialized results
await stmt.query(234);
// ... or result chunks
for await (const batch of await stmt.send(234)) {
    // ...
}
// Close the statement to release memory
await stmt.close();
// Closing the connection will release statements as well
await conn.close();
```

## Trademark

DuckDB is a trademark of the DuckDB Foundation. Haybarn is an independent derived distribution published by
Query Farm LLC and is not affiliated with, endorsed by, or sponsored by the DuckDB Foundation. "Haybarn, powered by
DuckDB" is the canonical tagline.
