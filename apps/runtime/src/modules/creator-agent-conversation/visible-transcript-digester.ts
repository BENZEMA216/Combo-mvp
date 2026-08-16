import { canonicalizeJson, HmacSha256DigestSchema, UuidSchema } from '@cb/creator-agent-protocol';

export const VISIBLE_TRANSCRIPT_HMAC_DOMAIN = 'combo:vnext:visible-transcript:v1\0' as const;
export const VISIBLE_TRANSCRIPT_PROTOCOL = 'combo.visible-transcript/1' as const;

const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const keyRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/u;
const namespacePattern = /^[a-z0-9][a-z0-9._:/-]{0,127}$/u;

export interface VisibleTranscriptKmsPolicy {
  /** Non-secret KMS namespace used to select a Creator + AgentVersion key family. */
  keyNamespace: string;
  /** Non-secret allowlisted prefix for the opaque KMS key reference returned by the port. */
  keyRefPrefix: string;
  /** Reject stale KMS responses after a version-policy rotation. */
  minimumKeyVersion: bigint;
}

export interface VisibleTranscriptKmsHmacInput {
  creatorId: string;
  agentVersionId: string;
  keyNamespace: string;
  message: Uint8Array;
  signal: AbortSignal;
}

export interface VisibleTranscriptKmsHmacResult {
  /** Raw 32-byte SHA-256 MAC returned by KMS; never persisted as key material. */
  mac: Uint8Array;
  keyId: string;
  keyVersion: bigint;
  keyRef: string;
}

/**
 * Narrow external KMS authority. Implementations select a tenant/version-scoped
 * HMAC key and return only the MAC plus public key metadata. They never return
 * raw key bytes to Runtime.
 */
export interface VisibleTranscriptKmsHmacPort {
  generateHmacSha256(
    input: VisibleTranscriptKmsHmacInput,
  ): VisibleTranscriptKmsHmacResult | Promise<VisibleTranscriptKmsHmacResult>;
}

export interface VisibleTranscriptDigestInput {
  creatorId: string;
  agentVersionId: string;
  signal: AbortSignal;
}

export interface VisibleTranscriptDigest {
  digest: string;
  keyId: string;
  keyVersion: bigint;
  keyRef: string;
}

export type VisibleTranscriptDigester = (
  input: VisibleTranscriptDigestInput,
) => Promise<VisibleTranscriptDigest>;

function assertPolicy(input: VisibleTranscriptKmsPolicy): VisibleTranscriptKmsPolicy {
  if (!namespacePattern.test(input.keyNamespace)) {
    throw new TypeError('visible transcript KMS namespace is invalid');
  }
  if (!keyRefPattern.test(input.keyRefPrefix)) {
    throw new TypeError('visible transcript KMS keyRef prefix is invalid');
  }
  if (input.minimumKeyVersion < 1n || input.minimumKeyVersion > 9_223_372_036_854_775_807n) {
    throw new TypeError('visible transcript KMS minimum key version is invalid');
  }
  return Object.freeze({ ...input });
}

function initialVisibleTranscriptBytes(agentVersionId: string): Buffer {
  const payload = {
    protocol: VISIBLE_TRANSCRIPT_PROTOCOL,
    schemaVersion: 1,
    agentVersionId: UuidSchema.parse(agentVersionId),
    messages: [],
  } as const;
  return Buffer.concat([
    Buffer.from(VISIBLE_TRANSCRIPT_HMAC_DOMAIN, 'utf8'),
    Buffer.from(canonicalizeJson(payload), 'utf8'),
  ]);
}

function validateResult(
  raw: VisibleTranscriptKmsHmacResult,
  policy: VisibleTranscriptKmsPolicy,
): VisibleTranscriptDigest {
  if (!(raw.mac instanceof Uint8Array) || raw.mac.byteLength !== 32) {
    throw new TypeError('visible transcript KMS MAC is invalid');
  }
  if (!keyIdPattern.test(raw.keyId)) {
    throw new TypeError('visible transcript KMS keyId is invalid');
  }
  if (
    typeof raw.keyVersion !== 'bigint' ||
    raw.keyVersion < policy.minimumKeyVersion ||
    raw.keyVersion > 9_223_372_036_854_775_807n
  ) {
    throw new TypeError('visible transcript KMS key version is outside policy');
  }
  if (!keyRefPattern.test(raw.keyRef) || !raw.keyRef.startsWith(policy.keyRefPrefix)) {
    throw new TypeError('visible transcript KMS keyRef is outside policy');
  }
  const digest = HmacSha256DigestSchema.parse(
    `hmac-sha256:${Buffer.from(raw.mac).toString('hex')}`,
  );
  return Object.freeze({
    digest,
    keyId: raw.keyId,
    keyVersion: raw.keyVersion,
    keyRef: raw.keyRef,
  });
}

/**
 * Builds the initial, empty visible-transcript digest for conversation.open.
 * The caller supplies only authenticated Creator/Version identity; neither the
 * public request nor the repository can inject a digest or raw KMS key.
 */
export function createVisibleTranscriptDigester(
  kms: VisibleTranscriptKmsHmacPort,
  rawPolicy: VisibleTranscriptKmsPolicy,
): VisibleTranscriptDigester {
  const policy = assertPolicy(rawPolicy);
  return async (input) => {
    const creatorId = UuidSchema.parse(input.creatorId);
    const agentVersionId = UuidSchema.parse(input.agentVersionId);
    if (input.signal.aborted) throw input.signal.reason;
    const result = await kms.generateHmacSha256({
      creatorId,
      agentVersionId,
      keyNamespace: policy.keyNamespace,
      message: initialVisibleTranscriptBytes(agentVersionId),
      signal: input.signal,
    });
    if (input.signal.aborted) throw input.signal.reason;
    return validateResult(result, policy);
  };
}
