import { createHash } from 'crypto';
import {
    computeExtensionHash,
    prefetchExtensions,
    takePrefetchedExtension,
} from '../src/parallel/extension_prefetch';

/** The engine's two-level hash: SHA-256 over the SHA-256 of each 1 MB chunk, excluding the 256-byte signature */
function engineHash(bytes: Uint8Array): Uint8Array {
    const end = bytes.byteLength - 256;
    const chunkHashes: Buffer[] = [];
    for (let offset = 0; offset < end; offset += 1 << 20) {
        chunkHashes.push(
            createHash('sha256')
                .update(bytes.subarray(offset, Math.min(end, offset + (1 << 20))))
                .digest(),
        );
    }
    return new Uint8Array(createHash('sha256').update(Buffer.concat(chunkHashes)).digest());
}

function pseudoRandomBytes(n: number): Uint8Array {
    const bytes = new Uint8Array(n);
    let x = 0x12345678;
    for (let i = 0; i < n; ++i) {
        x = (x * 1103515245 + 12345) >>> 0;
        bytes[i] = x >>> 24;
    }
    return bytes;
}

export function testExtensionPrefetch(): void {
    const hasWebCrypto = typeof crypto !== 'undefined' && !!crypto.subtle;

    describe('Extension prefetch', () => {
        it('hashes like the engine', async () => {
            if (!hasWebCrypto) {
                pending('no WebCrypto');
                return;
            }
            // Sizes around the 1 MB chunk boundary, with and without a partial last chunk
            for (const size of [300, (1 << 20) + 256, (1 << 20) + 257, 2.5 * (1 << 20) + 256]) {
                const bytes = pseudoRandomBytes(size);
                const hash = await computeExtensionHash(bytes);
                expect(hash).not.toBeNull();
                expect(Buffer.from(hash!).toString('hex')).toEqual(Buffer.from(engineHash(bytes)).toString('hex'));
            }
        });

        it('serves each prefetched file to one LOAD', async () => {
            if (!hasWebCrypto) {
                pending('no WebCrypto');
                return;
            }
            const bytes = pseudoRandomBytes(4096);
            const url = `data:application/wasm;base64,${Buffer.from(bytes).toString('base64')}`;
            await prefetchExtensions([url]);
            const entry = takePrefetchedExtension(url);
            expect(entry).not.toBeNull();
            expect(Buffer.from(entry!.bytes).equals(Buffer.from(bytes))).toBeTrue();
            expect(Buffer.from(entry!.hash!).toString('hex')).toEqual(Buffer.from(engineHash(bytes)).toString('hex'));
            expect(takePrefetchedExtension(url)).toBeNull();
        });

        it('leaves failed downloads to LOAD', async () => {
            const url = 'http://127.0.0.1:9/no-such-extension.duckdb_extension.wasm';
            await prefetchExtensions([url]);
            expect(takePrefetchedExtension(url)).toBeNull();
        });
    });
}
