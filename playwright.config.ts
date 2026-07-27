import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const outputDir =
  process.env.PLAYWRIGHT_OUTPUT_DIR ??
  join(tmpdir(), `agora-resend-auth-playwright-${process.pid}`);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'resend-auth.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir,
  reporter: [['line']],
  use: {
    baseURL: process.env.AUTH_E2E_WEB_BASE_URL ?? 'http://127.0.0.1:18080',
    browserName: 'chromium',
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
