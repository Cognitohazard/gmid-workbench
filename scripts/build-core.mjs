// Build the core for plain Node: one ES module bundle at dist/index.js, with type declarations
// beside it. The sources import each other without file extensions (the bundler convention the web
// app and the tests rely on), which Node's own loader does not resolve, so the JavaScript is
// bundled rather than emitted file by file. Dependencies stay external and are resolved from
// node_modules. Runs offline: esbuild and tsc are both local dev dependencies.

import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = fileURLToPath(new URL('../dist', import.meta.url));

// A clean directory, so no file left by an earlier build (a per-module .js) can be imported.
rmSync(dist, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  logLevel: 'warning',
});

// Declarations only: the JavaScript is the bundle above.
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
    '--emitDeclarationOnly',
  ],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
