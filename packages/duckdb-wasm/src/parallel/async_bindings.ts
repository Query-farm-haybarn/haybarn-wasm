import { OPFSAccessMode } from '../bindings/opfs_scratch';
import {
    WorkerRequestType,
    WorkerResponseType,
    WorkerResponseVariant,
    WorkerTaskVariant,
    WorkerTask,
    ConnectionID,
    WorkerTaskReturnType,
} from './worker_request';
import { AsyncDuckDBBindings } from './async_bindings_interface';
import { Logger } from '../log';
import { AsyncDuckDBConnection } from './async_connection';
import { CSVInsertOptions, JSONInsertOptions, ArrowInsertOptions } from '../bindings/insert_options';
import { ScriptTokens } from '../bindings/tokens';
import { FileStatistics } from '../bindings/file_stats';
import { DuckDBConfig } from '../bindings/config';
import { InstantiationProgress, QueryProgress, QueryProgressHandle } from '../bindings/progress';
import { InterruptHandle, interruptConnection } from '../bindings/interrupt';
import { arrowToSQLField } from '../json_typedef';
import { WebFile } from '../bindings/web_file';
import { DuckDBDataProtocol } from '../bindings';
import { searchOPFSFiles } from "../utils/opfs_util";
import { ProgressEntry } from '../log';

const TEXT_ENCODER = new TextEncoder();

/**
 * How often the flag of `registerCancelSAB` is checked while a pending query runs. A check costs one atomic load, so
 * the interval only bounds the latency of a cancel that arrives while the page waits for a poll.
 */
const CANCEL_SAB_POLL_MS = 50;

/** The default time a worker gets to answer its first message (see AsyncDuckDBOptions.workerStartTimeout) */
export const DEFAULT_WORKER_START_TIMEOUT_MS = 30000;

/** Options for the async DuckDB */
export interface AsyncDuckDBOptions {
    /**
     * Milliseconds the worker gets to answer its first message before all pending
     * requests are rejected with "worker did not start". Only a cheap PING is timed,
     * and only until the worker's first response arrives, so slow instantiation or
     * long-running queries are never cut short. 0 disables the check.
     * Defaults to DEFAULT_WORKER_START_TIMEOUT_MS (30 s).
     */
    workerStartTimeout?: number;
}

export class AsyncDuckDB implements AsyncDuckDBBindings {
    /** The message handler */
    protected readonly _onMessageHandler: (event: MessageEvent) => void;
    /** The error handler */
    protected readonly _onErrorHandler: (event: ErrorEvent) => void;
    /** The close handler */
    protected readonly _onCloseHandler: () => void;
    /** The message error handler */
    protected readonly _onMessageErrorHandler: (event: MessageEvent) => void;

    /** Instantiate the module */
    protected _onInstantiationProgress: ((p: InstantiationProgress) => void)[] = [];

    /** Progress callbacks */
    protected _onExecutionProgress: ((p: ProgressEntry) => void)[] = [];

    /** The logger */
    protected readonly _logger: Logger;
    /** The worker */
    protected _worker: Worker | null = null;
    /** The promise for the worker shutdown */
    protected _workerShutdownPromise: Promise<null> | null = null;
    /** Make the worker as terminated */
    protected _workerShutdownResolver: (value: PromiseLike<null> | null) => void = () => {};

    /** The next message id */
    protected _nextMessageId = 0;
    /** The pending requests */
    protected _pendingRequests: Map<number, WorkerTaskVariant> = new Map();
    /** The DuckDBConfig */
    protected _config: DuckDBConfig = {};
    /** The interrupt flags of the connections, fetched when they connect (threads bundle only) */
    protected _interruptHandles: Map<ConnectionID, InterruptHandle> = new Map();
    /** The connections with a pending query, in the order the queries started */
    protected _pendingQueries: Set<ConnectionID> = new Set();
    /** The flag of registerCancelSAB */
    protected _cancelFlag: Int32Array | null = null;
    /** The interval that checks the flag of registerCancelSAB while a pending query runs */
    protected _cancelWatcher: ReturnType<typeof setInterval> | null = null;

    /** Milliseconds the worker gets to answer its first message, 0 disables the check */
    protected readonly _workerStartTimeout: number;
    /** Did the attached worker send anything yet? */
    protected _workerStarted = false;
    /** The armed worker start timer, if any */
    protected _workerStartTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(logger: Logger, worker: Worker | null = null, options: AsyncDuckDBOptions = {}) {
        this._logger = logger;
        this._workerStartTimeout = options.workerStartTimeout ?? DEFAULT_WORKER_START_TIMEOUT_MS;
        this._onMessageHandler = this.onMessage.bind(this);
        this._onErrorHandler = this.onError.bind(this);
        this._onCloseHandler = this.onClose.bind(this);
        this._onMessageErrorHandler = this.onMessageError.bind(this);
        if (worker != null) this.attach(worker);
    }

