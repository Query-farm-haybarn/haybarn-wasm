<img src="https://raw.githubusercontent.com/Query-farm-haybarn/haybarn-org-profile/main/profile/assets/haybarn-banner.png" height="64">

[![npm](https://img.shields.io/npm/v/@haybarn/haybarn-wasm?logo=npm)](https://www.npmjs.com/package/@haybarn/haybarn-wasm/v/latest)
[![Main](https://github.com/Query-farm-haybarn/haybarn-wasm/actions/workflows/main.yml/badge.svg?branch=haybarn)](https://github.com/Query-farm-haybarn/haybarn-wasm/actions/workflows/main.yml)
[![status](https://img.shields.io/badge/build-haybarn--status.query.farm-58a6ff)](https://haybarn-status.query.farm)

**Haybarn-Wasm**

Haybarn-Wasm is Query Farm LLC's WebAssembly distribution of [Haybarn](https://github.com/Query-farm-haybarn/haybarn) — a derived distribution of [DuckDB](https://duckdb.org) ("Haybarn, powered by DuckDB"). The wasm binary is built against the Haybarn engine fork, so `INSTALL <extension>` resolves to the Haybarn extension repository at [`haybarn-extensions.query.farm`](https://haybarn-status.query.farm) and validates against the Haybarn signing trust root.

The public API mirrors `@duckdb/duckdb-wasm` exactly. Existing duckdb-wasm code ports by rewriting the import:

```ts
// before
import * as duckdb from '@duckdb/duckdb-wasm';
// after
import * as duckdb from '@haybarn/haybarn-wasm';
```

This is a hard fork of [duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm). See [HAYBARN.md](https://github.com/Query-farm-haybarn/haybarn-wasm/blob/haybarn/HAYBARN.md) for the relationship to upstream.

## Instantiation

CDN (jsdelivr):
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

webpack:
```ts
import * as duckdb from '@haybarn/haybarn-wasm';
import duckdb_wasm from '@haybarn/haybarn-wasm/dist/duckdb-mvp.wasm';
import duckdb_wasm_next from '@haybarn/haybarn-wasm/dist/duckdb-eh.wasm';
const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    mvp: {
        mainModule: duckdb_wasm,
        mainWorker: new URL('@haybarn/haybarn-wasm/dist/duckdb-browser-mvp.worker.js', import.meta.url).toString(),
    },
    eh: {
        mainModule: duckdb_wasm_next,
        mainWorker: new URL('@haybarn/haybarn-wasm/dist/duckdb-browser-eh.worker.js', import.meta.url).toString(),
    },
};
const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
const worker = new Worker(bundle.mainWorker!);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
```

vite:
```ts
import * as duckdb from '@haybarn/haybarn-wasm';
import duckdb_wasm from '@haybarn/haybarn-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@haybarn/haybarn-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@haybarn/haybarn-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@haybarn/haybarn-wasm/dist/duckdb-browser-eh.worker.js?url';

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    mvp: { mainModule: duckdb_wasm,    mainWorker: mvp_worker },
    eh:  { mainModule: duckdb_wasm_eh, mainWorker: eh_worker  },
};
const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
const worker = new Worker(bundle.mainWorker!);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
```

Static-served (manually download files from https://cdn.jsdelivr.net/npm/@haybarn/haybarn-wasm/dist/):
```ts
import * as duckdb from '@haybarn/haybarn-wasm';

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    mvp: { mainModule: 'change/me/../duckdb-mvp.wasm', mainWorker: 'change/me/../duckdb-browser-mvp.worker.js' },
    eh:  { mainModule: 'change/me/../duckdb-eh.wasm',  mainWorker: 'change/me/../duckdb-browser-eh.worker.js'  },
};
const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
const worker = new Worker(bundle.mainWorker!);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
```

## Loading extensions

Extensions are fetched lazily from `https://haybarn-extensions.query.farm/{core,community}/v1.5.2/wasm_<variant>/`:

```sql
INSTALL spatial;            -- core/v1.5.2/wasm_eh/spatial.duckdb_extension.wasm
LOAD spatial;

INSTALL h3 FROM community;  -- community/v1.5.2/wasm_eh/h3.duckdb_extension.wasm
LOAD h3;
```

For the catalog and per-platform availability, see [haybarn-status.query.farm](https://haybarn-status.query.farm).

## Data import

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

// ..., from CSV files (interchangeable: registerFile{Text,Buffer,URL,Handle})
await db.registerFileText(`data.csv`, '1|foo\n2|bar\n');
await c.insertCSVFromPath('data.csv', {
    schema: 'main', name: 'foo', detect: false, header: false, delimiter: '|',
    columns: { col1: new arrow.Int32(), col2: new arrow.Utf8() },
});

// ..., from JSON documents in row-major format
await db.registerFileText('rows.json',
    `[{ "col1": 1, "col2": "foo" }, { "col1": 2, "col2": "bar" }]`);
await c.insertJSONFromPath('rows.json', { name: 'rows' });

// ..., from Parquet files
const pickedFile: File = letUserPickFile();
await db.registerFileHandle('local.parquet', pickedFile, DuckDBDataProtocol.BROWSER_FILEREADER, true);
await db.registerFileURL('remote.parquet', 'https://origin/remote.parquet', DuckDBDataProtocol.HTTP, false);

// ..., by specifying URLs in the SQL text
await c.query(`CREATE TABLE direct AS SELECT * FROM "https://origin/remote.parquet"`);

await c.close();
```

## Query execution

```ts
// Either materialize the query result
await conn.query<{ v: arrow.Int }>(`SELECT * FROM generate_series(1, 100) t(v)`);
// ..., or fetch result chunks lazily
for await (const batch of await conn.send<{ v: arrow.Int }>(`SELECT * FROM generate_series(1, 100) t(v)`)) {
    // ...
}
await conn.close();
```

## Prepared statements

```ts
const stmt = await conn.prepare(`SELECT v + ? FROM generate_series(0, 10000) as t(v);`);
await stmt.query(234);
for await (const batch of await stmt.send(234)) {
    // ...
}
await stmt.close();
await conn.close();
```

## Trademark

DuckDB is a trademark of the DuckDB Foundation. Haybarn is an independent
derived distribution published by Query Farm LLC; "Haybarn, powered by
DuckDB" is the canonical tagline.
