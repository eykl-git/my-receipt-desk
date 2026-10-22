import { defineConfig, devices } from '@playwright/test';

// Dev-server config (design §15): E1–E6, E8 and the S2–S5 stage specs. E7 runs on the Pages build.
export default defineConfig({
  testDir: 'tests/e2e',
  testIgnore: '**/e7-*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
