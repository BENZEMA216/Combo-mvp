import { defineConfig } from '@playwright/test';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少浏览器真实性配置：${name}`);
  return value;
}

const candidateCommit = requiredEnvironment('COMBO_BROWSER_TRUTH_CANDIDATE_SHA');
if (!/^[0-9a-f]{40}$/.test(candidateCommit)) {
  throw new Error('COMBO_BROWSER_TRUTH_CANDIDATE_SHA 必须是完整小写提交 SHA');
}

requiredEnvironment('PLAYWRIGHT_JSON_OUTPUT_FILE');

export default defineConfig({
  testDir: '.',
  testMatch: 'resend-auth.spec.ts',
  failOnFlakyTests: true,
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  repeatEach: 1,
  maxFailures: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  updateSnapshots: 'none',
  preserveOutput: 'never',
  outputDir: requiredEnvironment('PLAYWRIGHT_OUTPUT_DIR'),
  reporter: 'json',
  metadata: {
    comboEvidence: {
      protocol: 'combo.playwright-controlled-local-auth/1',
      candidateCommit,
      environment: 'LOCAL_DOCKER_COMPOSE',
      browserCliDefault: 'chromium',
      emailDelivery: 'RESEND_MOCK',
      transport: 'HTTP',
      cookieSecure: false,
    },
  },
  use: {
    baseURL: requiredEnvironment('AUTH_E2E_WEB_BASE_URL'),
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
