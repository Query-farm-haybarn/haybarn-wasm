import { DuckDBBindings, DuckDBDataProtocol } from '../bindings';
import { WorkerResponseVariant, WorkerRequestVariant, WorkerRequestType, WorkerResponseType } from './worker_request';
import { Logger, LogEntryVariant } from '../log';
import { InstantiationProgress } from '../bindings/progress';

/**
 * Cadence at which the SAB-cancel watcher polls the flag while a pending
 * query is active. 250 ms is responsive enough that user-perceived cancel
 * latency stays well under a frame budget while keeping idle CPU near zero.
 * The synchronous check at the top of POLL_PENDING_QUERY covers the
 * deterministic inter-poll case, so the interval only has to catch
 * cancellations that arrive while a single pollPendingQuery is running.
 */
const CANCEL_SAB_POLL_MS = 250;

export abstract class AsyncDuckDBDispatcher implements Logger {
    /** The bindings */
    protected _bindings: DuckDBBindings | null = null;
    /** The next message id */
    protected _nextMessageId = 0;
    /** Active SAB-cancel watcher (one query at a time; replaces if a new one starts) */
    private _cancelWatcher: ReturnType<typeof setInterval> | null = null;
    /** Connection id currently being watched for SAB cancellation */
    private _cancelConn: number | null = null;
    /**
     * Int32Array view of the SAB armed for the current watched query.
     *
     * Captured at watcher-arm time and used by BOTH the setInterval callback
     * AND the synchronous check at the top of POLL_PENDING_QUERY, so the two
     * paths always observe the same SAB even if the consumer re-registers a
     * new SAB while a query is in flight.
     */
    private _cancelInt32: Int32Array | null = null;

    /** Instantiate the wasm module */
    protected abstract instantiate(
        mainModule: string,
        pthreadWorker: string | null,
        progress: (p: InstantiationProgress) => void,
    ): Promise<DuckDBBindings>;
    /** Post a response to the main thread */
    protected abstract postMessage(response: WorkerResponseVariant, transfer: ArrayBuffer[]): void;

    /** Send log entry to the main thread */
    public log(entry: LogEntryVariant): void {
        this.postMessage(
            {
                messageId: this._nextMessageId++,
                requestId: 0,
                type: WorkerResponseType.LOG,
                data: entry,
            },
            [],
        );
    }

    /** Send plain OK without further data */
    protected sendOK(request: WorkerRequestVariant): void {
        this.postMessage(
            {
                messageId: this._nextMessageId++,
                requestId: request.messageId,
                type: WorkerResponseType.OK,
                data: null,
            },
            [],
        );
    }

    /**
     * Start watching the SAB-cancel flag for this connection.
     *
     * If init-cancel-sab has not been sent, no watcher is started — callers
     * fall through to the message-based CANCEL_PENDING_QUERY path. If a
     * watcher is already running it is replaced (single-query model: the
     * 4-byte SAB has no room for a connection id, so only the most recently
     * started pending query is SAB-cancellable). The Int32Array view is
     * captured into `_cancelInt32` at arm time so both the interval callback
     * and the synchronous check at the top of POLL_PENDING_QUERY observe the
     * same SAB even if the consumer re-registers a new SAB mid-query.
     *
     * The flag is intentionally NOT zeroed here: a flag=1 set between the
     * main thread's postMessage(START) and the worker dispatching START
     * represents legitimate user intent ("cancel this query I just started")
     * and must be observed. Stale flags from a throwing prior cancel will
     * cancel the next query — which is also the right behavior, since a
     * cancellation the user explicitly requested has not yet completed.
     */
    private _startCancelWatch(connId: number): void {
        const int32 = (globalThis as any).cancelInt32 as Int32Array | undefined;
        if (!int32) return;
        if (this._cancelWatcher !== null) {
            // Replacing a live watcher means a previously started pending
            // query is no longer SAB-cancellable. The Logger's variant union
            // has no slot for runtime warnings, so route through console.
            console.warn(
                '[cancel-sab] replacing live cancel watcher; only the most-recent pending query is SAB-cancellable',
            );
            clearInterval(this._cancelWatcher);
        }
        this._cancelConn = connId;
        this._cancelInt32 = int32;
        this._cancelWatcher = setInterval(() => {
            if (Atomics.load(int32, 0) !== 1) return;
            this._attemptCancel(int32, this._cancelConn);
        }, CANCEL_SAB_POLL_MS);
    }