    /** Get the logger */
    public get logger(): Logger {
        return this._logger;
    }

    /** Get the logger */
    public get config(): DuckDBConfig {
        return this._config;
    }

    /** Attach to worker */
    protected attach(worker: Worker): void {
        this._worker = worker;
        this._workerStarted = false;
        this._worker.addEventListener('message', this._onMessageHandler);
        this._worker.addEventListener('error', this._onErrorHandler);
        this._worker.addEventListener('close', this._onCloseHandler);
        this._worker.addEventListener('messageerror', this._onMessageErrorHandler);
        this._workerShutdownPromise = new Promise<null>(
            (resolve: (value: PromiseLike<null> | null) => void, _reject: (reason?: void) => void) => {
                this._workerShutdownResolver = resolve;
            },
        );
    }

    /** Detach from worker */
    public detach(): void {
        if (!this._worker) return;
        this._worker.removeEventListener('message', this._onMessageHandler);
        this._worker.removeEventListener('error', this._onErrorHandler);
        this._worker.removeEventListener('close', this._onCloseHandler);
        this._worker.removeEventListener('messageerror', this._onMessageErrorHandler);
        this._worker = null;
        this.clearWorkerStartTimer();
        this.rejectPendingRequests(new Error('duckdb worker was detached before the request completed'));
        this._workerShutdownResolver(null);
        this._workerShutdownPromise = null;
        this._workerShutdownResolver = () => {};
    }

    /** Kill the worker */
    public async terminate(): Promise<void> {
        if (!this._worker) return;
        this.forgetConnections();
        this._worker.terminate();
        //await this._workerShutdownPromise; TODO deadlocking in karma?
        this._worker = null;
        this.clearWorkerStartTimer();
        this.rejectPendingRequests(new Error('duckdb worker was terminated before the request completed'));
        this._workerShutdownPromise = null;
        this._workerShutdownResolver = () => {};
    }

    /** Reject all pending requests with an error and forget them */
    protected rejectPendingRequests(error: Error): void {
        const pending = [...this._pendingRequests.values()];
        this._pendingRequests.clear();
        for (const task of pending) {
            task.promiseRejecter(error);
        }
    }

    /** Stop waiting for the worker to start */
    protected clearWorkerStartTimer(): void {
        if (this._workerStartTimer !== null) {
            clearTimeout(this._workerStartTimer);
            this._workerStartTimer = null;
        }
    }

    /**
     * Make sure a worker that never starts fails instead of hanging.
     *
     * A worker can fail to load without ever emitting 'error' (e.g. a script error swallowed by
     * a Worker polyfill), in which case every request would wait forever. Before the first
     * request goes out we send a PING, which the dispatcher answers immediately, ahead of the
     * request itself. Any message from the worker disarms the timer. If none arrives in time,
     * all pending requests are rejected. Long-running requests are never timed.
     */
    protected armWorkerStartTimer(): void {
        if (!this._worker || this._workerStarted || this._workerStartTimer !== null) return;
        if (!(this._workerStartTimeout > 0)) return;
        const ping = new WorkerTask<WorkerRequestType.PING, null, null>(WorkerRequestType.PING, null);
        ping.promise.catch(() => {});
        const mid = this._nextMessageId++;
        this._pendingRequests.set(mid, ping);
        this._worker.postMessage({ messageId: mid, type: ping.type, data: ping.data });
        const timeout = this._workerStartTimeout;
        this._workerStartTimer = setTimeout(() => {
            this._workerStartTimer = null;
            if (this._workerStarted) return;
            const error = new Error(
                `duckdb worker did not start: no response within ${timeout} ms. ` +
                    'The worker script probably failed to load or threw during startup; check the worker console ' +
                    'output. In Node.js, also check the `web-worker` package version. ' +
                    'The timeout can be changed with the `workerStartTimeout` option of AsyncDuckDB.',
            );
            console.error(error.message);
            this.rejectPendingRequests(error);
        }, timeout);
    }

    /** Post a task */
    protected async postTask<W extends WorkerTaskVariant>(
        task: W,
        transfer: ArrayBuffer[] = [],
    ): Promise<WorkerTaskReturnType<W>> {
        if (!this._worker) {
            console.error('cannot send a message since the worker is not set!:' + task.type+"," + task.data);
            return undefined as any;
        }
        this.armWorkerStartTimer();
        const mid = this._nextMessageId++;
        this._pendingRequests.set(mid, task);
        this._worker.postMessage(
            {
                messageId: mid,
                type: task.type,
                data: task.data,
            },
            transfer,
        );
        return (await task.promise) as WorkerTaskReturnType<W>;
    }

