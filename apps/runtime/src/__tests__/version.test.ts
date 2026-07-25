import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_VERSION_PATH, registerVersionRoute } from '../platform/http/version.js';

const originalEnv = { ...process.env };
const SOURCE_SHA = 'a'.repeat(40);
const releaseEnvironment = {
  COMBO_ENVIRONMENT: 'preview',
  COMBO_SOURCE_SHA: SOURCE_SHA,
  COMBO_RELEASE_ID: `release-${SOURCE_SHA}`,
  COMBO_BUILT_AT: '2026-07-24T08:00:00.000Z',
  COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${'b'.repeat(64)}`,
  COMBO_WEB_ASSET_MANIFEST: `sha256:${'c'.repeat(64)}`,
};

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe('runtime release version', () => {
  it('serves the strict release metadata at the public Runtime path without caching', async () => {
    const app = Fastify({ logger: false });
    try {
      await registerVersionRoute(app, releaseEnvironment);
      const response = await app.inject({ method: 'GET', url: RUNTIME_VERSION_PATH });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        schemaVersion: 1,
        environment: 'preview',
        sourceSha: SOURCE_SHA,
        releaseId: `release-${SOURCE_SHA}`,
        builtAt: '2026-07-24T08:00:00.000Z',
        releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
        webAssetManifest: `sha256:${'c'.repeat(64)}`,
      });
    } finally {
      await app.close();
    }
  });

  it('fails production startup validation when combo-release metadata is absent', async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://combo:combo@localhost:5432/combo',
      REDIS_URL: 'redis://localhost:6379',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'test-access',
      S3_SECRET_KEY: 'test-secret',
      LOGTO_ISSUER: 'https://identity.example/oidc',
      LOGTO_JWKS_URI: 'https://identity.example/oidc/jwks',
      LOGTO_AUDIENCE: 'https://combo.example/api',
    };
    for (const key of Object.keys(releaseEnvironment)) delete process.env[key];

    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow(/COMBO_ENVIRONMENT.*COMBO_WEB_ASSET_MANIFEST/);
  });

  it.each(['test', 'preview'] as const)(
    'accepts exact %s release metadata in a production-mode Runtime image',
    async (environment) => {
      process.env = {
        ...originalEnv,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://combo:combo@localhost:5432/combo',
        REDIS_URL: 'redis://localhost:6379',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY: 'test-access',
        S3_SECRET_KEY: 'test-secret',
        LOGTO_ISSUER: 'https://identity.example/oidc',
        LOGTO_JWKS_URI: 'https://identity.example/oidc/jwks',
        LOGTO_AUDIENCE: 'https://combo.example/api',
        ...releaseEnvironment,
        COMBO_ENVIRONMENT: environment,
      };

      const { loadEnv } = await import('../platform/config/env.js');
      expect(loadEnv().COMBO_ENVIRONMENT).toBe(environment);
    },
  );

  it('rejects Production release metadata in a non-production runtime', async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      ...releaseEnvironment,
      COMBO_ENVIRONMENT: 'production',
    };

    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow(/COMBO_\* 发布元数据校验失败/);
  });
});
