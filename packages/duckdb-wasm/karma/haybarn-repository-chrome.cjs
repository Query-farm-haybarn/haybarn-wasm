// Haybarn: the loadable base/threads bundles against the published Haybarn extension repository
// (test/index_haybarn_repository.ts). Needs network access to haybarn-extensions.query.farm.
const base = require('./karma.base.cjs');

module.exports = config => {
    const cfg = base(config);
    config.set({
        ...cfg,
        frameworks: ['jasmine'],
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