    /** Received a message */
    protected onMessage(event: MessageEvent): void {
        // Any message proves the worker is running
        if (!this._workerStarted) {
            this._workerStarted = true;
            this.clearWorkerStartTimer();
        }

        // Unassociated responses?
        const response = event.data as WorkerResponseVariant;
        switch (response.type) {
            // Request failed?
            case WorkerResponseType.PROGRESS_UPDATE: {
                for (const p of this._onExecutionProgress) {
                    p(response.data);
                }
                return;
            }
            case WorkerResponseType.LOG: {
                this._logger.log(response.data);
                return;
            }
            // Call progress callback
            case WorkerResponseType.INSTANTIATE_PROGRESS: {
                for (const p of this._onInstantiationProgress) {
                    p(response.data);
                }
                return;
            }
        }

        // Haybarn: a message of the engine's platform functions (open-auth-url, vgi-ensure-worker), for the page
        // bridges that listen on the same Worker
        if (typeof response.requestId !== 'number') {
            return;
        }
        // Get associated task
        const task = this._pendingRequests.get(response.requestId);
        if (!task) {
            console.warn(`unassociated response: [${response.requestId}, ${response.type.toString()}]`);
            return;
        }
        this._pendingRequests.delete(response.requestId);

        // Request failed?
        if (response.type == WorkerResponseType.ERROR) {
            // Workaround for Firefox not being able to perform structured-clone on Native Errors
            // https://bugzilla.mozilla.org/show_bug.cgi?id=1556604
            const e = new Error(response.data.message);
            e.name = response.data.name;
            if (Object.getOwnPropertyDescriptor(e, 'stack')?.writable) {
                e.stack = response.data.stack;
            }
            task.promiseRejecter(e);
            return;
        }

        // Otherwise differentiate between the tasks first
        switch (task.type) {
            case WorkerRequestType.CLOSE_PREPARED:
            case WorkerRequestType.COLLECT_FILE_STATISTICS:
            case WorkerRequestType.COPY_FILE_TO_PATH:
            case WorkerRequestType.DISCONNECT:
            case WorkerRequestType.DROP_FILE:
            case WorkerRequestType.DROP_FILES:
            case WorkerRequestType.FLUSH_FILES:
            case WorkerRequestType.INSERT_ARROW_FROM_IPC_STREAM:
            case WorkerRequestType.INSERT_CSV_FROM_PATH:
            case WorkerRequestType.INSERT_JSON_FROM_PATH:
            case WorkerRequestType.OPEN:
            case WorkerRequestType.PING:
            case WorkerRequestType.REGISTER_FILE_BUFFER:
            case WorkerRequestType.REGISTER_FILE_HANDLE:
            case WorkerRequestType.REGISTER_FILE_URL:
            case WorkerRequestType.RESET:
                if (response.type == WorkerResponseType.OK) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.INSTANTIATE:
                this._onInstantiationProgress = [];
                if (response.type == WorkerResponseType.OK) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.GLOB_FILE_INFOS:
                if (response.type == WorkerResponseType.FILE_INFOS) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.GET_VERSION:
                if (response.type == WorkerResponseType.VERSION_STRING) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.GET_FEATURE_FLAGS:
                if (response.type == WorkerResponseType.FEATURE_FLAGS) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.GET_TABLE_NAMES:
                if (response.type == WorkerResponseType.TABLE_NAMES) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.REGISTER_OPFS_FILE_NAME:
                if (response.type == WorkerResponseType.OPFS_FILE_NAMES) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.TOKENIZE:
                if (response.type == WorkerResponseType.SCRIPT_TOKENS) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.COPY_FILE_TO_BUFFER:
                if (response.type == WorkerResponseType.FILE_BUFFER) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.EXPORT_FILE_STATISTICS:
                if (response.type == WorkerResponseType.FILE_STATISTICS) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.CONNECT:
                if (response.type == WorkerResponseType.CONNECTION_INFO) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.RUN_PREPARED:
            case WorkerRequestType.RUN_QUERY:
                if (response.type == WorkerResponseType.QUERY_RESULT) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.SEND_PREPARED:
                if (response.type == WorkerResponseType.QUERY_RESULT_HEADER) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.START_PENDING_QUERY:
                if (response.type == WorkerResponseType.QUERY_RESULT_HEADER_OR_NULL) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.POLL_PENDING_QUERY:
                if (response.type == WorkerResponseType.QUERY_RESULT_HEADER_OR_NULL) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.CANCEL_PENDING_QUERY:
                this._onInstantiationProgress = [];
                if (response.type == WorkerResponseType.SUCCESS) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.GET_INTERRUPT_HANDLE:
                if (response.type == WorkerResponseType.INTERRUPT_HANDLE) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.GET_PROGRESS_HANDLE:
                if (response.type == WorkerResponseType.PROGRESS_HANDLE) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.GET_QUERY_PROGRESS:
                if (response.type == WorkerResponseType.QUERY_PROGRESS) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.FETCH_QUERY_RESULTS:
                if (response.type == WorkerResponseType.QUERY_RESULT_CHUNK) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
            case WorkerRequestType.CREATE_PREPARED:
                if (response.type == WorkerResponseType.PREPARED_STATEMENT_ID) {
                    task.promiseResolver(response.data);
                    return;
                }
                break;
        }
        task.promiseRejecter(new Error(`unexpected response type: ${response.type.toString()}`));
    }

