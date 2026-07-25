import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHORING_VERSION_PATH, registerVersionRoute } from '../platform/http/version.js';

const originalEnv = { ...process.env };
const SOURCE_SHA = 'a'.repeat(40);
const releaseEnvironment = {
  COMBO_ENVIRONMENT: 'test',
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

describe('authoring release version', () => {
  it('serves the strict release metadata at the public API path without caching', async () => {
    const app = Fastify({ logger: false });
    try {
      await registerVersionRoute(app, releaseEnvironment);
      const response = await app.inject({ method: 'GET', url: AUTHORING_VERSION_PATH });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        schemaVersion: 1,
        environment: 'test',
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
      PROCESS: 'api',
      DATABASE_URL: 'postgres://combo:combo@localhost:5432/combo',
      REDIS_QUEUE_URL: 'redis://localhost:6379/0',
      REDIS_HOT_URL: 'redis://localhost:6380/0',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'test-access',
      S3_SECRET_KEY: 'test-secret',
      LOGTO_ENDPOINT: 'https://identity.example',
      LOGTO_ISSUER: 'https://identity.example/oidc',
      LOGTO_JWKS_URI: 'https://identity.example/oidc/jwks',
      LOGTO_APP_ID: 'test-app',
      LOGTO_APP_SECRET: 'test-app-secret',
      LOGTO_REDIRECT_URI: 'https://combo.example/api/v1/auth/callback',
      LOGTO_AUDIENCE: 'https://combo.example/api',
    };
    for (const key of Object.keys(releaseEnvironment)) delete process.env[key];

    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow(/COMBO_ENVIRONMENT.*COMBO_WEB_ASSET_MANIFEST/);
  });

  it.each(['test', 'preview'] as const)(
    'accepts exact %s release metadata in the production-mode Worker image',
    async (environment) => {
      process.env = {
        ...originalEnv,
        NODE_ENV: 'production',
        PROCESS: 'worker',
        DATABASE_URL: 'postgres://combo:combo@localhost:5432/combo',
        REDIS_QUEUE_URL: 'redis://localhost:6379/0',
        REDIS_HOT_URL: 'redis://localhost:6380/0',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY: 'test-access',
        S3_SECRET_KEY: 'test-secret',
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
      PROCESS: 'api',
      ...releaseEnvironment,
      COMBO_ENVIRONMENT: 'production',
    };

    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow(/COMBO_\* 发布元数据校验失败/);
  });

  it('rejects development placeholder metadata in a production runtime', async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      PROCESS: 'worker',
      DATABASE_URL: 'postgres://combo:combo@localhost:5432/combo',
      REDIS_QUEUE_URL: 'redis://localhost:6379/0',
      REDIS_HOT_URL: 'redis://localhost:6380/0',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'test-access',
      S3_SECRET_KEY: 'test-secret',
      COMBO_ENVIRONMENT: 'development',
      COMBO_SOURCE_SHA: '0'.repeat(40),
      COMBO_RELEASE_ID: `release-${'0'.repeat(40)}`,
      COMBO_BUILT_AT: '1970-01-01T00:00:00.000Z',
      COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${'0'.repeat(64)}`,
      COMBO_WEB_ASSET_MANIFEST: `sha256:${'0'.repeat(64)}`,
    };

    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow(/COMBO_\* 发布元数据校验失败/);
  });
});
