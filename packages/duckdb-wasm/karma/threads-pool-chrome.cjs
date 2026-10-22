// Haybarn: extension loads and the pthread pool on the threads bundle (test/index_threads_pool.ts), against the
// published Haybarn extension repository, cross-origin isolated. Needs network access to haybarn-extensions.query.farm.
// POOL_ITERATIONS sets the fresh instances of the load stress test (default 20), POOL_BRACKET=1 keeps the bindings'
// SET threads=1 bracket around explicit loads.
const base = require('./karma.base.cjs');

module.exports = config => {
    const cfg = base(config);
    config.set({
        ...cfg,
        frameworks: ['jasmine'],
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