    /**
     * Attempt to cancel the given connection's pending query.
     *
     * The flag is zeroed only after `cancelPendingQuery` returns successfully,
     * so a throwing binding leaves the flag set and the next watcher tick (or
     * the next POLL_PENDING_QUERY's synchronous check) gets another shot.
     */
    private _attemptCancel(int32: Int32Array, conn: number | null): void {
        if (conn === null || this._bindings === null) return;
        try {
            this._bindings.cancelPendingQuery(conn);
            Atomics.store(int32, 0, 0);
        } catch (e: any) {
            // Cancellation is best-effort; route through the logger so
            // consumers can observe it, but do not throw out of the callback.
            console.error('[cancel-sab] cancelPendingQuery threw:', e);
        }
    }

    /** Stop the SAB-cancel watcher, if any. Safe to call repeatedly. */
    private _stopCancelWatch(): void {
        if (this._cancelWatcher !== null) {
            clearInterval(this._cancelWatcher);
            this._cancelWatcher = null;
        }
        this._cancelConn = null;
        this._cancelInt32 = null;
    }

    /** Fail with an error */
    protected failWith(request: WorkerRequestVariant, e: Error): void {
        // Workaround for Firefox not being able to perform structured-clone on Native Errors
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1556604
        const obj: any = {
            name: e.name,
            message: e.message,
            stack: e.stack || undefined,
        };
        this.postMessage(
            {
                messageId: this._nextMessageId++,
                requestId: request.messageId,
                type: WorkerResponseType.ERROR,
                data: obj,
            },
            [],
        );
        return;
    }

