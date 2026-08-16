import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeJson } from '@cb/creator-agent-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVisibleTranscriptTestKmsBinding,
  VISIBLE_TRANSCRIPT_TEST_KDF_DOMAIN,
  VISIBLE_TRANSCRIPT_TEST_KDF_PROTOCOL,
  VISIBLE_TRANSCRIPT_TEST_KEYRING_PROTOCOL,
  VisibleTranscriptTestKmsError,
} from './visible-transcript-test-kms.js';
import { VISIBLE_TRANSCRIPT_HMAC_DOMAIN } from '../../modules/creator-agent-conversation/visible-transcript-digester.js';

const CREATOR_A = '01900000-0000-7000-8000-000000000001';
const CREATOR_B = '01900000-0000-7000-8000-000000000002';
const VERSION_A = '01900000-0000-7000-8000-000000000003';
const VERSION_B = '01900000-0000-7000-8000-000000000004';
const KEY_NAMESPACE = 'combo/visible-transcript';
const KEY_REF_PREFIX = 'k8s-secret://combo-test/visible-transcript/';
const KEY_REF_V7 = `${KEY_REF_PREFIX}root@7`;
const ROOT_V7 = Buffer.alloc(32, 0x27);
const ROOT_V8 = Buffer.alloc(32, 0x38);

const policy = {
  keyNamespace: KEY_NAMESPACE,
  keyRefPrefix: KEY_REF_PREFIX,
  minimumKeyVersion: 7n,
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
  vi.restoreAllMocks();
});

function keyring(
  input: {
    rootKey?: Uint8Array;
    keyId?: string;
    keyVersion?: string;
    keyRef?: string;
    activeKeyVersion?: string;
    extra?: Record<string, unknown>;
  } = {},
): Buffer {
  const keyVersion = input.keyVersion ?? '7';
  return Buffer.from(
    JSON.stringify({
      protocol: VISIBLE_TRANSCRIPT_TEST_KEYRING_PROTOCOL,
      keyNamespace: KEY_NAMESPACE,
      activeKeyVersion: input.activeKeyVersion ?? keyVersion,
      keys: [
        {
          keyId: input.keyId ?? 'visible-test-root-v7',
          keyVersion,
          keyRef: input.keyRef ?? KEY_REF_V7,
          keyBase64Url: Buffer.from(input.rootKey ?? ROOT_V7).toString('base64url'),
        },
      ],
      ...input.extra,
    }),
  );
}

function reader(serialized: () => Uint8Array) {
  return vi.fn(async (_path: string, signal: AbortSignal) => {
    if (signal.aborted) throw signal.reason;
    return Buffer.from(serialized());
  });
}

async function writeKeyring(serialized: Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'combo-visible-transcript-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'keyring.json');
  await writeFile(path, serialized, { mode: 0o400 });
  return path;
}

function expectedDigest(input: {
  rootKey: Uint8Array;
  creatorId: string;
  agentVersionId: string;
  keyId: string;
  keyVersion: bigint;
}): string {
  const scopedKey = createHmac('sha256', input.rootKey)
    .update(VISIBLE_TRANSCRIPT_TEST_KDF_DOMAIN, 'utf8')
    .update(
      canonicalizeJson({
        protocol: VISIBLE_TRANSCRIPT_TEST_KDF_PROTOCOL,
        keyNamespace: KEY_NAMESPACE,
        creatorId: input.creatorId,
        agentVersionId: input.agentVersionId,
        keyId: input.keyId,
        keyVersion: input.keyVersion.toString(10),
      }),
      'utf8',
    )
    .digest();
  try {
    const transcript = Buffer.concat([
      Buffer.from(VISIBLE_TRANSCRIPT_HMAC_DOMAIN, 'utf8'),
      Buffer.from(
        canonicalizeJson({
          protocol: 'combo.visible-transcript/1',
          schemaVersion: 1,
          agentVersionId: input.agentVersionId,
          messages: [],
        }),
        'utf8',
      ),
    ]);
    return `hmac-sha256:${createHmac('sha256', scopedKey).update(transcript).digest('hex')}`;
  } finally {
    scopedKey.fill(0);
  }
}