    /** Received an error */
    protected onError(event: ErrorEvent): void {
        console.error(event);
        console.error(`error in duckdb worker: ${event.message} (${event.filename}:${event.lineno})`);
        this.clearWorkerStartTimer();
        this.rejectPendingRequests(new Error(`error in duckdb worker: ${event.message ?? 'unknown error'}`));
    }

    /** A message from the worker could not be deserialized */
    protected onMessageError(_event: MessageEvent): void {
        // We cannot tell which request the lost response belonged to, so fail them all rather than hang.
        console.error('duckdb worker sent a message that could not be deserialized');
        this.rejectPendingRequests(new Error('duckdb worker sent a message that could not be deserialized'));
    }

    /** The worker was closed */
    protected onClose(): void {
        this._workerShutdownResolver(null);
        this.clearWorkerStartTimer();
        if (this._pendingRequests.size != 0) {
            console.warn(`worker terminated with ${this._pendingRequests.size} pending requests`);
        }
        this.rejectPendingRequests(new Error('duckdb worker closed before the request completed'));
    }

    /** Is in detached state, no worker defined */
    public isDetached(): boolean {
        return !this._worker;
    }

    /** Reset the duckdb */
    public async reset(): Promise<null> {
        this.forgetConnections();
        const task = new WorkerTask<WorkerRequestType.RESET, null, null>(WorkerRequestType.RESET, null);
        return await this.postTask(task);
    }

    /** Ping the worker thread */
    public async ping(): Promise<any> {
        const task = new WorkerTask<WorkerRequestType.PING, null, null>(WorkerRequestType.PING, null);
        await this.postTask(task);
    }
    /** Try to drop a file */
    public async dropFile(name: string): Promise<null> {
        const task = new WorkerTask<WorkerRequestType.DROP_FILE, string, null>(WorkerRequestType.DROP_FILE, name);
        return await this.postTask(task);
    }
    /** Try to drop files */
    public async dropFiles(names?: string[]): Promise<null> {
        const task = new WorkerTask<WorkerRequestType.DROP_FILES, string[] | undefined, null>(WorkerRequestType.DROP_FILES, names);
        return await this.postTask(task);
    }
    /** Flush all files */
    public async flushFiles(): Promise<null> {
        const task = new WorkerTask<WorkerRequestType.FLUSH_FILES, null, null>(WorkerRequestType.FLUSH_FILES, null);
        return await this.postTask(task);
    }

    /** Open the database */
    public async instantiate(
        mainModuleURL: string,
        pthreadWorkerURL: string | null = null,
        progress?: (progress: InstantiationProgress) => void,
    ): Promise<null> {
        if (progress) {
            this._onInstantiationProgress.push(progress);
        }
        // Haybarn: the worker only counts download progress when someone listens (third element)
        const task = new WorkerTask<WorkerRequestType.INSTANTIATE, [string, string | null, boolean?], null>(
            WorkerRequestType.INSTANTIATE,
            [mainModuleURL, pthreadWorkerURL, this._onInstantiationProgress.length > 0],
        );
        return await this.postTask(task);
    }

    /** Get the version */
    public async getVersion(): Promise<string> {
        const task = new WorkerTask<WorkerRequestType.GET_VERSION, null, string>(WorkerRequestType.GET_VERSION, null);
        const version = await this.postTask(task);
        return version;
    }

    /** Get the feature flags */
    public async getFeatureFlags(): Promise<number> {
        const task = new WorkerTask<WorkerRequestType.GET_FEATURE_FLAGS, null, number>(
            WorkerRequestType.GET_FEATURE_FLAGS,
            null,
        );
        const feature = await this.postTask(task);
        return feature;
    }

    /** Open a new database */
    public async open(config: DuckDBConfig): Promise<void> {
        this._config = config;
        this.forgetConnections();
        const task = new WorkerTask<WorkerRequestType.OPEN, DuckDBConfig, null>(WorkerRequestType.OPEN, config);
        await this.postTask(task);
    }

    /** Tokenize a script text */
    public async tokenize(text: string): Promise<ScriptTokens> {
        const task = new WorkerTask<WorkerRequestType.TOKENIZE, string, ScriptTokens>(WorkerRequestType.TOKENIZE, text);
        const tokens = await this.postTask(task);
        return tokens;
    }

