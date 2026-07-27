import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const IMMUTABLE_IMAGE = `registry.invalid/sandboxd@sha256:${'a'.repeat(64)}`;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv, NODE_ENV: 'test' };
  delete process.env.SANDBOX_TOOLS_ENABLED;
  delete process.env.SANDBOX_IMAGE;
  delete process.env.SANDBOX_CAPABILITY_PRIVATE_KEY;
  delete process.env.SANDBOX_CONFIGURATION_REVISION;
  delete process.env.SANDBOX_CAPACITY;
  delete process.env.SANDBOX_FIFTH_SLOT_VALIDATED;
  delete process.env.SANDBOX_RUNTIME_CLASS;
  delete process.env.SANDBOX_IDLE_TTL_MS;
  delete process.env.SANDBOX_ABSOLUTE_TTL_MS;
  delete process.env.RUNTIME_SHUTDOWN_TIMEOUT_MS;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('sandbox env', () => {
  it('is disabled by default and keeps the fixed default capacity at four', async () => {
    const { loadEnv } = await import('../platform/config/env.js');
    const env = loadEnv();
    expect(env.SANDBOX_TOOLS_ENABLED).toBe(false);
    expect(env.SANDBOX_CONFIGURATION_REVISION).toBe(1);
    expect(env.SANDBOX_CAPACITY).toBe(4);
    expect(env.SANDBOX_FIFTH_SLOT_VALIDATED).toBe(false);
    expect(env.SANDBOX_RUNTIME_CLASS).toBe('gvisor');
    expect(env.SANDBOX_ABSOLUTE_TTL_MS).toBe(1_800_000);
    expect(env.RUNTIME_SHUTDOWN_TIMEOUT_MS).toBe(15_000);
  });

  it('does not initialize Kubernetes and exposes only the disabled backend when off', async () => {
    const { loadEnv } = await import('../platform/config/env.js');
    const { buildInfra, closeDb, closeObjectStore, closeRedis } =
      await import('../platform/infra/index.js');
    const infra = await buildInfra(loadEnv());
    try {
      expect(infra.sandbox.enabled).toBe(false);
      await expect(
        infra.sandbox.read({ sessionId: 's', turnId: 't', ownerUserId: 'u' }, { path: 'a' }),
      ).rejects.toMatchObject({ code: 'disabled' });
    } finally {
      await infra.sandbox.dispose();
      await closeDb();
      closeObjectStore();
      await closeRedis();
    }
  });

  it.each([
    ['image', { SANDBOX_CAPABILITY_PRIVATE_KEY: 'present' }],
    ['private key', { SANDBOX_IMAGE: IMMUTABLE_IMAGE }],
  ])('fails closed when enabled without %s', async (_name, extra) => {
    process.env.SANDBOX_TOOLS_ENABLED = 'true';
    Object.assign(process.env, extra);
    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow('环境变量校验失败');
  });

  it('accepts an explicit image and Ed25519 PKCS8 key without changing the four-slot ceiling', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    process.env.SANDBOX_TOOLS_ENABLED = 'true';
    process.env.SANDBOX_IMAGE = IMMUTABLE_IMAGE;
    process.env.SANDBOX_CAPABILITY_PRIVATE_KEY = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    process.env.SANDBOX_CAPACITY = '4';
    const { loadEnv } = await import('../platform/config/env.js');
    const env = loadEnv();
    expect(env.SANDBOX_TOOLS_ENABLED).toBe(true);
    expect(env.SANDBOX_IMAGE).toBe(IMMUTABLE_IMAGE);
    expect(env.SANDBOX_CAPACITY).toBe(4);
  });

  it('rejects a mutable image tag and any RuntimeClass other than gvisor', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    process.env.SANDBOX_TOOLS_ENABLED = 'true';
    process.env.SANDBOX_IMAGE = 'registry.invalid/sandboxd:latest';
    process.env.SANDBOX_RUNTIME_CLASS = 'runc';
    process.env.SANDBOX_CAPABILITY_PRIVATE_KEY = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow('环境变量校验失败');
  });

  it('rejects the opt-in manifest zero-digest placeholder', async () => {
    process.env.SANDBOX_TOOLS_ENABLED = 'true';
    process.env.SANDBOX_IMAGE = `registry.invalid/sandboxd@sha256:${'0'.repeat(64)}`;
    process.env.SANDBOX_CAPABILITY_PRIVATE_KEY = 'present';
    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow('环境变量校验失败');
  });

  it('rejects a misspelled enable flag instead of silently falling back to disabled', async () => {
    process.env.SANDBOX_TOOLS_ENABLED = 'TRUE';
    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow('环境变量校验失败');
  });

  it('rejects a non-positive or non-integer configuration revision', async () => {
    process.env.SANDBOX_TOOLS_ENABLED = 'true';
    process.env.SANDBOX_IMAGE = IMMUTABLE_IMAGE;
    process.env.SANDBOX_CAPABILITY_PRIVATE_KEY = 'present';
    process.env.SANDBOX_CONFIGURATION_REVISION = '0.5';
    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow('环境变量校验失败');
  });

  it('rejects an absolute lifetime that does not exceed the idle lifetime', async () => {
    process.env.SANDBOX_TOOLS_ENABLED = 'true';
    process.env.SANDBOX_IMAGE = IMMUTABLE_IMAGE;
    process.env.SANDBOX_CAPABILITY_PRIVATE_KEY = 'present';
    process.env.SANDBOX_IDLE_TTL_MS = '900000';
    process.env.SANDBOX_ABSOLUTE_TTL_MS = '900000';
    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow('环境变量校验失败');
  });

  it('rejects capacities other than the authoritative four or gated five slots', async () => {
    process.env.SANDBOX_TOOLS_ENABLED = 'true';
    process.env.SANDBOX_IMAGE = IMMUTABLE_IMAGE;
    process.env.SANDBOX_CAPABILITY_PRIVATE_KEY = 'present';
    process.env.SANDBOX_CAPACITY = '3';
    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow('环境变量校验失败');
  });

  it('rejects a fifth slot until the administrator records completed live validation', async () => {
    process.env.SANDBOX_TOOLS_ENABLED = 'true';
    process.env.SANDBOX_IMAGE = IMMUTABLE_IMAGE;
    process.env.SANDBOX_CAPABILITY_PRIVATE_KEY = 'present';
    process.env.SANDBOX_CAPACITY = '5';
    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow('环境变量校验失败');
  });

  it('allows exactly one optional fifth slot only with the live-validation gate', async () => {
    process.env.SANDBOX_TOOLS_ENABLED = 'true';
    process.env.SANDBOX_IMAGE = IMMUTABLE_IMAGE;
    process.env.SANDBOX_CAPABILITY_PRIVATE_KEY = 'present';
    process.env.SANDBOX_CAPACITY = '5';
    process.env.SANDBOX_FIFTH_SLOT_VALIDATED = 'true';
    const { loadEnv } = await import('../platform/config/env.js');
    expect(loadEnv()).toMatchObject({
      SANDBOX_CAPACITY: 5,
      SANDBOX_FIFTH_SLOT_VALIDATED: true,
    });
  });

  it('rejects a Runtime shutdown deadline above sixty seconds', async () => {
    process.env.RUNTIME_SHUTDOWN_TIMEOUT_MS = '60001';
    process.env.SANDBOX_TOOLS_ENABLED = 'true';
    process.env.SANDBOX_IMAGE = IMMUTABLE_IMAGE;
    process.env.SANDBOX_CAPABILITY_PRIVATE_KEY = 'present';
    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow('环境变量校验失败');
  });

  it('rejects an absolute Pod lifetime above thirty minutes', async () => {
    process.env.SANDBOX_TOOLS_ENABLED = 'true';
    process.env.SANDBOX_IMAGE = IMMUTABLE_IMAGE;
    process.env.SANDBOX_CAPABILITY_PRIVATE_KEY = 'present';
    process.env.SANDBOX_ABSOLUTE_TTL_MS = '1800001';
    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrow('环境变量校验失败');
  });
});