describe('Test-only visible transcript Kubernetes Secret file adapter', () => {
  it('does not read the keyring during construction and uses the read-only file on demand', async () => {
    const keyringFile = await writeKeyring(keyring());
    const readKeyringFile = reader(() => keyring());
    const binding = createVisibleTranscriptTestKmsBinding(policy, {
      keyringFile,
      readKeyringFile,
    });

    expect(readKeyringFile).not.toHaveBeenCalled();
    expect(await binding.checkReady()).toBe(true);
    expect(readKeyringFile).toHaveBeenCalledOnce();

    const filesystemBinding = createVisibleTranscriptTestKmsBinding(policy, { keyringFile });
    const result = await filesystemBinding.digester({
      creatorId: CREATOR_A,
      agentVersionId: VERSION_A,
      signal: AbortSignal.timeout(1_000),
    });
    expect(result).toEqual({
      digest: expectedDigest({
        rootKey: ROOT_V7,
        creatorId: CREATOR_A,
        agentVersionId: VERSION_A,
        keyId: 'visible-test-root-v7',
        keyVersion: 7n,
      }),
      keyId: 'visible-test-root-v7',
      keyVersion: 7n,
      keyRef: KEY_REF_V7,
    });
  });

  it('domain-separates the key and scopes equal transcript bytes by Creator and AgentVersion', async () => {
    const binding = createVisibleTranscriptTestKmsBinding(policy, {
      keyringFile: '/test/keyring.json',
      readKeyringFile: reader(() => keyring()),
    });

    const same = await Promise.all(
      [CREATOR_A, CREATOR_A].map((creatorId) =>
        binding.digester({
          creatorId,
          agentVersionId: VERSION_A,
          signal: AbortSignal.timeout(1_000),
        }),
      ),
    );
    const otherCreator = await binding.digester({
      creatorId: CREATOR_B,
      agentVersionId: VERSION_A,
      signal: AbortSignal.timeout(1_000),
    });
    const otherVersion = await binding.digester({
      creatorId: CREATOR_A,
      agentVersionId: VERSION_B,
      signal: AbortSignal.timeout(1_000),
    });

    expect(same[0]!.digest).toBe(same[1]!.digest);
    expect(otherCreator.digest).not.toBe(same[0]!.digest);
    expect(otherVersion.digest).not.toBe(same[0]!.digest);
  });

  it('observes an atomic keyring rotation on the next operation', async () => {
    let serialized = keyring();
    const binding = createVisibleTranscriptTestKmsBinding(policy, {
      keyringFile: '/test/keyring.json',
      readKeyringFile: reader(() => serialized),
    });
    const first = await binding.digester({
      creatorId: CREATOR_A,
      agentVersionId: VERSION_A,
      signal: AbortSignal.timeout(1_000),
    });

    serialized = keyring({
      rootKey: ROOT_V8,
      keyId: 'visible-test-root-v8',
      keyVersion: '8',
      keyRef: `${KEY_REF_PREFIX}root@8`,
    });
    const rotated = await binding.digester({
      creatorId: CREATOR_A,
      agentVersionId: VERSION_A,
      signal: AbortSignal.timeout(1_000),
    });

    expect(rotated.digest).not.toBe(first.digest);
    expect(rotated).toMatchObject({
      keyId: 'visible-test-root-v8',
      keyVersion: 8n,
      keyRef: `${KEY_REF_PREFIX}root@8`,
    });
  });

  it.each([
    ['unknown top-level field', keyring({ extra: { rawKey: 'forbidden' } })],
    ['stale active version', keyring({ keyVersion: '6' })],
    ['missing active version', keyring({ activeKeyVersion: '8' })],
    ['foreign key reference', keyring({ keyRef: 'k8s-secret://foreign/root@7' })],
    [
      'duplicate JSON key',
      Buffer.from(
        `{"protocol":"${VISIBLE_TRANSCRIPT_TEST_KEYRING_PROTOCOL}","protocol":"${VISIBLE_TRANSCRIPT_TEST_KEYRING_PROTOCOL}"}`,
      ),
    ],
  ] as const)('rejects a non-strict keyring: %s', async (_name, serialized) => {
    const binding = createVisibleTranscriptTestKmsBinding(policy, {
      keyringFile: '/test/keyring.json',
      readKeyringFile: reader(() => serialized),
    });

    expect(await binding.checkReady()).toBe(false);
  });

  it('bounds a non-cooperative read to 500ms and returns only a stable non-sensitive error', async () => {
    const canary = Buffer.alloc(32, 0xa5).toString('base64url');
    const binding = createVisibleTranscriptTestKmsBinding(policy, {
      keyringFile: `/test/${canary}/keyring.json`,
      readKeyringFile: vi.fn(() => new Promise<Uint8Array>(() => undefined)),
    });
    const startedAt = performance.now();
    let failure: unknown;
    try {
      await binding.digester({
        creatorId: CREATOR_A,
        agentVersionId: VERSION_A,
        signal: AbortSignal.timeout(2_000),
      });
    } catch (error) {
      failure = error;
    }

    expect(performance.now() - startedAt).toBeLessThan(1_500);
    expect(failure).toBeInstanceOf(VisibleTranscriptTestKmsError);
    expect(failure).toMatchObject({ code: 'VISIBLE_TRANSCRIPT_TEST_KMS_UNAVAILABLE' });
    expect(String(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(await binding.checkReady(AbortSignal.abort())).toBe(false);
  });

  it('honors caller abort without exposing its reason through the provider error', async () => {
    const canary = 'caller-abort-secret-canary';
    const receivedSignals: AbortSignal[] = [];
    const binding = createVisibleTranscriptTestKmsBinding(policy, {
      keyringFile: '/test/keyring.json',
      readKeyringFile: vi.fn((_path, signal) => {
        receivedSignals.push(signal);
        return new Promise<Uint8Array>(() => undefined);
      }),
    });
    const controller = new AbortController();
    const operation = binding.digester({
      creatorId: CREATOR_A,
      agentVersionId: VERSION_A,
      signal: controller.signal,
    });
    controller.abort(new Error(canary));

    let failure: unknown;
    try {
      await operation;
    } catch (error) {
      failure = error;
    }
    expect(receivedSignals).toHaveLength(1);
    expect(receivedSignals[0]!.aborted).toBe(true);
    expect(failure).toMatchObject({ code: 'VISIBLE_TRANSCRIPT_TEST_KMS_ABORTED' });
    expect(String(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(canary);
  });
});
