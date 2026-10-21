import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single self-contained offline index.html (NDA-safe, no CDN refs). The
// single-file plugin sets the inlining build options itself; sourcemaps are
// dead weight once everything is inlined.
export default defineConfig({
  plugins: [svelte(), viteSingleFile({ removeViteModuleLoader: true })],
  // The sheet evaluation worker is imported `?worker&inline`, so its code is embedded in the page
  // as text and started from a blob URL, with nothing to fetch, offline or from file://. It is
  // built as a classic (IIFE) worker, because some browsers refuse to start a module worker from
  // a file:// page.
  worker: { format: 'iife' },
  server: { port: 5174 },
  build: { sourcemap: false },
});
