import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';

const provider = vi.hoisted(() => ({
  create: vi.fn(() => ({
    digester: vi.fn(),
    checkReady: vi.fn(async () => true),
  })),
}));

vi.mock('./visible-transcript-test-kms.js', () => ({
  createVisibleTranscriptTestKmsBinding: provider.create,
}));

import { createVisibleTranscriptKmsForEnv } from './index.js';

function env(overrides: Partial<Env> = {}): Env {
  return {
    CREATOR_AGENT_PUBLIC_ENABLED: false,
    COMBO_ENVIRONMENT: 'test',
    CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_PROVIDER: 'disabled',
    CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_NAMESPACE: undefined,
    CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_KEY_REF_PREFIX: undefined,
    CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_MIN_KEY_VERSION: 1,
    CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_KEYRING_FILE: undefined,
    ...overrides,
  } as Env;
}

describe('visible transcript Test provider bootstrap', () => {
  beforeEach(() => {
    provider.create.mockClear();
  });

  it('does not construct or read a provider while the public feature flag is off', async () => {
    const binding = await createVisibleTranscriptKmsForEnv(env());

    expect(binding).toBeNull();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('injects the Test-only provider using only non-secret policy and a file path', async () => {
    const binding = await createVisibleTranscriptKmsForEnv(
      env({
        CREATOR_AGENT_PUBLIC_ENABLED: true,
        CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_PROVIDER: 'test-k8s-secret-file',
        CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_NAMESPACE: 'combo/visible-transcript',
        CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_KEY_REF_PREFIX:
          'k8s-secret://combo-test/visible-transcript/',
        CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_MIN_KEY_VERSION: 7,
        CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_KEYRING_FILE:
          '/var/run/secrets/combo/visible-transcript/keyring.json',
      }),
    );

    expect(binding).not.toBeNull();
    expect(provider.create).toHaveBeenCalledWith(
      {
        keyNamespace: 'combo/visible-transcript',
        keyRefPrefix: 'k8s-secret://combo-test/visible-transcript/',
        minimumKeyVersion: 7n,
      },
      { keyringFile: '/var/run/secrets/combo/visible-transcript/keyring.json' },
    );
  });

  it('fails closed if an unsupported stage bypasses env validation', async () => {
    await expect(
      createVisibleTranscriptKmsForEnv(
        env({
          CREATOR_AGENT_PUBLIC_ENABLED: true,
          COMBO_ENVIRONMENT: 'production',
          CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_PROVIDER: 'test-k8s-secret-file',
          CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_NAMESPACE: 'combo/visible-transcript',
          CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_KEY_REF_PREFIX:
            'k8s-secret://combo-test/visible-transcript/',
          CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_KEYRING_FILE: '/test/keyring.json',
        }),
      ),
    ).rejects.toThrow('visible transcript Test key provider configuration is invalid');
  });
});