    /** Connect to the database */
    public async connectInternal(): Promise<number> {
        const task = new WorkerTask<WorkerRequestType.CONNECT, null, ConnectionID>(WorkerRequestType.CONNECT, null);
        return await this.postTask(task);
    }

    /** Connect to the database */
    public async connect(): Promise<AsyncDuckDBConnection> {
        const cid = await this.connectInternal();
        // A cancel must reach a query that runs inside a worker call, which no message does: keep the flag at hand
        if (typeof SharedArrayBuffer !== 'undefined') {
            const handle = await this.getInterruptHandle(cid);
            if (handle !== null) this._interruptHandles.set(cid, handle);
        }
        return new AsyncDuckDBConnection(this, cid);
    }

    /** Disconnect from the database */
    public async disconnect(conn: ConnectionID): Promise<void> {
        this._interruptHandles.delete(conn);
        this.endPendingQuery(conn);
        const task = new WorkerTask<WorkerRequestType.DISCONNECT, ConnectionID, null>(
            WorkerRequestType.DISCONNECT,
            conn,
        );
        await this.postTask(task);
    }

    /** Run a query */
    public async runQuery(conn: ConnectionID, text: string): Promise<Uint8Array> {
        if( this.shouldOPFSFileHandling() ){
            const files = await this.registerOPFSFileFromSQL(text);
            try {
                return await this._runQueryAsync(conn, text);
            } finally {
                if( files.length > 0 ){
                    await this.dropFiles(files);
                }
            }
        } else {
            return await this._runQueryAsync(conn, text);
        }
    }

    private async _runQueryAsync(conn: ConnectionID, text: string): Promise<Uint8Array> {
        const task = new WorkerTask<WorkerRequestType.RUN_QUERY, [ConnectionID, string], Uint8Array>(
            WorkerRequestType.RUN_QUERY,
            [conn, text],
        );
        return await this.postTask(task);
    }

    /** Start a pending query */
    public async startPendingQuery(
        conn: ConnectionID,
        text: string,
        allowStreamResult: boolean = false,
    ): Promise<Uint8Array | null> {
        if( this.shouldOPFSFileHandling() ){
            const files = await this.registerOPFSFileFromSQL(text);
            try {
                return await this._startPendingQueryAsync(conn, text, allowStreamResult);
            } finally {
                if( files.length > 0 ){
                    await this.dropFiles(files);
                }
            }
        } else {
            return await this._startPendingQueryAsync(conn, text, allowStreamResult);
        }
    }

    private async _startPendingQueryAsync(
        conn: ConnectionID,
        text: string,
        allowStreamResult: boolean = false,
    ): Promise<Uint8Array | null> {
        const task = new WorkerTask<
            WorkerRequestType.START_PENDING_QUERY,
            [ConnectionID, string, boolean],
            Uint8Array | null
        >(WorkerRequestType.START_PENDING_QUERY, [conn, text, allowStreamResult]);
        this.beginPendingQuery(conn);
        return await this.trackPendingQuery(conn, this.postTask(task));
    }

    /** Poll a pending query */
    public async pollPendingQuery(conn: ConnectionID): Promise<Uint8Array | null> {
        if (this.takeCancelFlag() && this._pendingQueries.has(conn)) {
            // Cancelled through registerCancelSAB before this poll was sent: the poll reports the cancel
            await this.cancelPendingQuery(conn);
        }
        const task = new WorkerTask<WorkerRequestType.POLL_PENDING_QUERY, ConnectionID, Uint8Array | null>(
            WorkerRequestType.POLL_PENDING_QUERY,
            conn,
        );
        return await this.trackPendingQuery(conn, this.postTask(task));
    }
    /**
     * Cancel a pending query.
     *
     * On the threads bundle the worker runs a poll to its end before it reads another message, so the query is
     * interrupted through shared memory first (getInterruptHandle): a running poll stops at the engine's next check
     * and fails with an interrupt error, and in-flight HTTP requests of the query are abandoned. The cancel message
     * then ends the query in the worker, if the poll has not already ended it.
     */
    public async cancelPendingQuery(conn: ConnectionID): Promise<boolean> {
        const handle = this._interruptHandles.get(conn);
        const interrupted = handle !== undefined && this._pendingQueries.has(conn);
        if (interrupted) {
            interruptConnection(handle);
        }
        this.endPendingQuery(conn);
        const task = new WorkerTask<WorkerRequestType.CANCEL_PENDING_QUERY, ConnectionID, boolean>(
            WorkerRequestType.CANCEL_PENDING_QUERY,
            conn,
        );
        const cancelled = await this.postTask(task);
        return cancelled || interrupted;
    }

