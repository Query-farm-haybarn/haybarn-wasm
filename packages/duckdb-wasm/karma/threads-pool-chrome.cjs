// Haybarn: extension loads and the pthread pool on the threads bundle (test/index_threads_pool.ts), against the
// published Haybarn extension repository, cross-origin isolated. Needs network access to haybarn-extensions.query.farm.
// POOL_ITERATIONS sets the fresh instances of the load stress test (default 20), POOL_BRACKET=1 keeps the bindings'
// SET threads=1 bracket around explicit loads.
const base = require('./karma.base.cjs');
const fs = require('fs');
const path = require('path');

// /fault/<token>/<n>[,<n>...]/<file> serves packages/duckdb-wasm/dist/<file>, except that the n-th request of a
// token (counting from 1) breaks off after the headers and the first bytes, as a proxy whose upstream reset the
// connection does (karma's own proxy logged exactly that before the CI hang). A connection reset before any response
// would be retried by the browser. A threads-bundle instance whose worker is loaded from there requests the same URL
// for its engine worker (request 1) and every pthread worker (2 and on).
const faultCounts = new Map();
function pthreadScriptFault() {
    const dist = path.resolve(__dirname, '../dist');
    return (req, res, next) => {
        const m = /^\/fault\/([\w-]+)\/([\d,]+)\/([\w.-]+)$/.exec(req.url.split('?')[0]);
        if (!m) return next();
        const [, token, failing, file] = m;
        const count = (faultCounts.get(token) || 0) + 1;
        faultCounts.set(token, count);
        const body = fs.readFileSync(path.join(dist, file));
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Content-Length', body.length);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        if (failing.split(',').map(Number).includes(count)) {
            res.write(body.subarray(0, 4096), () => res.destroy());
            return;
        }
        res.end(body);
    };
}

module.exports = config => {
    const cfg = base(config);
    config.set({
        ...cfg,
        frameworks: ['jasmine'],
        plugins: [...cfg.plugins, { 'middleware:pthreadScriptFault': ['factory', pthreadScriptFault] }],
        beforeMiddleware: ['pthreadScriptFault'],
        files: [
            { pattern: 'packages/duckdb-wasm/dist/tests-threads-pool.js' },
            { pattern: 'packages/duckdb-wasm/dist/*.wasm', included: false, watched: false },
            { pattern: 'packages/duckdb-wasm/dist/*.js', included: false, watched: false },
            { pattern: 'data/uni/*.parquet', included: false, watched: false },
        ],
        preprocessors: {},
        reporters: ['spec'],
        customHeaders: [
            { match: '.*', name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
            { match: '.*', name: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
        client: {
            args: [`iterations=${process.env.POOL_ITERATIONS || '20'}`, `bracket=${process.env.POOL_BRACKET || '0'}`],
            captureConsole: true,
            jasmine: { failFast: false, random: false, timeoutInterval: 3600000 },
        },
        captureTimeout: 60000,
        browserDisconnectTimeout: 10000,
        browserDisconnectTolerance: 0,
        browserNoActivityTimeout: 3600000,
        processKillTimeout: 10000,
    });
};
