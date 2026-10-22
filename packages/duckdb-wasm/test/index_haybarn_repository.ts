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