    /**
     * The connection's interrupt flag, or null when the wasm memory is not shared (the base bundle). Then
     * `interruptConnection(handle)` interrupts what runs on the connection from any thread, also while the worker is
     * inside the call that runs it and no message reaches it.
     */
    public async getInterruptHandle(conn: ConnectionID): Promise<InterruptHandle | null> {
        const cached = this._interruptHandles.get(conn);
        if (cached) return cached;
        const task = new WorkerTask<WorkerRequestType.GET_INTERRUPT_HANDLE, ConnectionID, InterruptHandle | null>(
            WorkerRequestType.GET_INTERRUPT_HANDLE,
            conn,
        );
        return await this.postTask(task);
    }

    /**
     * The connection's query progress slot, or null when the wasm memory is not shared (the base bundle). Read it
     * with `readQueryProgress(handle)`, also while a query runs. The engine reports progress only with
     * `SET enable_progress_bar = true`.
     */
    public async getProgressHandle(conn: ConnectionID): Promise<QueryProgressHandle | null> {
        const task = new WorkerTask<WorkerRequestType.GET_PROGRESS_HANDLE, ConnectionID, QueryProgressHandle | null>(
            WorkerRequestType.GET_PROGRESS_HANDLE,
            conn,
        );
        return await this.postTask(task);
    }

    /**
     * The progress of the connection's query as the engine last reported it, on every bundle. The worker answers
     * between two calls only: on the threads bundle, read a running query's progress with getProgressHandle.
     */
    public async getQueryProgress(conn: ConnectionID): Promise<QueryProgress | null> {
        const task = new WorkerTask<WorkerRequestType.GET_QUERY_PROGRESS, ConnectionID, QueryProgress | null>(
            WorkerRequestType.GET_QUERY_PROGRESS,
            conn,
        );
        return await this.postTask(task);
    }

    /**
     * Register a SharedArrayBuffer of at least 4 bytes through which any thread can cancel the most recently started
     * pending query: `Atomics.store(new Int32Array(sab), 0, 1)`. The flag is checked before each poll and every
     * 50 ms while a pending query runs; a cancel resets it to 0 and goes through `cancelPendingQuery`, so on the
     * threads bundle it also interrupts a poll that is running. For a specific connection use `cancelSent()` or
     * `getInterruptHandle`. Registering again replaces the buffer.
     */
    public registerCancelSAB(sab: SharedArrayBuffer): void {
        if (typeof SharedArrayBuffer === 'undefined') {
            throw new TypeError(
                'registerCancelSAB requires SharedArrayBuffer support (cross-origin isolation must be enabled)',
            );
        }
        if (!(sab instanceof SharedArrayBuffer)) {
            throw new TypeError('registerCancelSAB requires a SharedArrayBuffer (got a non-shared buffer)');
        }
        if (sab.byteLength < 4) {
            throw new RangeError(`registerCancelSAB requires at least 4 bytes for the Int32 flag (got ${sab.byteLength})`);
        }
        this._cancelFlag = new Int32Array(sab, 0, 1);
        this.updateCancelWatcher();
    }

    /** A pending query starts on the connection */
    protected beginPendingQuery(conn: ConnectionID): void {
        // Re-added at the end: the most recently started query is the one registerCancelSAB cancels
        this._pendingQueries.delete(conn);
        this._pendingQueries.add(conn);
        this.updateCancelWatcher();
    }
    /** The connection's pending query ended (it has a result, failed, or was cancelled) */
    protected endPendingQuery(conn: ConnectionID): void {
        this._pendingQueries.delete(conn);
        this.updateCancelWatcher();
    }
    /** Track the end of a pending query through the response to its start or a poll */
    protected async trackPendingQuery(
        conn: ConnectionID,
        response: Promise<Uint8Array | null>,
    ): Promise<Uint8Array | null> {
        try {
            const header = await response;
            if (header !== null) this.endPendingQuery(conn);
            return header;
        } catch (e) {
            this.endPendingQuery(conn);
            throw e;
        }
    }
    /** Forget all connections, the database they belonged to is gone */
    protected forgetConnections(): void {
        this._interruptHandles.clear();
        this._pendingQueries.clear();
        this.updateCancelWatcher();
    }
    /** Consume a cancel requested through registerCancelSAB */
    protected takeCancelFlag(): boolean {
        if (this._cancelFlag === null) return false;
        return Atomics.compareExchange(this._cancelFlag, 0, 1, 0) === 1;
    }
    /** Watch the flag of registerCancelSAB while a pending query runs */
    protected updateCancelWatcher(): void {
        const watch = this._cancelFlag !== null && this._pendingQueries.size > 0;
        if (watch && this._cancelWatcher === null) {
            this._cancelWatcher = setInterval(() => {
                let latest: ConnectionID | undefined;
                for (const conn of this._pendingQueries) latest = conn;
                if (latest === undefined || !this.takeCancelFlag()) return;
                this.cancelPendingQuery(latest).catch(e => console.error('[cancel-sab] cancelPendingQuery failed:', e));
            }, CANCEL_SAB_POLL_MS);
        } else if (!watch && this._cancelWatcher !== null) {
            clearInterval(this._cancelWatcher);
            this._cancelWatcher = null;
        }
    }

