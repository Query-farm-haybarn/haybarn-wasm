// Haybarn: the platform functions for extensions on both bundles (test/index_platform.ts), through the test extension
// of the local repository, on a cross-origin isolated page so the threads bundle runs. Serves the VGI worker of the
// tests with the ring model it imports, and the app's OAuth callback page.
const base = require('./karma.base.cjs');

module.exports = config => {
    const cfg = base(config);
    config.set({
        ...cfg,
        frameworks: ['jasmine'],
        files: [
            { pattern: 'packages/duckdb-wasm/dist/tests-platform.js' },
            { pattern: 'packages/duckdb-wasm/dist/*.wasm', included: false, watched: false, served: true },
            { pattern: 'packages/duckdb-wasm/dist/*.js', included: false, watched: false, served: true },
            { pattern: 'build/extension_repository/**/*.wasm', included: false, watched: false, served: true },
            { pattern: 'packages/duckdb-wasm/test/vgi_echo_worker.js', included: false, watched: false, served: true },
            { pattern: 'lib/vgi-sab-ring.js', included: false, watched: false, served: true },
            { pattern: 'packages/duckdb-wasm-app/static/oauth-*', included: false, watched: false, served: true },
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
