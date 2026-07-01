import { defineConfig } from '@playwright/test';

// Visual self-check pipeline: Playwright boots the Vite dev server, drives the
// real app in a real browser, and captures screenshots (so rendering + cursor —
// the parts type-check/build can't confirm — are actually verified).
// Port is env-overridable so the suite can run on a free port when another dev server already
// holds the default (set E2E_PORT=<free port>). With a custom port we always start a fresh
// server (never reuse whatever is on the default).
const PORT = process.env.E2E_PORT ?? '5173';
const HOST = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Regenerates e2e/fixtures/demo.mostab.csv from the EKV oracle before the suite runs (the app
  // no longer boots with built-in data, so tests load the demo device from this file).
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: HOST, trace: 'on-first-retry' },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: HOST,
    reuseExistingServer: !process.env.E2E_PORT,
    timeout: 120_000,
  },
});