    /** Fetch query results */
    public async fetchQueryResults(conn: ConnectionID): Promise<Uint8Array | null> {
        const task = new WorkerTask<WorkerRequestType.FETCH_QUERY_RESULTS, ConnectionID, Uint8Array | null>(
            WorkerRequestType.FETCH_QUERY_RESULTS,
            conn,
        );
        return await this.postTask(task);
    }

    /** Get table names */
    public async getTableNames(conn: number, text: string): Promise<string[]> {
        const task = new WorkerTask<WorkerRequestType.GET_TABLE_NAMES, [number, string], string[]>(
            WorkerRequestType.GET_TABLE_NAMES,
            [conn, text],
        );
        return await this.postTask(task);
    }

    /** Prepare a statement and return its identifier */
    public async createPrepared(conn: number, text: string): Promise<number> {
        const task = new WorkerTask<WorkerRequestType.CREATE_PREPARED, [number, string], number>(
            WorkerRequestType.CREATE_PREPARED,
            [conn, text],
        );
        return await this.postTask(task);
    }
    /** Close a prepared statement */
    public async closePrepared(conn: number, statement: number): Promise<void> {
        const task = new WorkerTask<WorkerRequestType.CLOSE_PREPARED, [number, number], null>(
            WorkerRequestType.CLOSE_PREPARED,
            [conn, statement],
        );
        await this.postTask(task);
    }
    /** Execute a prepared statement and return the full result */
    public async runPrepared(conn: number, statement: number, params: any[]): Promise<Uint8Array> {
        const task = new WorkerTask<WorkerRequestType.RUN_PREPARED, [ConnectionID, number, any[]], Uint8Array>(
            WorkerRequestType.RUN_PREPARED,
            [conn, statement, params],
        );
        return await this.postTask(task);
    }
    /** Execute a prepared statement and stream the result */
    public async sendPrepared(conn: number, statement: number, params: any[]): Promise<Uint8Array> {
        const task = new WorkerTask<WorkerRequestType.SEND_PREPARED, [ConnectionID, number, any[]], Uint8Array>(
            WorkerRequestType.SEND_PREPARED,
            [conn, statement, params],
        );
        return await this.postTask(task);
    }
    /** Glob file infos */
    public async globFiles(path: string): Promise<WebFile[]> {
        const task = new WorkerTask<WorkerRequestType.GLOB_FILE_INFOS, string, WebFile[]>(
            WorkerRequestType.GLOB_FILE_INFOS,
            path,
        );
        return await this.postTask(task);
    }
    /** Register file text */
    public async registerFileText(name: string, text: string): Promise<void> {
        const buffer = TEXT_ENCODER.encode(text);
        await this.registerFileBuffer(name, buffer);
    }
    /** Register a file path. */
    public async registerFileURL(
        name: string,
        url: string,
        proto: DuckDBDataProtocol,
        directIO: boolean,
    ): Promise<void> {
        if (url === undefined) {
            url = name;
        }
        const task = new WorkerTask<
            WorkerRequestType.REGISTER_FILE_URL,
            [string, string, DuckDBDataProtocol, boolean],
            null
        >(WorkerRequestType.REGISTER_FILE_URL, [name, url, proto, directIO]);
        await this.postTask(task);
    }

    /** Register an empty file buffer. */
    public async registerEmptyFileBuffer(name: string): Promise<void> {
        /*
        const task = new WorkerTask<WorkerRequestType.REGISTER_FILE_BUFFER, [string, Uint8Array], null>(
            WorkerRequestType.REGISTER_FILE_BUFFER,
            [name, new Uint8Array()],
        );
        await this.postTask(task);
*/
    }

    /** Register a file buffer. */
    public async registerFileBuffer(name: string, buffer: Uint8Array): Promise<void> {
        const task = new WorkerTask<WorkerRequestType.REGISTER_FILE_BUFFER, [string, Uint8Array], null>(
            WorkerRequestType.REGISTER_FILE_BUFFER,
            [name, buffer],
        );
        await this.postTask(task, [buffer.buffer]);
    }

    /** Register a file handle. */
    public async registerFileHandle<HandleType>(
        name: string,
        handle: HandleType,
        protocol: DuckDBDataProtocol,
        directIO: boolean,
    ): Promise<void> {
        const task = new WorkerTask<
            WorkerRequestType.REGISTER_FILE_HANDLE,
            [string, any, DuckDBDataProtocol, boolean],
            null
        >(WorkerRequestType.REGISTER_FILE_HANDLE, [name, handle, protocol, directIO]);
        await this.postTask(task, []);
    }

