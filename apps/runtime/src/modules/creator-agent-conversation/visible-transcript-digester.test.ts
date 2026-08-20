import { createHmac } from 'node:crypto';
import { canonicalizeJson } from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';
import {
  createVisibleTranscriptDigester,
  VISIBLE_TRANSCRIPT_HMAC_DOMAIN,
  type VisibleTranscriptKmsHmacInput,
  type VisibleTranscriptKmsHmacPort,
} from './visible-transcript-digester.js';

const CREATOR = '01900000-0000-7000-8000-000000000001';
const VERSION = '01900000-0000-7000-8000-000000000002';
const ROTATED_VERSION = '01900000-0000-7000-8000-000000000003';

function kmsFixture(input: {
  key: Uint8Array;
  keyId?: string;
  keyVersion?: bigint;
  keyRef?: string;
  capture?: VisibleTranscriptKmsHmacInput[];
}): VisibleTranscriptKmsHmacPort {
  return {
    generateHmacSha256(request) {
      input.capture?.push({ ...request, message: Buffer.from(request.message) });
      return {
        mac: createHmac('sha256', input.key).update(request.message).digest(),
        keyId: input.keyId ?? 'visible-key-a',
        keyVersion: input.keyVersion ?? 7n,
        keyRef: input.keyRef ?? 'kms://combo/visible/creator/version/key-a@7',
      };
    },
  };
}

const policy = {
  keyNamespace: 'combo/visible-transcript',
  keyRefPrefix: 'kms://combo/visible/',
  minimumKeyVersion: 7n,
} as const;

describe('VisibleTranscriptDigester', () => {
  it('sends exact domain-NUL plus RFC 8785 JCS bytes to Creator+Version KMS authority', async () => {
    const calls: VisibleTranscriptKmsHmacInput[] = [];
    const digester = createVisibleTranscriptDigester(
      kmsFixture({ key: Buffer.alloc(32, 1), capture: calls }),
      policy,
    );

    const result = await digester({
      creatorId: CREATOR,
      agentVersionId: VERSION,
      signal: AbortSignal.timeout(1_000),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      creatorId: CREATOR,
      agentVersionId: VERSION,
      keyNamespace: 'combo/visible-transcript',
    });
    expect(Buffer.from(calls[0]!.message).toString('utf8')).toBe(
      VISIBLE_TRANSCRIPT_HMAC_DOMAIN +
        canonicalizeJson({
          protocol: 'combo.visible-transcript/1',
          schemaVersion: 1,
          agentVersionId: VERSION,
          messages: [],
        }),
    );
    expect(result).toEqual({
      digest: `hmac-sha256:${createHmac('sha256', Buffer.alloc(32, 1))
        .update(calls[0]!.message)
        .digest('hex')}`,
      keyId: 'visible-key-a',
      keyVersion: 7n,
      keyRef: 'kms://combo/visible/creator/version/key-a@7',
    });
    expect(Object.keys(result)).not.toContain('key');
  });

  it('rotates by Creator+AgentVersion key without changing the canonical payload contract', async () => {
    const firstCalls: VisibleTranscriptKmsHmacInput[] = [];
    const secondCalls: VisibleTranscriptKmsHmacInput[] = [];
    const first = createVisibleTranscriptDigester(
      kmsFixture({ key: Buffer.alloc(32, 2), capture: firstCalls }),
      policy,
    );
    const rotated = createVisibleTranscriptDigester(
      kmsFixture({
        key: Buffer.alloc(32, 3),
        keyId: 'visible-key-b',
        keyVersion: 8n,
        keyRef: 'kms://combo/visible/creator/version/key-b@8',
        capture: secondCalls,
      }),
      policy,
    );

    const one = await first({
      creatorId: CREATOR,
      agentVersionId: VERSION,
      signal: AbortSignal.timeout(1_000),
    });
    const two = await rotated({
      creatorId: CREATOR,
      agentVersionId: ROTATED_VERSION,
      signal: AbortSignal.timeout(1_000),
    });

    expect(one.digest).not.toBe(two.digest);
    expect(two).toMatchObject({ keyId: 'visible-key-b', keyVersion: 8n });
    expect(Buffer.from(firstCalls[0]!.message).toString('utf8')).toContain(VERSION);
    expect(Buffer.from(secondCalls[0]!.message).toString('utf8')).toContain(ROTATED_VERSION);
  });

  it.each([
    [
      'short MAC',
      {
        generateHmacSha256: () => ({
          mac: Buffer.alloc(31),
          keyId: 'visible-key-a',
          keyVersion: 7n,
          keyRef: 'kms://combo/visible/key-a@7',
        }),
      },
    ],
    ['stale key version', kmsFixture({ key: Buffer.alloc(32, 4), keyVersion: 6n })],
    ['foreign keyRef', kmsFixture({ key: Buffer.alloc(32, 5), keyRef: 'kms://foreign/key-a@7' })],
  ] as const)('rejects tampered KMS metadata or output: %s', async (_name, kms) => {
    const digester = createVisibleTranscriptDigester(kms, policy);
    await expect(
      digester({
        creatorId: CREATOR,
        agentVersionId: VERSION,
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toThrow(/visible transcript KMS/u);
  });
});
