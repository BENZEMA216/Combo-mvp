import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { canonicalizeJson, parseJsonNoDuplicateKeys, UuidSchema } from '@cb/creator-agent-protocol';
import { z } from 'zod';
import {
  createVisibleTranscriptDigester,
  VISIBLE_TRANSCRIPT_HMAC_DOMAIN,
  type VisibleTranscriptDigester,
  type VisibleTranscriptKmsHmacInput,
  type VisibleTranscriptKmsHmacResult,
  type VisibleTranscriptKmsPolicy,
} from '../../modules/creator-agent-conversation/visible-transcript-digester.js';

export const VISIBLE_TRANSCRIPT_TEST_KEYRING_PROTOCOL =
  'combo.visible-transcript-test-keyring/1' as const;
export const VISIBLE_TRANSCRIPT_TEST_KDF_DOMAIN =
  'combo:vnext:visible-transcript-test-key:v1\0' as const;
export const VISIBLE_TRANSCRIPT_TEST_KDF_PROTOCOL =
  'combo.visible-transcript-test-key-derivation/1' as const;
export const VISIBLE_TRANSCRIPT_TEST_KMS_TIMEOUT_MS = 500;

const MAX_KEYRING_BYTES = 64 * 1024;
const MAX_KEY_VERSION = 9_223_372_036_854_775_807n;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const keyRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/u;
const namespacePattern = /^[a-z0-9][a-z0-9._:/-]{0,127}$/u;
const keyVersionPattern = /^(?:[1-9][0-9]{0,18})$/u;
const base64UrlKeyPattern = /^[A-Za-z0-9_-]{43}$/u;

const KeyVersionSchema = z.string().regex(keyVersionPattern);
const KeyringEntrySchema = z
  .object({
    keyId: z.string().regex(keyIdPattern),
    keyVersion: KeyVersionSchema,
    keyRef: z.string().regex(keyRefPattern),
    keyBase64Url: z.string().regex(base64UrlKeyPattern),
  })
  .strict();
const KeyringSchema = z
  .object({
    protocol: z.literal(VISIBLE_TRANSCRIPT_TEST_KEYRING_PROTOCOL),
    keyNamespace: z.string().regex(namespacePattern),
    activeKeyVersion: KeyVersionSchema,
    keys: z.array(KeyringEntrySchema).min(1).max(16),
  })
  .strict();

type Keyring = z.infer<typeof KeyringSchema>;
type KeyringEntry = z.infer<typeof KeyringEntrySchema>;

export type VisibleTranscriptTestKmsErrorCode =
  | 'VISIBLE_TRANSCRIPT_TEST_KMS_ABORTED'
  | 'VISIBLE_TRANSCRIPT_TEST_KMS_UNAVAILABLE';

/** Stable, non-sensitive failure boundary. File paths, key metadata and key bytes are never attached. */
export class VisibleTranscriptTestKmsError extends Error {
  override readonly name = 'VisibleTranscriptTestKmsError';

  constructor(readonly code: VisibleTranscriptTestKmsErrorCode) {
    super(
      code === 'VISIBLE_TRANSCRIPT_TEST_KMS_ABORTED'
        ? 'visible transcript test key operation aborted'
        : 'visible transcript test key provider unavailable',
    );
  }
}

export interface VisibleTranscriptKmsBinding {
  readonly digester: VisibleTranscriptDigester;
  checkReady(signal?: AbortSignal): Promise<boolean>;
}

type ReadKeyringFile = (path: string, signal: AbortSignal) => Promise<Uint8Array>;

export interface VisibleTranscriptTestKmsOptions {
  /** Absolute path of a read-only Kubernetes Secret volume item. Never a raw key value. */
  readonly keyringFile: string;
  /** @internal deterministic unit-test seam; Runtime bootstrap never overrides this. */
  readonly readKeyringFile?: ReadKeyringFile;
}

function unavailable(signal?: AbortSignal): VisibleTranscriptTestKmsError {
  return new VisibleTranscriptTestKmsError(
    signal?.aborted
      ? 'VISIBLE_TRANSCRIPT_TEST_KMS_ABORTED'
      : 'VISIBLE_TRANSCRIPT_TEST_KMS_UNAVAILABLE',
  );
}

async function settleWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw unavailable(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(unavailable(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(unavailable(signal))),
    );
  });
}

async function defaultReadKeyringFile(path: string, signal: AbortSignal): Promise<Uint8Array> {
  return readFile(path, { signal });
}

function decodeRootKey(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) {
    decoded.fill(0);
    throw unavailable();
  }
  return decoded;
}

function parseVersion(value: string): bigint {
  const version = BigInt(value);
  if (version < 1n || version > MAX_KEY_VERSION) throw unavailable();
  return version;
}

