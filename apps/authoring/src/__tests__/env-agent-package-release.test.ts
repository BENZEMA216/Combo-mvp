import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_SESSION_COOKIE_PRODUCTION_NAME } from '@cb/shared';

const SOURCE_SHA = 'a'.repeat(40);
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const PACKAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const SESSION = `s1.${Buffer.alloc(32, 7).toString('base64url')}`;
const GATE = {
  protocol: 'combo.agent-package-publisher-test-gate/1',
  sourceSha: SOURCE_SHA,
  publisherUserId: OWNER,
  packageDigest: PACKAGE_DIGEST,
} as const;

const COMMON = {
  NODE_ENV: 'production',
  PROCESS: 'api',
  DATABASE_URL: 'postgres://test.invalid/test',
  REDIS_QUEUE_URL: 'redis://test.invalid/0',
  REDIS_HOT_URL: 'redis://test.invalid/0',
  S3_ENDPOINT: 'https://objects.example.test',
  S3_ACCESS_KEY: 'test-access-value',
  S3_SECRET_KEY: 'test-secret-value',
  COMBO_ENVIRONMENT: 'test',
  COMBO_SOURCE_SHA: SOURCE_SHA,
  COMBO_RELEASE_ID: `release-${SOURCE_SHA}`,
  COMBO_BUILT_AT: '2026-08-30T00:00:00.000Z',
  COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${'b'.repeat(64)}`,
  COMBO_WEB_ASSET_MANIFEST: `sha256:${'c'.repeat(64)}`,
  PUBLIC_APP_ORIGINS: 'https://test.example.test',
  SESSION_COOKIE_SECURE: 'true',
  RESEND_API_KEY: 'test-resend-key',
  RESEND_FROM_EMAIL: 'Combo <auth@buildwithcombo.com>',
  OTP_HMAC_SECRET: 'h'.repeat(32),
  COMBO_AGENT_PACKAGE_PUBLISHER_TEST_GATE: JSON.stringify(GATE),
};

function stub(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

async function freshConfig() {
  vi.resetModules();
  return import('../platform/config/env.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('controlled Test Agent Package Publisher environment gate', () => {
  it('activates only when Test release metadata and exact candidate SHA match', async () => {
    stub(COMMON);
    const { agentPackagePublisherTestGateFromEnv, loadEnv } = await freshConfig();
    const env = loadEnv();
    expect(agentPackagePublisherTestGateFromEnv(env)).toEqual(GATE);
  });

  it('keeps the route closed when the gate is absent or candidate SHA drifts', async () => {
    stub({ ...COMMON, COMBO_AGENT_PACKAGE_PUBLISHER_TEST_GATE: '' });
    let config = await freshConfig();
    let env = config.loadEnv();
    expect(config.agentPackagePublisherTestGateFromEnv(env)).toBeNull();

    vi.unstubAllEnvs();
    stub({
      ...COMMON,
      COMBO_AGENT_PACKAGE_PUBLISHER_TEST_GATE: JSON.stringify({
        ...GATE,
        sourceSha: 'e'.repeat(40),
      }),
    });
    config = await freshConfig();
    env = config.loadEnv();
    expect(config.agentPackagePublisherTestGateFromEnv(env)).toBeNull();
  });

  it.each(['preview', 'production'])(
    'rejects a configured gate in %s without printing owner or digest',
    async (environment) => {
      stub({ ...COMMON, COMBO_ENVIRONMENT: environment });
      const { loadEnv } = await freshConfig();
      expect(loadEnv).toThrowError(/COMBO_AGENT_PACKAGE_PUBLISHER_TEST_GATE/u);
      try {
        loadEnv();
      } catch (error) {
        expect(String(error)).not.toContain(OWNER);
        expect(String(error)).not.toContain(PACKAGE_DIGEST);
        expect(String(error)).not.toContain('test-secret-value');
      }
    },
  );

  it('rejects non-canonical, extra-field, and malformed gate JSON without echoing it', async () => {
    const privateMarker = 'must-not-appear';
    for (const raw of [
      ` ${JSON.stringify(GATE)}`,
      JSON.stringify({ ...GATE, privateMarker }),
      `{"protocol":"${privateMarker}"`,
    ]) {
      vi.unstubAllEnvs();
      stub({ ...COMMON, COMBO_AGENT_PACKAGE_PUBLISHER_TEST_GATE: raw });
      const { loadEnv } = await freshConfig();
      expect(loadEnv).toThrowError(/COMBO_AGENT_PACKAGE_PUBLISHER_TEST_GATE/u);
      try {
        loadEnv();
      } catch (error) {
        expect(String(error)).not.toContain(privateMarker);
        expect(String(error)).not.toContain(OWNER);
        expect(String(error)).not.toContain(PACKAGE_DIGEST);
      }
    }
  });

  it('rejects gate material on the worker process', async () => {
    stub({ ...COMMON, PROCESS: 'worker' });
    const { loadEnv } = await freshConfig();
    expect(loadEnv).toThrowError(/只能用于 Test API/u);
  });

  it('conceals the active owner-only route before parsing attacker bodies', async () => {
    stub(COMMON);
    const { loadEnv } = await freshConfig();
    const { buildApp } = await import('../bootstrap/app.js');
    const activeApp = await buildApp({
      env: { ...loadEnv(), NODE_ENV: 'test', LOG_LEVEL: 'fatal' },
    });
    try {
      const privateMarker = 'publisher-body-must-not-appear';
      const query = vi.spyOn(activeApp.infra.db, 'query');
      const sessionRow = (userId: string) => ({
        rows: [
          {
            session_id: '33333333-3333-4333-8333-333333333333',
            user_id: userId,
            account: 'creator-publisher-test',
            roles: ['creator'],
            disabled_at: null,
          },
        ],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });
      query.mockImplementationOnce((async () => sessionRow(OTHER_OWNER)) as never);
      const concealed = await activeApp.inject({
        method: 'POST',
        url: '/api/v1/agent-package-releases',
        headers: {
          'content-type': 'application/json',
          origin: COMMON.PUBLIC_APP_ORIGINS,
          cookie: `${AUTH_SESSION_COOKIE_PRODUCTION_NAME}=${SESSION}`,
        },
        payload: `{"private":"${privateMarker}"`,
      });
      expect(concealed.statusCode).toBe(404);
      expect(concealed.headers['cache-control']).toBe('no-store');
      expect(concealed.body).not.toContain(privateMarker);
      expect(concealed.body).not.toContain('FST_ERR');

      query.mockImplementationOnce((async () => sessionRow(OWNER)) as never);
      const publisherMalformed = await activeApp.inject({
        method: 'POST',
        url: '/api/v1/agent-package-releases',
        headers: {
          'content-type': 'application/json',
          origin: COMMON.PUBLIC_APP_ORIGINS,
          cookie: `${AUTH_SESSION_COOKIE_PRODUCTION_NAME}=${SESSION}`,
        },
        payload: `{"private":"${privateMarker}"`,
      });
      expect(publisherMalformed.statusCode).toBe(400);
      expect(publisherMalformed.headers['cache-control']).toBe('no-store');
      expect(publisherMalformed.body).not.toContain(privateMarker);
      expect(publisherMalformed.body).not.toContain('FST_ERR');
    } finally {
      await activeApp.close();
    }

    const closedApp = await buildApp({
      env: {
        ...loadEnv(),
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        COMBO_AGENT_PACKAGE_PUBLISHER_TEST_GATE: '',
      },
    });
    try {
      const closed = await closedApp.inject({
        method: 'GET',
        url: '/api/v1/agent-package-releases/release.agent-package.00000000000000000000000000000000',
      });
      expect(closed.statusCode).toBe(404);
    } finally {
      await closedApp.close();
    }
  });
});