    /** Prepare an opfs:// file (or the files a glob pattern matches) for the next queries, returns their names.
     * Registered files are held open until they are dropped, for writing unless `mode` is 'read' */
    public async registerOPFSFileName(name: string, mode: OPFSAccessMode = 'write'): Promise<string[]> {
        const task = new WorkerTask<WorkerRequestType.REGISTER_OPFS_FILE_NAME, [string, OPFSAccessMode], string[]>(
            WorkerRequestType.REGISTER_OPFS_FILE_NAME,
            [name, mode],
        );
        return await this.postTask(task, []);
    }

    /** Enable file statistics */
    public async collectFileStatistics(name: string, enable: boolean): Promise<void> {
        const task = new WorkerTask<WorkerRequestType.COLLECT_FILE_STATISTICS, [string, boolean], null>(
            WorkerRequestType.COLLECT_FILE_STATISTICS,
            [name, enable],
        );
        await this.postTask(task, []);
    }

    /** Export file statistics */
    public async exportFileStatistics(name: string): Promise<FileStatistics> {
        const task = new WorkerTask<WorkerRequestType.EXPORT_FILE_STATISTICS, string, FileStatistics>(
            WorkerRequestType.EXPORT_FILE_STATISTICS,
            name,
        );
        return await this.postTask(task, []);
    }

    /** Copy a file to a buffer. */
    public async copyFileToBuffer(name: string): Promise<Uint8Array> {
        const task = new WorkerTask<WorkerRequestType.COPY_FILE_TO_BUFFER, string, Uint8Array>(
            WorkerRequestType.COPY_FILE_TO_BUFFER,
            name,
        );
        return await this.postTask(task);
    }

    /** Copy a file to a path. */
    public async copyFileToPath(name: string, path: string): Promise<void> {
        const task = new WorkerTask<WorkerRequestType.COPY_FILE_TO_PATH, [string, string], null>(
            WorkerRequestType.COPY_FILE_TO_PATH,
            [name, path],
        );
        await this.postTask(task);
    }

    /** Insert arrow from an ipc stream */
    public async insertArrowFromIPCStream(
        conn: ConnectionID,
        buffer: Uint8Array,
        options?: ArrowInsertOptions,
    ): Promise<void> {
        if (buffer.length == 0) return;
        // Pass to the worker
        const task = new WorkerTask<
            WorkerRequestType.INSERT_ARROW_FROM_IPC_STREAM,
            [number, Uint8Array, ArrowInsertOptions | undefined],
            null
        >(WorkerRequestType.INSERT_ARROW_FROM_IPC_STREAM, [conn, buffer, options]);
        await this.postTask(task, [buffer.buffer]);
    }
    /** Insert a csv file */
    public async insertCSVFromPath(conn: ConnectionID, path: string, options: CSVInsertOptions): Promise<void> {
        // Flatten the table options
        if (options.columns !== undefined) {
            const out = [];
            for (const k in options.columns) {
                const type = options.columns[k];
                out.push(arrowToSQLField(k, type));
            }
            options.columnsFlat = out;
            delete options.columns;
        }

        // Pass to the worker
        const task = new WorkerTask<WorkerRequestType.INSERT_CSV_FROM_PATH, [number, string, CSVInsertOptions], null>(
            WorkerRequestType.INSERT_CSV_FROM_PATH,
            [conn, path, options],
        );
        await this.postTask(task);
    }
    /** Insert a json file */
    public async insertJSONFromPath(conn: ConnectionID, path: string, options: JSONInsertOptions): Promise<void> {
        // Flatten the table options
        if (options.columns !== undefined) {
            const out = [];
            for (const k in options.columns) {
                const type = options.columns[k];
                out.push(arrowToSQLField(k, type));
            }
            options.columnsFlat = out;
            delete options.columns;
        }

        // Pass to the worker
        const task = new WorkerTask<WorkerRequestType.INSERT_JSON_FROM_PATH, [number, string, JSONInsertOptions], null>(
            WorkerRequestType.INSERT_JSON_FROM_PATH,
            [conn, path, options],
        );
        await this.postTask(task);
    }

    /** opfs:// files named in SQL are prepared ahead of the query when the config asks for it, whether the
     * database itself lives in OPFS or not */
    private shouldOPFSFileHandling(): boolean {
        return this.config.opfs?.fileHandling == 'auto';
    }

    private async registerOPFSFileFromSQL(text: string) {
        const files = searchOPFSFiles(text);
        // A database that is attached is written to, everything else is read
        const mode: OPFSAccessMode = /\bATTACH\b/i.test(text) ? 'write' : 'read';
        const result: string[] = [];
        for (const file of files) {
            try {
                result.push(...(await this.registerOPFSFileName(file, mode)));
            } catch (e) {
                console.error(e);
                throw new Error('File Not found:' + file);
            }
        }
        return result;
    }
}
