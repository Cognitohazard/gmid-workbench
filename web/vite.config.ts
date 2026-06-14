import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single self-contained offline index.html (NDA-safe, no CDN refs). The
// single-file plugin sets the inlining build options itself; sourcemaps are
// dead weight once everything is inlined.
export default defineConfig({
  plugins: [svelte(), viteSingleFile({ removeViteModuleLoader: true })],
  build: { sourcemap: false },
});
