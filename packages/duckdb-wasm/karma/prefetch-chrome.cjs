// Haybarn: extension prefetch on both bundles (test/index_prefetch.ts), on a cross-origin isolated page so the threads
// bundle runs. Needs network access to haybarn-extensions.query.farm for the published-repository specs.
const base = require('./karma.base.cjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Haybarn: a repository of the local extensions (build/extension_repository), signed with a throwaway RSA key made
// when the server starts, so signature checks run against extensions of this build. Never a real Haybarn key: the
// tests trust this one with CREATE EXTENSION REPOSITORY.
//
//   /haybarn-ext/key                  the public key, base64 DER (SubjectPublicKeyInfo)
//   /haybarn-ext/signed/<v>/<p>/<f>   the local extension, signed
//   /haybarn-ext/tampered/<v>/<p>/<f> the same, with a byte of the code flipped after signing
//   /haybarn-ext/stall/<v>/<p>/<f>    the first GET of each file sends its headers and never its body; the next ones
//                                     get the signed file
//   /haybarn-ext/log                  GET counts by path; /haybarn-ext/reset clears them
const REPOSITORY = path.resolve(__dirname, '../../../build/extension_repository');
const SIGNATURE_SIZE = 256;
const CHUNK = 1024 * 1024;
/** DER prefix of a PKCS#1 v1.5 DigestInfo for SHA-256 */
const SHA256_DIGEST_INFO = Buffer.from('3031300d060960864801650304020105000420', 'hex');

/** The engine's two-level hash: SHA-256 over the SHA-256 of each 1 MiB chunk before the signature */
function twoLevelHash(bytes) {
    const end = bytes.length - SIGNATURE_SIZE;
    const digests = [];
    for (let offset = 0; offset < end; offset += CHUNK) {
        digests.push(crypto.createHash('sha256').update(bytes.subarray(offset, Math.min(end, offset + CHUNK))).digest());
    }
    return crypto.createHash('sha256').update(Buffer.concat(digests)).digest();
}

function extensionServer() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const signed = new Map();
    const sign = file => {
        let bytes = signed.get(file);
        if (!bytes) {
            bytes = Buffer.from(fs.readFileSync(file));
            // What `openssl pkeyutl -sign -pkeyopt digest:sha256` does with the hash, as the engine expects
            const signature = crypto.privateEncrypt(
                { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
                Buffer.concat([SHA256_DIGEST_INFO, twoLevelHash(bytes)]),
            );
            signature.copy(bytes, bytes.length - SIGNATURE_SIZE);
            signed.set(file, bytes);
        }
        return bytes;
    };
    let counts = {};
    const stalled = new Set();
    return (request, response, next) => {
        const url = new URL(request.url, 'http://localhost');
        if (!url.pathname.startsWith('/haybarn-ext/')) {
            return next();
        }
        const noStore = { 'Cache-Control': 'no-store' };
        if (url.pathname === '/haybarn-ext/key') {
            response.writeHead(200, { ...noStore, 'Content-Type': 'text/plain' });
            response.end(publicKeyBase64);
            return;
        }
        if (url.pathname === '/haybarn-ext/log') {
            response.writeHead(200, { ...noStore, 'Content-Type': 'application/json' });
            response.end(JSON.stringify(counts));
            return;
        }
        if (url.pathname === '/haybarn-ext/reset') {
            counts = {};
            stalled.clear();
            response.writeHead(204);
            response.end();
            return;
        }
        const match = /^\/haybarn-ext\/(signed|tampered|stall)\/(.+\.duckdb_extension\.wasm)$/.exec(url.pathname);
        const file = match && path.join(REPOSITORY, path.normalize(match[2]));
        if (!match || !file.startsWith(REPOSITORY + path.sep) || !fs.existsSync(file)) {
            response.writeHead(404, noStore);
            response.end();
            return;
        }
        if (request.method === 'GET') {
            counts[url.pathname] = (counts[url.pathname] || 0) + 1;
        }
        let bytes = sign(file);
        if (match[1] === 'tampered') {
            bytes = Buffer.from(bytes);
            bytes[bytes.length >> 1] ^= 0xff;
        }
        response.writeHead(200, { ...noStore, 'Content-Type': 'application/wasm', 'Content-Length': bytes.length });
        if (match[1] === 'stall' && !stalled.has(url.pathname)) {
            stalled.add(url.pathname);
            response.flushHeaders();
            return;
        }
        response.end(request.method === 'HEAD' ? undefined : bytes);
    };
}

module.exports = config => {
    const cfg = base(config);
    config.set({
        ...cfg,
        frameworks: ['jasmine'],
        plugins: [...cfg.plugins, { 'middleware:haybarn-ext': ['factory', extensionServer] }],
        middleware: ['haybarn-ext'],
        files: [
            { pattern: 'packages/duckdb-wasm/dist/tests-prefetch.js' },
            { pattern: 'packages/duckdb-wasm/dist/*.wasm', included: false, watched: false, served: true },
            { pattern: 'packages/duckdb-wasm/dist/*.js', included: false, watched: false, served: true },
        ],
        preprocessors: {},
        reporters: ['spec'],
        customHeaders: [
            { match: '.*', name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
            { match: '.*', name: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
        client: { jasmine: { failFast: false, random: false, timeoutInterval: 180000 } },
        browserNoActivityTimeout: 240000,
    });
};
