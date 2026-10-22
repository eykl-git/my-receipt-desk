import { defineConfig, devices } from '@playwright/test';

// Production build served under the GitHub Pages base path (design §15): the S4 OCR/CSP smoke
// (e7-ocr-pages) and the S6 tour smoke with screenshots (e7-pages-smoke).
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/e7-*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173/my-receipt-desk/',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build:pages && npm run preview:pages',
    url: 'http://localhost:4173/my-receipt-desk/',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
