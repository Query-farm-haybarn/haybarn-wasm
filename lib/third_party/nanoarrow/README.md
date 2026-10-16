# nanoarrow (vendored)

Bundled [Apache Arrow nanoarrow](https://github.com/apache/arrow-nanoarrow) sources: the core
library, the IPC reader/writer, and the flatcc runtime it needs.

| | |
|---|---|
| Source | branch [`haybarn/vendor`](https://github.com/rustyconover/arrow-nanoarrow/tree/haybarn/vendor) of `rustyconover/arrow-nanoarrow` |
| Commit | `52b94630c76222224fd5cbf0215041f34037e696` |
| Based on | `6b8b6c7` (dictionary IPC write/delta work, not yet in an apache/arrow-nanoarrow release) |

On top of that base:

- `fcf2f47` adds `ArrowIpcWriterWriteArrayViewWithDictionaries`, which the query result writer
  needs to emit one batch at a time.
- `05420fa` lets the IPC stream reader's validation level be configured
  ([apache/arrow-nanoarrow#964](https://github.com/apache/arrow-nanoarrow/pull/964)).
- `52b9463` makes the IPC stream reader reference message bodies in place when reading from a
  buffer ([apache/arrow-nanoarrow#965](https://github.com/apache/arrow-nanoarrow/pull/965)).

Move to an apache/arrow-nanoarrow release once these changes land there.

Regenerate from a nanoarrow checkout:

```bash
python3 ci/scripts/bundle.py --output-dir <tmp> --with-ipc --with-flatcc --symbol-namespace HaybarnWasm
cp -R <tmp>/* lib/third_party/nanoarrow/ && cp LICENSE.txt NOTICE.txt lib/third_party/nanoarrow/
```

The symbol namespace keeps these symbols from colliding with a nanoarrow that a loadable
extension links in itself.
