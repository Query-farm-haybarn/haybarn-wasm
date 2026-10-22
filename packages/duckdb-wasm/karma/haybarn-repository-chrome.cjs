// Haybarn: the loadable base/threads bundles against the published Haybarn extension repository
// (test/index_haybarn_repository.ts). Needs network access to haybarn-extensions.query.farm.
const base = require('./karma.base.cjs');

// Haybarn: a fixture for the browser HTTP client. /haybarn-fixture/etag.csv has a strong ETag and answers a GET
// whose If-Match differs with 412, as a server that pins a range read's bytes does. Every request's headers are
// logged; /haybarn-fixture/log returns them and /haybarn-fixture/reset clears them.
const ETAG = '"abc-10"';
const CSV = Buffer.from('id,name\n1,duck\n2,goose\n3,swan\n');
function fixture() {
    let log = [];
    return (request, response, next) => {
        const path = request.url.split('?')[0];
        if (!path.startsWith('/haybarn-fixture/')) {
            return next();
        }
        if (path === '/haybarn-fixture/log') {
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify(log));
            return;
        }
        if (path === '/haybarn-fixture/reset') {
            log = [];
            response.writeHead(204);
            response.end();
            return;
        }
        const headers = {};
        for (let i = 0; i < request.rawHeaders.length; i += 2) {
            headers[request.rawHeaders[i].toLowerCase()] = request.rawHeaders[i + 1];
        }
        const entry = { method: request.method, path, headers, status: 0 };
        log.push(entry);
        const reply = (status, extra, body) => {
            entry.status = status;
            response.writeHead(status, extra);
            response.end(body);
        };
        if (path !== '/haybarn-fixture/etag.csv') {
            return reply(404, {}, undefined);
        }
        const common = {
            'Content-Type': 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            ETag: ETAG,
            'Cache-Control': 'no-store',
        };
        if (request.method === 'HEAD') {
            return reply(200, { ...common, 'Content-Length': CSV.length }, undefined);
        }
        if (headers['if-match'] !== undefined && headers['if-match'] !== ETAG) {
            return reply(412, { 'Content-Length': 0 }, undefined);
        }
        const range = /^bytes=(\d+)-(\d*)$/.exec(headers['range'] || '');
        if (range) {
            const begin = Number(range[1]);
            const end = Math.min(range[2] ? Number(range[2]) : CSV.length - 1, CSV.length - 1);
            const body = CSV.subarray(begin, end + 1);
            return reply(
                206,
                { ...common, 'Content-Length': body.length, 'Content-Range': `bytes ${begin}-${end}/${CSV.length}` },
                body,
            );
        }
        return reply(200, { ...common, 'Content-Length': CSV.length }, CSV);
    };
}

module.exports = config => {
    const cfg = base(config);
    config.set({
        ...cfg,
        frameworks: ['jasmine'],
        plugins: [...cfg.plugins, { 'middleware:haybarn-fixture': ['factory', fixture] }],
        middleware: ['haybarn-fixture'],
        files: [
            { pattern: 'packages/duckdb-wasm/dist/tests-haybarn-repository.js' },
            { pattern: 'packages/duckdb-wasm/dist/*.wasm', included: false, watched: false },
            { pattern: 'packages/duckdb-wasm/dist/*.js', included: false, watched: false },
            { pattern: 'data/uni/*.parquet', included: false, watched: false },
        ],
        preprocessors: {},
        reporters: ['spec'],
        // The threads bundle needs a cross-origin isolated page; the repository serves
        // Cross-Origin-Resource-Policy: cross-origin, so its extensions still load under require-corp
        customHeaders: [
            { match: '.*', name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
            { match: '.*', name: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
        client: { jasmine: { failFast: false, random: false, timeoutInterval: 160000 } },
        captureTimeout: 60000,
        browserDisconnectTimeout: 10000,
        browserDisconnectTolerance: 0,
        browserNoActivityTimeout: 170000,
        processKillTimeout: 10000,
    });
};
