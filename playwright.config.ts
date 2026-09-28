import { defineConfig, devices } from '@playwright/test';

// The stack (backend + dummy boards) is started by tests/e2e/stack.mjs on
// port 18080. Build it first: `cargo build --workspace`.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:18080',
    acceptDownloads: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node tests/e2e/stack.mjs',
    url: 'http://127.0.0.1:18080/devices',
    reuseExistingServer: false,
    timeout: 60000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
