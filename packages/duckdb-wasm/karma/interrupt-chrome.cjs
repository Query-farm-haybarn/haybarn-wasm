// Haybarn: interrupting queries and reading their progress on both bundles (test/index_interrupt.ts), on a cross-origin
// isolated page so the threads bundle runs
const base = require('./karma.base.cjs');

// Haybarn: a slow server for the HTTP client. /haybarn-slow/<name>.csv serves a small CSV; a GET waits `delay` ms
// before it answers, sends one byte every `trickle` ms, or stops after its headers with `stall=1`. A HEAD answers at
// once. Every request is logged with whether the client went away before the response ended (`aborted`);
// /haybarn-slow/log returns the log and /haybarn-slow/reset clears it.
const CSV = Buffer.from('a\n1\n2\n');
function slowServer() {
    let log = [];
    return (request, response, next) => {
        const url = new URL(request.url, 'http://localhost');
        if (!url.pathname.startsWith('/haybarn-slow/')) {
            return next();
        }
        if (url.pathname === '/haybarn-slow/log') {
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify(log));
            return;
        }
        if (url.pathname === '/haybarn-slow/reset') {
            log = [];
            response.writeHead(204);
            response.end();
            return;
        }
        const headers = {};
        for (let i = 0; i < request.rawHeaders.length; i += 2) {
            headers[request.rawHeaders[i].toLowerCase()] = request.rawHeaders[i + 1];
        }
        const entry = { method: request.method, path: url.pathname, query: url.search, headers, aborted: false };
        log.push(entry);
        let ended = false;
        const timers = [];
        response.on('close', () => {
            timers.forEach(clearTimeout);
            if (!ended) entry.aborted = true;
        });
        const common = {
            'Content-Type': 'text/csv',
            'Content-Length': CSV.length,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
        };
        if (request.method === 'HEAD') {
            response.writeHead(200, common);
            ended = true;
            response.end();
            return;
        }
        const delay = Number(url.searchParams.get('delay') || 0);
        const trickle = Number(url.searchParams.get('trickle') || 0);
        const stall = url.searchParams.get('stall') === '1';
        // A range read gets the whole (small) file as 206
        const range = /^bytes=(\d+)-(\d*)$/.exec(headers['range'] || '');
        const begin = range ? Number(range[1]) : 0;
        const end = range && range[2] ? Math.min(Number(range[2]), CSV.length - 1) : CSV.length - 1;
        const body = CSV.subarray(begin, end + 1);
        const head = range
            ? [206, { ...common, 'Content-Length': body.length, 'Content-Range': `bytes ${begin}-${end}/${CSV.length}` }]
            : [200, common];
        const answer = () => {
            response.writeHead(...head);
            response.flushHeaders();
            if (stall) {
                return;
            }
            if (!trickle) {
                ended = true;
                response.end(body);
                return;
            }
            let sent = 0;
            const tick = () => {
                if (sent === body.length) {
                    ended = true;
                    response.end();
                    return;
                }
                response.write(body.subarray(sent, sent + 1));
                sent += 1;
                timers.push(setTimeout(tick, trickle));
            };
            tick();
        };
        timers.push(setTimeout(answer, delay));
    };
}

module.exports = config => {
    const cfg = base(config);
    config.set({
        ...cfg,
        frameworks: ['jasmine'],
        plugins: [...cfg.plugins, { 'middleware:haybarn-slow': ['factory', slowServer] }],
        middleware: ['haybarn-slow'],
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