function selectActiveKey(
  bytes: Uint8Array,
  policy: VisibleTranscriptKmsPolicy,
): { entry: KeyringEntry; keyVersion: bigint; rootKey: Buffer } {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_KEYRING_BYTES) throw unavailable();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const keyring: Keyring = KeyringSchema.parse(parseJsonNoDuplicateKeys(text));
  if (keyring.keyNamespace !== policy.keyNamespace) throw unavailable();

  const seenVersions = new Set<string>();
  const seenKeyIds = new Set<string>();
  const seenKeyRefs = new Set<string>();
  const seenRootKeys = new Set<string>();
  for (const entry of keyring.keys) {
    parseVersion(entry.keyVersion);
    if (
      seenVersions.has(entry.keyVersion) ||
      seenKeyIds.has(entry.keyId) ||
      seenKeyRefs.has(entry.keyRef) ||
      seenRootKeys.has(entry.keyBase64Url) ||
      !entry.keyRef.startsWith(policy.keyRefPrefix)
    ) {
      throw unavailable();
    }
    seenVersions.add(entry.keyVersion);
    seenKeyIds.add(entry.keyId);
    seenKeyRefs.add(entry.keyRef);
    seenRootKeys.add(entry.keyBase64Url);
    // Validate every version now so a malformed standby key cannot pass readiness.
    const candidateKey = decodeRootKey(entry.keyBase64Url);
    candidateKey.fill(0);
  }

  const activeMatches = keyring.keys.filter(
    (entry) => entry.keyVersion === keyring.activeKeyVersion,
  );
  if (activeMatches.length !== 1) throw unavailable();
  const entry = activeMatches[0]!;
  const keyVersion = parseVersion(entry.keyVersion);
  if (keyVersion < policy.minimumKeyVersion) throw unavailable();
  return { entry, keyVersion, rootKey: decodeRootKey(entry.keyBase64Url) };
}

function deriveScopedKey(input: {
  rootKey: Uint8Array;
  keyNamespace: string;
  creatorId: string;
  agentVersionId: string;
  keyId: string;
  keyVersion: bigint;
}): Buffer {
  const payload = canonicalizeJson({
    protocol: VISIBLE_TRANSCRIPT_TEST_KDF_PROTOCOL,
    keyNamespace: input.keyNamespace,
    creatorId: input.creatorId,
    agentVersionId: input.agentVersionId,
    keyId: input.keyId,
    keyVersion: input.keyVersion.toString(10),
  });
  return createHmac('sha256', input.rootKey)
    .update(VISIBLE_TRANSCRIPT_TEST_KDF_DOMAIN, 'utf8')
    .update(payload, 'utf8')
    .digest();
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.byteLength < prefix.byteLength) return false;
  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

/**
 * Test-only Kubernetes Secret file adapter. This is deliberately not a production KMS or a
 * real-provider substitute: the root key is present in Runtime memory while one HMAC is computed.
 */
export function createVisibleTranscriptTestKmsBinding(
  policy: VisibleTranscriptKmsPolicy,
  options: VisibleTranscriptTestKmsOptions,
): VisibleTranscriptKmsBinding {
  if (!isAbsolute(options.keyringFile) || options.keyringFile.includes('\0')) throw unavailable();
  const readKeyringFile = options.readKeyringFile ?? defaultReadKeyringFile;

  const withActiveKey = async <T>(
    signal: AbortSignal | undefined,
    use: (active: { entry: KeyringEntry; keyVersion: bigint; rootKey: Buffer }) => T | Promise<T>,
  ): Promise<T> => {
    const timeout = AbortSignal.timeout(VISIBLE_TRANSCRIPT_TEST_KMS_TIMEOUT_MS);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let bytes: Uint8Array | undefined;
    let rootKey: Buffer | undefined;
    try {
      if (bounded.aborted) throw unavailable(signal);
      bytes = await settleWithSignal(readKeyringFile(options.keyringFile, bounded), bounded);
      const active = selectActiveKey(bytes, policy);
      rootKey = active.rootKey;
      if (bounded.aborted) throw unavailable(signal);
      const result = await use(active);
      if (bounded.aborted) throw unavailable(signal);
      return result;
    } catch {
      throw unavailable(signal);
    } finally {
      bytes?.fill(0);
      rootKey?.fill(0);
    }
  };

  const generateHmacSha256 = async (
    input: VisibleTranscriptKmsHmacInput,
  ): Promise<VisibleTranscriptKmsHmacResult> => {
    return withActiveKey(input.signal, (active) => {
      let scopedKey: Buffer | undefined;
      try {
        const creatorId = UuidSchema.parse(input.creatorId);
        const agentVersionId = UuidSchema.parse(input.agentVersionId);
        if (input.keyNamespace !== policy.keyNamespace) throw unavailable();
        const transcriptDomain = Buffer.from(VISIBLE_TRANSCRIPT_HMAC_DOMAIN, 'utf8');
        if (!startsWith(input.message, transcriptDomain)) throw unavailable();
        scopedKey = deriveScopedKey({
          rootKey: active.rootKey,
          keyNamespace: input.keyNamespace,
          creatorId,
          agentVersionId,
          keyId: active.entry.keyId,
          keyVersion: active.keyVersion,
        });
        return {
          mac: createHmac('sha256', scopedKey).update(input.message).digest(),
          keyId: active.entry.keyId,
          keyVersion: active.keyVersion,
          keyRef: active.entry.keyRef,
        };
      } finally {
        scopedKey?.fill(0);
      }
    });
  };

  return Object.freeze({
    digester: createVisibleTranscriptDigester({ generateHmacSha256 }, policy),
    async checkReady(signal?: AbortSignal): Promise<boolean> {
      try {
        return await withActiveKey(signal, () => true);
      } catch {
        return false;
      }
    },
  });
}
