// Haybarn: interrupting queries and reading their progress on both bundles (test/index_interrupt.ts), on a cross-origin
// isolated page so the threads bundle runs
const base = require('./karma.base.cjs');

module.exports = config => {
    const cfg = base(config);
    config.set({
        ...cfg,
        frameworks: ['jasmine'],
        files: [
            { pattern: 'packages/duckdb-wasm/dist/tests-interrupt.js' },
            { pattern: 'packages/duckdb-wasm/dist/*.wasm', included: false, watched: false, served: true },
            { pattern: 'packages/duckdb-wasm/dist/*.js', included: false, watched: false, served: true },
            { pattern: 'build/extension_repository/**/*.wasm', included: false, watched: false, served: true },
        ],
        preprocessors: {},
        reporters: ['spec'],
        customHeaders: [
            { match: '.*', name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
            { match: '.*', name: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
        client: { jasmine: { failFast: false, random: false, timeoutInterval: 120000 } },
        browserNoActivityTimeout: 180000,
    });
};
