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
                // Haybarn: aliasing the package to its directory bypasses its `exports` map, so the `./vgi` subpath
                // export is spelled out, first: the first matching alias wins.
                '@haybarn/haybarn-wasm/vgi': path.resolve(__dirname, '../duckdb-wasm/dist/duckdb-browser-vgi.mjs'),
                '@haybarn/haybarn-wasm': path.resolve(__dirname, '../duckdb-wasm'),
                // Haybarn: like the engine package, bundle the freshly built shell from its workspace dir rather
                // than the copy yarn made into node_modules at install time, before the shell was built.
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
                // Haybarn: emit index.html so the app is served at `/`. Upstream emits original.html for the
                // GitHub Pages coi-serviceworker trick (a service worker re-serves it with COOP/COEP); the Haybarn
                // shell is hosted on Cloudflare Pages, where _worker.js sets those headers.
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
                        // Cloudflare Pages reads _headers from the deploy root (COOP/COEP + asset caching)
                        from: './static/_headers',
                        to: './_headers',
                        toType: 'file',
                    },
                    {
                        // Cloudflare Pages advanced-mode worker: serves the threads wasm same-origin and applies
                        // COOP/COEP to every response. Must sit at the deploy root.
                        from: './_worker.js',
                        to: './_worker.js',
                        toType: 'file',
                    },
                    {
                        // Haybarn: the redirect target of the VGI OAuth popup (installVgiOAuthBridge). At the root
                        // and unhashed, so an IdP can register a stable redirect URI, and same-origin, so it can relay
                        // the code over BroadcastChannel('vgi-oauth').
                        from: './static/oauth-callback.html',
                        to: './oauth-callback.html',
                        toType: 'file',
                    },
                    {
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
