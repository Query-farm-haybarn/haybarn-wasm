// Haybarn: prefetching of wasm extensions inside the worker.
//
// LOAD runs synchronously inside the engine: the extension provider (lib/src/extension_provider.cc) downloads the
// extension with a synchronous XHR and hashes it with SHA-256 compiled to wasm before checking its signature.
// Prefetching does that work ahead of time and asynchronously: all downloads run in parallel, the signature hash is
// computed with WebCrypto, and the module is compiled with WebAssembly.compileStreaming (which also lets Chrome cache
// the compiled code). The provider takes the entry for its URL, so it only has to check the RSA signature against the
// hash, and dlopen instantiates the compiled module once that check has passed (scripts/patch_dylink_glue.cjs).
//
// The hash is computed here over exactly the bytes the provider is given, and neither ever leaves this worker, so
// this trusts nothing the synchronous path didn't already trust. The signature check itself stays in the engine.
//
// This runs in the worker's event loop, between requests: the dispatcher processes requests in order, so a request
// sent while a prefetch runs waits for it. On the threads bundle the provider fetches on the main runtime thread,
// which is this one, so the entries are where it looks for them.

/** The size of the signature at the end of an extension file */
const SIGNATURE_SIZE = 256;
/** The chunk size of the two-level hash. Must match the engine's verifier (extension_load.cpp). */
const HASH_CHUNK_SIZE = 1024 * 1024;
/** The most bytes held for LOADs that haven't taken them; prefetches beyond it are left to LOAD */
const MAX_HELD_BYTES = 256 * 1024 * 1024;
/** How long a download may take before it is left to LOAD. Requests wait for prefetches, so one must never hang. */
export const PREFETCH_TIMEOUT_MS = 30_000;

/** A prefetched extension */
export interface PrefetchedExtension {
    /** The file, as LOAD would have downloaded it */
    bytes: Uint8Array;
    /** SHA-256 over the SHA-256 hashes of each 1 MiB chunk of the file without its signature */
    hash: Uint8Array | null;
    /** The module compiled from the same download, or null */
    module: WebAssembly.Module | null;
}

/** Prefetched extensions by URL, until a LOAD takes them */
const prefetched = new Map<string, PrefetchedExtension>();
/** Prefetches that are still running, by URL */
const running = new Map<string, Promise<boolean>>();
/** The bytes held in `prefetched` */
let heldBytes = 0;
/** Bumped by clearPrefetchedExtensions, so prefetches still running then don't add their entries after it */
let generation = 0;

/** Compute the engine's two-level signature hash of an extension file */
export async function computeExtensionHash(bytes: Uint8Array): Promise<Uint8Array | null> {
    if (bytes.byteLength < SIGNATURE_SIZE || typeof crypto === 'undefined' || !crypto.subtle) {
        return null;
    }
    const end = bytes.byteLength - SIGNATURE_SIZE;
    const chunks: Promise<ArrayBuffer>[] = [];
    for (let offset = 0; offset < end; offset += HASH_CHUNK_SIZE) {
        chunks.push(crypto.subtle.digest('SHA-256', bytes.subarray(offset, Math.min(end, offset + HASH_CHUNK_SIZE))));
    }
    const hashes = await Promise.all(chunks);
    const concatenated = new Uint8Array(hashes.length * 32);
    hashes.forEach((h, i) => concatenated.set(new Uint8Array(h), i * 32));
    return new Uint8Array(await crypto.subtle.digest('SHA-256', concatenated));
}

/**
 * Download, hash and compile one extension. Resolves to whether it is now held for LOAD. Failures are dropped: LOAD
 * then downloads it itself and reports the error.
 */
async function prefetchOne(url: string, timeoutMs: number): Promise<boolean> {
    const startedIn = generation;
    try {
        // The signal also aborts reading the body, and with it the compile
        const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
        const response = await fetch(url, { signal });
        // LOAD's XHR only accepts 200
        if (response.status !== 200) {
            return false;
        }
        // Compile from the response itself and read the bytes from a clone, so both come from one download. Without a
        // module, dlopen compiles the bytes as before.
        let compiling: Promise<WebAssembly.Module | null> = Promise.resolve(null);
        let body = response;
        if (typeof WebAssembly.compileStreaming === 'function') {
            body = response.clone();
            compiling = WebAssembly.compileStreaming(response).catch(() => null);
        }
        const bytes = new Uint8Array(await body.arrayBuffer());
        // Without a hash the provider hashes the file itself
        const [hash, module] = await Promise.all([computeExtensionHash(bytes).catch(() => null), compiling]);
        if (generation !== startedIn || heldBytes + bytes.byteLength > MAX_HELD_BYTES) {
            return false;
        }
        prefetched.set(url, { bytes, hash, module });
        heldBytes += bytes.byteLength;
        return true;
    } catch (e) {
        // Network error or timeout: leave it to LOAD
        return false;
    } finally {
        running.delete(url);
    }
}

/**
 * Prefetch extensions by URL. Resolves to the URLs that are held for LOAD once every download has finished, failed
 * or timed out; never rejects.
 */
export async function prefetchExtensions(urls: string[], timeoutMs: number = PREFETCH_TIMEOUT_MS): Promise<string[]> {
    installPrefetchHook();
    const work: Promise<boolean>[] = [];
    for (const url of urls) {
        if (prefetched.has(url)) {
            work.push(Promise.resolve(true));
            continue;
        }
        let p = running.get(url);
        if (!p) {
            p = prefetchOne(url, timeoutMs);
            running.set(url, p);
        }
        work.push(p);
    }
    const held = await Promise.all(work);
    return urls.filter((_, i) => held[i]);
}

/** Take the prefetched entry for a URL. Called by the provider's LOAD; each entry serves one LOAD. */
export function takePrefetchedExtension(url: string): PrefetchedExtension | null {
    const entry = prefetched.get(url);
    if (!entry) {
        return null;
    }
    prefetched.delete(url);
    heldBytes -= entry.bytes.byteLength;
    return entry;
}

/** Drop prefetched extensions that no LOAD took, including those still downloading */
export function clearPrefetchedExtensions(): void {
    prefetched.clear();
    heldBytes = 0;
    ++generation;
}

/** Make the prefetched entries reachable from the provider's LOAD */
export function installPrefetchHook(): void {
    (globalThis as any).__haybarnTakePrefetchedExtension = takePrefetchedExtension;
}
