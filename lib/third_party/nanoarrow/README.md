# nanoarrow (vendored)

Bundled [Apache Arrow nanoarrow](https://github.com/apache/arrow-nanoarrow) sources: the core
library, the IPC reader/writer, and the flatcc runtime it needs.

| | |
|---|---|
| Source | branch `haybarn/write-array-view-with-dictionaries` (local, not yet pushed to `rustyconover/arrow-nanoarrow`) |
| Commit | `fcf2f475376668211dc798ff6bc00d9adbbea139` |
| Based on | `6b8b6c7` (dictionary IPC write/delta work, not yet in an apache/arrow-nanoarrow release) |

The extra commit on top adds `ArrowIpcWriterWriteArrayViewWithDictionaries`, which the query
result writer needs to emit one batch at a time. Move to an apache/arrow-nanoarrow release once
these changes land there.

Regenerate from a nanoarrow checkout:

```bash
python3 ci/scripts/bundle.py --output-dir <tmp> --with-ipc --with-flatcc --symbol-namespace HaybarnWasm
cp -R <tmp>/* lib/third_party/nanoarrow/ && cp LICENSE.txt NOTICE.txt lib/third_party/nanoarrow/
```

The symbol namespace keeps these symbols from colliding with a nanoarrow that a loadable
extension links in itself.
