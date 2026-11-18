import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.mjs',
  workers: 1,
  use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure' },
});
