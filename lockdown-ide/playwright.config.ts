import { defineConfig } from '@playwright/test';

// End-to-end tests drive the real Electron app (built with `vite build --mode e2e`).
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One app instance at a time: the app holds a single-instance lock.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
