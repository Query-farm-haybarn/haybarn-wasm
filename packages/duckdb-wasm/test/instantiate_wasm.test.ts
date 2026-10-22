import * as duckdb_blocking from '../src/targets/duckdb-browser-blocking';
import * as duckdb from '../src/targets/duckdb';

// Browsers only code-cache a wasm module compiled from a Response that came straight from fetch(): the bindings must
// hand that Response to WebAssembly.instantiateStreaming as is, and count download progress on a clone.
export function testInstantiateWasm(bundles: duckdb.DuckDBBundles): void {
    describe('Instantiate wasm', () => {
        let originalFetch: typeof globalThis.fetch;
        let originalStreaming: any;
        let fetched: Response[];
        let compiled: any[];

        beforeEach(() => {
            fetched = [];
            compiled = [];
            originalFetch = globalThis.fetch;
            originalStreaming = WebAssembly.instantiateStreaming;
            (globalThis as any).fetch = async (...args: any[]) => {
                const response = await (originalFetch as any).apply(globalThis, args);
                fetched.push(response);
                return response;
            };
            (WebAssembly as any).instantiateStreaming = (source: any, imports: any) => {
                compiled.push(source);
                return originalStreaming.call(WebAssembly, source, imports);
            };
        });

        afterEach(() => {
            (globalThis as any).fetch = originalFetch;
            (WebAssembly as any).instantiateStreaming = originalStreaming;
        });

        const instantiate = async (onProgress?: (p: duckdb.InstantiationProgress) => void) => {
            const db = await duckdb_blocking.createDuckDB(
                bundles,
                new duckdb_blocking.VoidLogger(),
                duckdb_blocking.BROWSER_RUNTIME,
            );
            await db.instantiate(onProgress);
            expect(compiled.length).toEqual(1);
            const source = await compiled[0];
            const wasm = fetched.filter(r => new URL(r.url).pathname.endsWith('.wasm'));
            expect(wasm.length).toEqual(1);
            // the very object fetch() returned, not a Response re-wrapped around its body
            expect(source).toBe(wasm[0]);
            return db;
        };

        it('hands the fetch() response to instantiateStreaming', async () => {
            const db = await instantiate();
            expect(db.getVersion()).toBeTruthy();
        });

        it('counts progress on a clone of the response', async () => {
            const progress: duckdb.InstantiationProgress[] = [];
            await instantiate(p => progress.push({ ...p }));
            // the clone is read alongside the compile, its last report may land just after
            for (let i = 0; i < 100 && progress.length == 0; i++) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            expect(progress.length).toBeGreaterThan(0);
            expect(progress[progress.length - 1].bytesLoaded).toBeGreaterThan(0);
        });
    });
}
