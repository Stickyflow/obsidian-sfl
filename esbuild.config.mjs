// Bundles src/main.ts (+ the real `stickyflow` npm dependency, resolved via
// the `file:../stickyflow.js` link) into a single main.js. Unlike
// vscode-sfl-preview — which copies stickyflow.js/dist as static webview
// media because the extension host and webview are separate processes with
// no shared bundler — an Obsidian plugin runs directly in the app's own
// renderer, so stickyflow can be a normal bundled dependency here.
import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import process from 'node:process';

const prod = process.argv[2] === 'production';

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  outfile: 'main.js',
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
