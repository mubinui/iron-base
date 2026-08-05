import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** Both webviews bundle the same way; only the entry point differs. */
const webviewConfig = (entry, out) => ({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: out,
  sourcemap: !production,
  minify: production,
  logLevel: "info",
});

const configs = [
  extensionConfig,
  webviewConfig("webview/main.ts", "dist/webview.js"),
  webviewConfig("webview/sidebar.ts", "dist/sidebar.js"),
];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
