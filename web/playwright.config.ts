import { defineConfig } from '@playwright/test';

// Visual self-check pipeline: Playwright boots the Vite dev server, drives the
// real app in a real browser, and captures screenshots (so rendering + cursor —
// the parts type-check/build can't confirm — are actually verified).
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:5173', trace: 'on-first-retry' },
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
