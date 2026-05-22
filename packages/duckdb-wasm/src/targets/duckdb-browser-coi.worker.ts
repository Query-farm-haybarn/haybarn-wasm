import { AsyncDuckDBDispatcher, WorkerResponseVariant, WorkerRequestVariant } from '../parallel';
import { DuckDB } from '../bindings/bindings_browser_coi';
import { DuckDBBindings } from '../bindings';
import { BROWSER_RUNTIME } from '../bindings/runtime_browser';
import { InstantiationProgress } from '../bindings/progress';

/** The duckdb worker API for web workers */
class WebWorker extends AsyncDuckDBDispatcher {
    /** Post a response back to the main thread */
    protected postMessage(response: WorkerResponseVariant, transfer: ArrayBuffer[]) {
        globalThis.postMessage(response, transfer);
    }

    /** Instantiate the wasm module */
    protected async instantiate(
        mainModuleURL: string,
        pthreadWorkerURL: string | null,
        progress: (p: InstantiationProgress) => void,
    ): Promise<DuckDBBindings> {
        const bindings = new DuckDB(this, BROWSER_RUNTIME, mainModuleURL, pthreadWorkerURL);
        return await bindings.instantiate(progress);
    }
}

/** Register the worker */
export function registerWorker(): void {
    const api = new WebWorker();
    globalThis.onmessage = async (event: MessageEvent) => {
        const data: any = event.data;
        // VGI interactive OAuth bridge: the main thread sends the shared
        // "oauth SAB" that the engine glue's _duckdb_wasm_open_auth_url() blocks
        // on (Atomics.wait). Capture it as worker globals the classic engine-glue
        // script reads (bare `oauthInt32`/`oauthBytes`/`oauthSAB` resolve to
        // globalThis), and do NOT forward this message to the AsyncDuckDB
        // dispatcher (it isn't part of the worker request protocol).
        if (data && data.type === 'init-oauth-sab') {
            (globalThis as any).oauthSAB = data.sab;
            (globalThis as any).oauthInt32 = new Int32Array(data.sab);
            (globalThis as any).oauthBytes = new Uint8Array(data.sab);
            return;
        }
        await api.onMessage(data as WorkerRequestVariant);
    };
}

registerWorker();
