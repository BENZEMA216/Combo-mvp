import { appendFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

interface MockInboxResult {
  id: string;
  code: string;
}

interface MeResponse {
  data: {
    id: string;
    account: string;
  };
}

interface RuntimeCapabilityResponse {
  data: Array<{ id: string; owned: boolean }>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少浏览器验收配置：${name}`);
  return value;
}

function rememberSentinel(value: string): void {
  const sentinelFile = requiredEnvironment('AUTH_E2E_SENTINEL_FILE');
  appendFileSync(sentinelFile, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
}

function creatorAccount(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `creator-${Array.from(randomBytes(8), (value) => alphabet[value % alphabet.length]).join('')}`;
}

function seedOwnerDistinguishingCapabilities(ownerUserId: string): {
  ownedCapabilityId: string;
  otherCapabilityId: string;
} {
  const project = requiredEnvironment('AUTH_E2E_COMPOSE_PROJECT');
  const repository = requiredEnvironment('AUTH_E2E_REPO_ROOT');
  const postgresUser = requiredEnvironment('POSTGRES_USER');
  const postgresDb = requiredEnvironment('POSTGRES_DB');
  const ownedTaskId = randomUUID();
  const ownedCapabilityId = randomUUID();
  const otherUserId = randomUUID();
  const otherTaskId = randomUUID();
  const otherCapabilityId = randomUUID();
  const sql = `
    INSERT INTO users (id, account, roles)
      VALUES ('${otherUserId}', '${creatorAccount()}', ARRAY['creator']::text[]);
    INSERT INTO tasks (id, owner_user_id, idempotency_key)
      VALUES ('${ownedTaskId}', '${ownerUserId}', 'browser-${ownedTaskId}');
    INSERT INTO tasks (id, owner_user_id, idempotency_key)
      VALUES ('${otherTaskId}', '${otherUserId}', 'browser-${otherTaskId}');
    INSERT INTO capabilities (id, task_id, owner_user_id, name, summary, kind, storage_key, published)
      VALUES ('${ownedCapabilityId}', '${ownedTaskId}', '${ownerUserId}', 'Browser owned capability', '', 'markdown', 'browser/owned', false);
    INSERT INTO capabilities (id, task_id, owner_user_id, name, summary, kind, storage_key, published)
      VALUES ('${otherCapabilityId}', '${otherTaskId}', '${otherUserId}', 'Browser other capability', '', 'markdown', 'browser/other', false);
  `;
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--project-name',
      project,
      '-f',
      'infra/docker-compose.yml',
      '-f',
      'infra/docker-compose.dev-test.yml',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      postgresUser,
      '-d',
      postgresDb,
      '-c',
      sql,
    ],
    { cwd: repository, encoding: 'utf8', stdio: 'pipe' },
  );
  if (result.status !== 0) throw new Error('无法建立跨服务身份隔离测试数据');
  return { ownedCapabilityId, otherCapabilityId };
}

async function latestCode(email: string): Promise<string> {
  const mockBaseUrl = requiredEnvironment('AUTH_E2E_RESEND_MOCK_BASE_URL');
  const mockApiKey = requiredEnvironment('AUTH_E2E_RESEND_MOCK_API_KEY');
  const url = new URL('/__test/inbox/latest', mockBaseUrl);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mockApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: email }),
    });
    if (!response.ok) return '';

    return ((await response.json()) as MockInboxResult).code;
  } catch {
    return '';
  }
}

test('邮箱验证码登录在两个服务间共享不透明会话并可注销', async ({ page, context }) => {
  const email = `browser-${randomUUID().replaceAll('-', '')}@example.test`;
  rememberSentinel(email);

  await page.goto('/login?returnTo=%2Ftasks');
  await expect(page.getByRole('heading', { name: '使用邮箱登录' })).toBeVisible();
  const thirdPartyScripts = await page
    .locator('script[src]')
    .evaluateAll((scripts) =>
      scripts
        .map((script) => new URL((script as HTMLScriptElement).src, window.location.href).origin)
        .filter((origin) => origin !== window.location.origin),
    );
  expect(thirdPartyScripts).toEqual([]);
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill(email);
  await page.getByRole('button', { name: '发送验证码' }).click();
  await expect(page.getByRole('heading', { name: '输入六位验证码' })).toBeVisible();

  let code = '';
  await expect
    .poll(async () => {
      code = await latestCode(email);
      return /^\d{6}$/.test(code);
    })
    .toBe(true);
  rememberSentinel(code);

  await page.getByRole('textbox', { name: '六位验证码', exact: true }).fill(code);
  await page.getByRole('button', { name: '验证并登录' }).click();
  await expect(page).toHaveURL(/\/tasks$/);

  const authCookies = (await context.cookies()).filter((cookie) => cookie.name === 'cb_session');
  expect(authCookies.length).toBe(1);
  const [sessionCookie] = authCookies;
  expect(sessionCookie).toBeDefined();
  if (!sessionCookie || !/^s1\.[A-Za-z0-9_-]{43}$/.test(sessionCookie.value)) {
    throw new Error('浏览器会话 Cookie 格式不符合共享契约');
  }
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.sameSite).toBe('Lax');
  expect(sessionCookie?.path).toBe('/');
  expect(sessionCookie?.secure).toBe(false);
  rememberSentinel(sessionCookie.value);

  const sessionCookieVisibleToScript = await page.evaluate(() =>
    document.cookie.split(';').some((item) => item.trim().startsWith('cb_session=')),
  );
  expect(sessionCookieVisibleToScript).toBe(false);

  const meResponse = await page.request.get('/api/v1/me');
  expect(meResponse.status()).toBe(200);
  const me = (await meResponse.json()) as MeResponse;
  expect(me.data.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(me.data.account).toMatch(/^creator-[a-z2-7]{8}$/);

  const { ownedCapabilityId, otherCapabilityId } = seedOwnerDistinguishingCapabilities(me.data.id);
  const runtimeResponse = await page.request.get('/api/v1/runtime/capabilities');
  expect(runtimeResponse.status()).toBe(200);
  const runtime = (await runtimeResponse.json()) as RuntimeCapabilityResponse;
  expect(runtime.data).toContainEqual(
    expect.objectContaining({ id: ownedCapabilityId, owned: true }),
  );
  expect(runtime.data.some((item) => item.id === otherCapabilityId)).toBe(false);

  const logoutResult = await page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return { status: response.status, body: await response.json() };
  });
  expect(logoutResult.status).toBe(200);
  expect(logoutResult.body).toMatchObject({
    data: { loggedOut: true },
    meta: { traceId: expect.any(String) },
  });

  expect((await context.cookies()).filter((cookie) => cookie.name === 'cb_session').length).toBe(0);
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  expect((await page.request.get('/api/v1/runtime/capabilities')).status()).toBe(401);

  const streamResponse = await page.request.get(`/api/v1/runtime/sessions/${randomUUID()}/stream`, {
    timeout: 5_000,
  });
  expect(streamResponse.status()).toBe(401);
  expect(streamResponse.headers()['content-type']).toContain('application/json');
});
