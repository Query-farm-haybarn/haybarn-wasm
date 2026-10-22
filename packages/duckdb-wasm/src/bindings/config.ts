export interface DuckDBQueryConfig {
    /**
     * The polling interval for queries
     */
    queryPollingInterval?: number;
    /**
     * Cast BigInt to Double?
     */
    castBigIntToDouble?: boolean;
    /**
     * Cast Timestamp to Date64?
     */
    castTimestampToDate?: boolean;
    /**
     * Cast Timestamp to Date64?
     */
    castDurationToTime64?: boolean;
    /**
     * Cast Decimal to Double?
     */
    castDecimalToDouble?: boolean;
}

export interface DuckDBFilesystemConfig {
    reliableHeadRequests?: boolean;
    /**
     * Allow falling back to full HTTP reads if the server does not support range requests.
     */
    allowFullHTTPReads?: boolean;
    /**
     * Force use of full HTTP reads, suppressing range requests.
     */
    forceFullHTTPReads?: boolean;
}

export interface DuckDBOPFSConfig {
    /**
     * Defines how `opfs://` files are handled during SQL execution.
     * - "auto": Automatically register `opfs://` files and drop them after execution.
     * - "manual": Files must be manually registered and dropped.
     */
    fileHandling?: "auto" | "manual";
}

export enum DuckDBAccessMode {
    UNDEFINED = 0,
    AUTOMATIC = 1,
    READ_ONLY = 2,
    READ_WRITE = 3,
}

export interface DuckDBConfig {
    /**
     * The database path
     */
    path?: string;
    /**
     * The access mode
     */
    accessMode?: DuckDBAccessMode;
    /**
     * Spill data that does not fit in memory to the temporary directory, js_buffer://tmp by default:
     * buffers held by the runtime outside the WASM heap. Enabled unless set to false.
     */
    spill?: boolean;
    /**
     * The temporary directory of DuckDB, overrides the default of the runtime
     */
    temporaryDirectory?: string;
    /**
     * The home directory of DuckDB, opfs://home where the browser has an origin private file system: what DuckDB
     * stores next to the user (persistent secrets) persists across sessions
     */
    homeDirectory?: string;
    /**
     * The repository extensions are loaded from (custom_extension_repository), the Haybarn core repository
     * (haybarn-extensions.query.farm/core) by default
     */
    extensionRepository?: string;
    /**
     * The maximum number of threads.
     * Note that this will only work with cross-origin isolated sites since it requires SharedArrayBuffers.
     */
    maximumThreads?: number;
    /**
     * The direct io flag
     */
    useDirectIO?: boolean;
    /**
     * The query config
     */
    query?: DuckDBQueryConfig;
    /**
     * The filesystem config
     */
    filesystem?: DuckDBFilesystemConfig;
    /**
     * Whether to allow unsigned extensions
     */
    allowUnsignedExtensions?: boolean;
    /**
     * Whether to use alternate Arrow conversion that preserves full range and precision of data.
     */
    arrowLosslessConversion?: boolean;
    /**
     * Custom user agent string
     */
    customUserAgent?: string;
    /**
     * opfs string
     */
    opfs?: DuckDBOPFSConfig;
    /**
     * Haybarn: run extension `LOAD`/`INSTALL` statements with the task scheduler pinned to a single thread.
     *
     * When enabled, the bindings bracket each statement that starts with `LOAD`/`INSTALL` with `SET threads=1` ...
     * `SET threads=<previous>`. It was the workaround for an intermittent deadlock of extension loads on the threads
     * bundle: the query thread spun while a scheduler thread ran the load, so it never synced the side module the
     * main thread opened. The engine now waits instead of spinning (`wait_for_tasks_instead_of_spinning.patch`), and
     * loads, autoloads inside queries included, no longer need the bracket.
     *
     * Defaults to disabled. A no-op on the base bundle and whenever `threads` is already 1.
     */
    singleThreadedExtensionLoad?: boolean;
}
