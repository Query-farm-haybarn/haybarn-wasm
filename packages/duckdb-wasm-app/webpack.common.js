import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function configure(params) {
    return {
        target: 'web',
        entry: {
            app: ['./src/app.tsx'],
        },
        output: {
            path: params.buildDir,
            filename: 'static/js/[name].[contenthash].js',
            chunkFilename: 'static/js/[name].[contenthash].js',
            assetModuleFilename: 'static/assets/[name].[contenthash][ext]',
            webassemblyModuleFilename: 'static/wasm/[hash].wasm',
            clean: true,
        },
        resolve: {
            extensions: ['.ts', '.tsx', '.js', '.mjs', '.jsx', '.css', '.wasm'],
            alias: {
                // Pin the workspace packages to their source dirs. yarn copies
                // `file:` deps into this package's node_modules at install time —
                // before the wasm engine / shell are (re)built — so the default
                // resolution bundles a STALE dist (notably a COI worker that
                // creates a non-shared WebAssembly.Memory, which breaks the
                // threaded variant with a shared-state mismatch). Aliasing to the
                // sibling workspace dirs guarantees we always bundle the freshly
                // built dist. The non-`$` aliases match the package root and any
                // subpath (e.g. `/dist/duckdb-browser-coi.worker.js`); they do
                // NOT match `@haybarn/haybarn-wasm-shell` (different path segment).
                '@haybarn/haybarn-wasm': path.resolve(__dirname, '../duckdb-wasm'),
                '@haybarn/haybarn-wasm-shell': path.resolve(__dirname, '../duckdb-wasm-shell'),
            },
        },
        module: {
            rules: [
                {
                    test: /\.m?js/,
                    resolve: {
                        fullySpecified: false,
                    },
                },
                {
                    test: /\.tsx?$/,
                    loader: 'ts-loader',
                    exclude: /node_modules/,
                    options: params.tsLoaderOptions,
                },
                {
                    test: /\.css$/,
                    use: [
                        params.extractCss ? MiniCssExtractPlugin.loader : 'style-loader',
                        {
                            loader: 'css-loader',
                            options: {
                                modules: {
                                    mode: 'local',
                                    auto: true,
                                    exportGlobals: true,
                                    localIdentName: params.cssIdentifier,
                                    localIdentContext: path.resolve(__dirname, 'src'),
                                },
                            },
                        },
                    ],
                },
                {
                    test: /.*\.wasm$/,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/wasm/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /\.(sql)$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/scripts/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /\.(json)$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/json/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /\.(csv|tbl)$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/csv/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /\.(parquet)$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/parquet/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /\.(png|jpe?g|gif|svg|ico)$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/img/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /site\.webmanifest$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /browserconfig\.xml$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/[name].[contenthash][ext]',
                    },
                },
            ],
        },
        optimization: {
            usedExports: 'global',
            chunkIds: 'deterministic',
            moduleIds: 'deterministic',
            splitChunks: {
                chunks: 'all',
                cacheGroups: {
                    vendors: {
                        test: /[\\/]node_modules[\\/]/,
                        priority: -10,
                    },
                    default: {
                        priority: -20,
                        reuseExistingChunk: true,
                    },
                },
            },
        },
        plugins: [
            new HtmlWebpackPlugin({
                template: './static/index.html',
                // Emit as index.html so the app is served at `/`. Upstream
                // duckdb-wasm-app emitted `original.html` for the GitHub-Pages
                // coi-serviceworker trick (a SW re-served it at `/` with
                // COOP/COEP injected, since GH Pages can't set headers). On
                // Cloudflare Pages we set those headers via static/_headers,
                // so no service worker / indirection is needed.
                filename: './index.html',
            }),
            new MiniCssExtractPlugin({
                filename: './static/css/[id].[contenthash].css',
                chunkFilename: './static/css/[id].[contenthash].css',
            }),
            new CopyWebpackPlugin({
                patterns: [
                    {
                        from: './static/favicons',
                        to: './static/favicons',
                    },
                    {
                        from: './static/svg/icons',
                        to: './static/img',
                    },
                    {
                        from: './static/css',
                        to: './static/css',
                    },
                    {
                        from: '../duckdb-wasm/docs',
                        to: './docs',
                    },
                    {
                        // Cloudflare Pages reads _headers from the deploy root
                        // (COOP/COEP for cross-origin isolation + asset caching).
                        from: './static/_headers',
                        to: './_headers',
                        toType: 'file',
                    },
                    {
                        // Cloudflare Pages advanced-mode worker: serves the COI
                        // wasm same-origin and applies COOP/COEP to every
                        // response. Must sit at the deploy root.
                        from: './_worker.js',
                        to: './_worker.js',
                        toType: 'file',
                    },
                    {
                        // VGI OAuth popup redirect target. Must sit at the deploy
                        // root so the IdP-registered redirect URI
                        // (https://shell.haybarn.query.farm/oauth-callback.html)
                        // resolves; same-origin so it can relay the auth code over
                        // BroadcastChannel("vgi-oauth") to the main thread.
                        from: './static/oauth-callback.html',
                        to: './oauth-callback.html',
                        toType: 'file',
                    },
                    {
                        // VGI logo shown on the OAuth popup (oauth-callback.html).
                        // Stable root path so the un-hashed callback page can ref it.
                        from: './static/oauth-logo.png',
                        to: './oauth-logo.png',
                        toType: 'file',
                    },
                ],
            }),
        ],
        experiments: {
            asyncWebAssembly: true,
        },
    };
}