    /** Process a request from the main thread */
    public async onMessage(request: WorkerRequestVariant): Promise<void> {
        // First process those requests that don't need bindings
        switch (request.type) {
            case WorkerRequestType.PING:
                this.sendOK(request);
                return;
            case WorkerRequestType.INSTANTIATE:
                if (this._bindings != null) {
                    this.failWith(request, new Error('duckdb already initialized'));
                }
                try {
                    this._bindings = await this.instantiate(request.data[0], request.data[1], p => {
                        this.postMessage(
                            {
                                messageId: this._nextMessageId++,
                                requestId: request.messageId,
                                type: WorkerResponseType.INSTANTIATE_PROGRESS,
                                data: p,
                            },
                            [],
                        );
                    });
                    this.sendOK(request);
                } catch (e: any) {
                    console.log(e);
                    this._bindings = null;
                    this.failWith(request, e);
                }
                return;
            default:
                break;
        }

        // Bindings not initialized?
        if (!this._bindings) {
            return this.failWith(request, new Error('duckdb is not initialized'));
        }

        // Catch every exception and forward it as error message to the main thread
        try {
            switch (request.type) {
                case WorkerRequestType.GET_VERSION:
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.VERSION_STRING,
                            data: this._bindings.getVersion(),
                        },
                        [],
                    );
                    break;
                case WorkerRequestType.GET_FEATURE_FLAGS:
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.FEATURE_FLAGS,
                            data: this._bindings.getFeatureFlags(),
                        },
                        [],
                    );
                    break;
                case WorkerRequestType.RESET:
                    // Dropping the database invalidates any conn the watcher
                    // is targeting; stop before the next tick can fire a
                    // cancel against freed memory.
                    this._stopCancelWatch();
                    this._bindings.reset();
                    this.sendOK(request);
                    break;

                case WorkerRequestType.OPEN: {
                    // Re-opening the database may replace the conn the
                    // watcher is targeting; stop before any subsequent tick.
                    this._stopCancelWatch();
                    const path = request.data.path;
                    if (path?.startsWith('opfs://')) {
                        await this._bindings.prepareDBFileHandle(path, DuckDBDataProtocol.BROWSER_FSACCESS);
                        request.data.useDirectIO = true;
                    }
                    this._bindings.open(request.data);
                    this.sendOK(request);
                    break;
                }
                case WorkerRequestType.DROP_FILE:
                    this._bindings.dropFile(request.data);
                    this.sendOK(request);
                    break;
                case WorkerRequestType.DROP_FILES:
                    this._bindings.dropFiles(request.data);
                    this.sendOK(request);
                    break;
                case WorkerRequestType.FLUSH_FILES:
                    this._bindings.flushFiles();
                    this.sendOK(request);
                    break;
                case WorkerRequestType.CONNECT: {
                    const conn = this._bindings.connect();
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.CONNECTION_INFO,
                            data: conn.useUnsafe((_, c) => c),
                        },
                        [],
                    );
                    break;
                }
                case WorkerRequestType.DISCONNECT:
                    if (this._cancelConn === request.data) {
                        this._stopCancelWatch();
                    }
                    this._bindings.disconnect(request.data);
                    this.sendOK(request);
                    break;
                case WorkerRequestType.CREATE_PREPARED: {
                    const result = this._bindings.createPrepared(request.data[0], request.data[1]);
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.PREPARED_STATEMENT_ID,
                            data: result,
                        },
                        [],
                    );
                    break;
                }
                case WorkerRequestType.CLOSE_PREPARED: {
                    this._bindings.closePrepared(request.data[0], request.data[1]);
                    this.sendOK(request);
                    break;
                }
                case WorkerRequestType.RUN_PREPARED: {
                    const result = this._bindings.runPrepared(request.data[0], request.data[1], request.data[2]);
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.QUERY_RESULT,
                            data: result,
                        },
                        [result.buffer],
                    );
                    break;
                }
                case WorkerRequestType.RUN_QUERY: {
                    const result = this._bindings.runQuery(request.data[0], request.data[1]);
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.QUERY_RESULT,
                            data: result,
                        },
                        [result.buffer],
                    );
                    break;
                }
                case WorkerRequestType.SEND_PREPARED: {
                    const result = this._bindings.sendPrepared(request.data[0], request.data[1], request.data[2]);
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.QUERY_RESULT_HEADER,
                            data: result,
                        },
                        [result.buffer],
                    );
                    break;
                }
                case WorkerRequestType.START_PENDING_QUERY: {
                    const connId = request.data[0];
                    this._startCancelWatch(connId);
                    const result = this._bindings.startPendingQuery(connId, request.data[1], request.data[2]);
                    if (result) {
                        // Header arrived immediately — no polling phase to cancel.
                        this._stopCancelWatch();
                    }
                    const transfer = [];
                    if (result) {
                        transfer.push(result.buffer);
                    }
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.QUERY_RESULT_HEADER_OR_NULL,
                            data: result,
                        },
                        transfer,
                    );
                    break;
                }
                case WorkerRequestType.POLL_PENDING_QUERY: {
                    // Synchronously check the SAB before doing work — covers
                    // the case where the worker's event loop has been too busy
                    // for the setInterval watcher to fire. Only act if this
                    // poll's conn matches the watched conn; otherwise an
                    // unrelated POLL on a different conn would consume the
                    // cancel signal intended for the watched query.
                    if (
                        this._cancelInt32 !== null &&
                        request.data === this._cancelConn &&
                        Atomics.load(this._cancelInt32, 0) === 1
                    ) {
                        this._attemptCancel(this._cancelInt32, this._cancelConn);
                    }
                    const result = this._bindings.pollPendingQuery(request.data);
                    if (result) {
                        // Pending query is done — stop watching.
                        this._stopCancelWatch();
                    }
                    const transfer = [];
                    if (result) {
                        transfer.push(result.buffer);
                    }
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.QUERY_RESULT_HEADER_OR_NULL,
                            data: result,
                        },
                        transfer,
                    );
                    break;
                }
                case WorkerRequestType.CANCEL_PENDING_QUERY: {
                    this._stopCancelWatch();
                    const result = this._bindings.cancelPendingQuery(request.data);
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.SUCCESS,
                            data: result,
                        },
                        [],
                    );
                    break;
                }
                case WorkerRequestType.FETCH_QUERY_RESULTS: {
                    const result = this._bindings.fetchQueryResults(request.data);
                    const transfer = result ? [result.buffer] : [];
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.QUERY_RESULT_CHUNK,
                            data: result,
                        },
                        transfer,
                    );
                    break;
                }
                case WorkerRequestType.GET_TABLE_NAMES: {
                    const result = this._bindings.getTableNames(request.data[0], request.data[1]);
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.TABLE_NAMES,
                            data: result,
                        },
                        [],
                    );
                    break;
                }
                case WorkerRequestType.GLOB_FILE_INFOS: {
                    const infos = this._bindings.globFiles(request.data);
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.FILE_INFOS,
                            data: infos,
                        },
                        [],
                    );
                    break;
                }

                case WorkerRequestType.REGISTER_FILE_URL:
                    this._bindings.registerFileURL(request.data[0], request.data[1], request.data[2], request.data[3]);
                    this.sendOK(request);
                    break;

                case WorkerRequestType.REGISTER_FILE_BUFFER:
                    this._bindings.registerFileBuffer(request.data[0], request.data[1]);
                    this.sendOK(request);
                    break;

                case WorkerRequestType.REGISTER_FILE_HANDLE:
                    await this._bindings.registerFileHandleAsync(
                        request.data[0],
                        request.data[1],
                        request.data[2],
                        request.data[3],
                    );
                    this.sendOK(request);
                    break;

                case WorkerRequestType.COPY_FILE_TO_PATH:
                    this._bindings.copyFileToPath(request.data[0], request.data[1]);
                    this.sendOK(request);
                    break;

                case WorkerRequestType.COPY_FILE_TO_BUFFER: {
                    const buffer = this._bindings.copyFileToBuffer(request.data);
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.FILE_BUFFER,
                            data: buffer,
                        },
                        [],
                    );
                    break;
                }
                case WorkerRequestType.COLLECT_FILE_STATISTICS:
                    this._bindings.collectFileStatistics(request.data[0], request.data[1]);
                    this.sendOK(request);
                    break;

                case WorkerRequestType.REGISTER_OPFS_FILE_NAME:
                    await this._bindings.registerOPFSFileName(request.data[0]);
                    this.sendOK(request);
                    break;

                case WorkerRequestType.EXPORT_FILE_STATISTICS: {
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.FILE_STATISTICS,
                            data: this._bindings.exportFileStatistics(request.data),
                        },
                        [],
                    );
                    break;
                }
                case WorkerRequestType.INSERT_ARROW_FROM_IPC_STREAM: {
                    this._bindings.insertArrowFromIPCStream(request.data[0], request.data[1], request.data[2]);
                    this.sendOK(request);
                    break;
                }
                case WorkerRequestType.INSERT_CSV_FROM_PATH: {
                    this._bindings.insertCSVFromPath(request.data[0], request.data[1], request.data[2]);
                    this.sendOK(request);
                    break;
                }
                case WorkerRequestType.INSERT_JSON_FROM_PATH: {
                    this._bindings.insertJSONFromPath(request.data[0], request.data[1], request.data[2]);
                    this.sendOK(request);
                    break;
                }
                case WorkerRequestType.TOKENIZE: {
                    const result = this._bindings.tokenize(request.data);
                    this.postMessage(
                        {
                            messageId: this._nextMessageId++,
                            requestId: request.messageId,
                            type: WorkerResponseType.SCRIPT_TOKENS,
                            data: result,
                        },
                        [],
                    );
                    break;
                }
            }
        } catch (e: any) {
            console.log(e);
            // Only disarm the cancel watcher if the failing request is the
            // one that armed it (START or POLL on the watched conn). An
            // unrelated request failing elsewhere must not affect a
            // legitimate in-flight pending query on another connection.
            if (this._cancelConn !== null) {
                if (
                    request.type === WorkerRequestType.START_PENDING_QUERY &&
                    Array.isArray(request.data) &&
                    request.data[0] === this._cancelConn
                ) {
                    this._stopCancelWatch();
                } else if (
                    request.type === WorkerRequestType.POLL_PENDING_QUERY &&
                    request.data === this._cancelConn
                ) {
                    this._stopCancelWatch();
                }
            }
            return this.failWith(request, e);
        }
    }
}
