import DuckDBWasm from './duckdb-coi.js';
import { DuckDBBrowserBindings } from './bindings_browser_base';
import { DuckDBModule } from './duckdb_module';
import { DuckDBRuntime } from './runtime';
import { Logger } from '../log';

/** DuckDB bindings for the browser */
export class DuckDB extends DuckDBBrowserBindings {
    /** Constructor */
    public constructor(
        logger: Logger,
        runtime: DuckDBRuntime,
        mainModuleURL: string,
        pthreadWorkerURL: string | null = null,
    ) {
        super(logger, runtime, mainModuleURL, pthreadWorkerURL);
    }

    /** Instantiate the bindings */
    protected instantiateImpl(moduleOverrides: Partial<DuckDBModule>): Promise<DuckDBModule> {
        // emsdk 5.x spawns pthread workers via `new Worker(pthreadMainJs, …)`,
        // where `pthreadMainJs = Module["mainScriptUrlOrBlob"] || _scriptName`
        // — `locateFile("*.worker.js")` is no longer consulted. Point it at
        // our wrapper bundle so the worker gets `DUCKDB_RUNTIME` injected
        // and our custom message handlers wired in before pthread protocol
        // handling begins.
        const overrides: Partial<DuckDBModule> = {
            ...moduleOverrides,
            instantiateWasm: this.instantiateWasm.bind(this),
            locateFile: this.locateFile.bind(this),
        };
        if (this.pthreadWorkerURL) {
            (overrides as Record<string, unknown>).mainScriptUrlOrBlob = this.pthreadWorkerURL;
        }
        return DuckDBWasm(overrides);
    }
}

export default DuckDB;
