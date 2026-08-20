import { createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  ExecutionCapabilitySchema,
  ExecutionCapabilityUnsignedSchema,
  IsoDateTimeSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  UuidSchema,
  executionCapabilityDigest,
  executionCapabilitySigningBytes,
  parseJsonNoDuplicateKeys,
  type ExecutionCapability,
} from '@cb/creator-agent-protocol';
import { z } from 'zod';

const MAX_AUTHORITY_FILE_BYTES = 16 * 1_024;
const FatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const BudgetSchema = z
  .object({
    maxInputTokens: z.number().int().min(1).max(200_000),
    maxOutputTokens: z.number().int().min(1).max(32_768),
    maxCostMicros: z.number().int().min(1).max(100_000_000),
  })
  .strict();
export type InvocationExecutionBudget = z.infer<typeof BudgetSchema>;

const MountedExecutionAuthoritySchema = z
  .object({
    protocol: z.literal('combo.runtime-test-execution-authority/1'),
    schemaVersion: z.literal(1),
    privateKeyPkcs8Pem: z.string().min(128).max(8_192),
    budget: BudgetSchema,
  })
  .strict();

export interface ExecutionCapabilitySigner {
  sign(bytes: Uint8Array, signal: AbortSignal): Promise<string>;
}

export interface InvocationBudgetPort {
  resolve(
    input: Readonly<{ model: string; reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' }>,
    signal: AbortSignal,
  ): Promise<InvocationExecutionBudget>;
}

export interface InvocationPrepareAuthority {
  prepare(
    input: Readonly<{
      capabilityId: string;
      providerRequestId: string;
      invocationId: string;
      conversationId: string;
      deploymentId: string;
      agentVersionId: string;
      agentVersionDigest: string;
      installationId: string;
      leaseId: string;
      fence: string;
      requestDigest: string;
      model: string;
      reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
      notBefore: string;
      expiresAt: string;
      signal: AbortSignal;
    }>,
  ): Promise<Readonly<{ capability: ExecutionCapability; capabilityDigest: string }>>;
}

export class InvocationPrepareAuthorityError extends Error {
  public constructor() {
    super('EXECUTION_AUTHORITY_UNAVAILABLE');
    this.name = 'InvocationPrepareAuthorityError';
  }
}

export function createInvocationPrepareAuthority(
  signer: ExecutionCapabilitySigner,
  budgetPort: InvocationBudgetPort,
): InvocationPrepareAuthority {
  const authority: InvocationPrepareAuthority = {
    async prepare(input: Parameters<InvocationPrepareAuthority['prepare']>[0]) {
      try {
        input.signal.throwIfAborted();
        const budget = BudgetSchema.parse(
          await budgetPort.resolve(
            { model: input.model, reasoningEffort: input.reasoningEffort },
            input.signal,
          ),
        );
        const unsigned = ExecutionCapabilityUnsignedSchema.parse({
          protocol: 'combo.execution-capability/1',
          schemaVersion: 1,
          capabilityId: UuidSchema.parse(input.capabilityId),
          invocationId: UuidSchema.parse(input.invocationId),
          conversationId: UuidSchema.parse(input.conversationId),
          deploymentId: UuidSchema.parse(input.deploymentId),
          agentVersionId: UuidSchema.parse(input.agentVersionId),
          agentVersionDigest: Sha256HexSchema.parse(input.agentVersionDigest),
          workerInstallationId: UuidSchema.parse(input.installationId),
          leaseId: UuidSchema.parse(input.leaseId),
          fence: Uint63StringSchema.parse(input.fence),
          providerRequestId: UuidSchema.parse(input.providerRequestId),
          requestDigest: input.requestDigest,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          budget,
          notBefore: IsoDateTimeSchema.parse(input.notBefore),
          expiresAt: IsoDateTimeSchema.parse(input.expiresAt),
          nonce: randomBytes(32).toString('base64url'),
          signatureAlgorithm: 'ES256',
          signatureEncoding: 'ieee-p1363',
        });
        const signature = await signer.sign(
          executionCapabilitySigningBytes(unsigned),
          input.signal,
        );
        input.signal.throwIfAborted();
        const capability = ExecutionCapabilitySchema.parse({ ...unsigned, signature });
        return Object.freeze({
          capability,
          capabilityDigest: executionCapabilityDigest(capability),
        });
      } catch (error) {
        if (error instanceof InvocationPrepareAuthorityError) throw error;
        throw new InvocationPrepareAuthorityError();
      }
    },
  };
  return Object.freeze(authority);
}

/** Test-only signer and budget ports loaded from a process-owner-only mounted Secret file. */
export function loadTestInvocationPrepareAuthority(path: string): InvocationPrepareAuthority {
  try {
    if (!isAbsolute(path) || path.length > 1_024 || containsControlCharacter(path)) {
      throw new Error('path');
    }
    const mounted = readMountedAuthority(path);
    const privateKey = parseP256PrivateKey(mounted.privateKeyPkcs8Pem);
    const signer: ExecutionCapabilitySigner = Object.freeze({
      async sign(bytes: Uint8Array, signal: AbortSignal) {
        signal.throwIfAborted();
        const signature = sign('sha256', bytes, {
          key: privateKey,
          dsaEncoding: 'ieee-p1363',
        });
        signal.throwIfAborted();
        if (signature.byteLength !== 64) throw new InvocationPrepareAuthorityError();
        return signature.toString('base64url');
      },
    });
    const budgetPort: InvocationBudgetPort = Object.freeze({
      async resolve(_input: Parameters<InvocationBudgetPort['resolve']>[0], signal: AbortSignal) {
        signal.throwIfAborted();
        return mounted.budget;
      },
    });
    return createInvocationPrepareAuthority(signer, budgetPort);
  } catch (error) {
    if (error instanceof InvocationPrepareAuthorityError) throw error;
    throw new InvocationPrepareAuthorityError();
  }
}

function readMountedAuthority(path: string): z.infer<typeof MountedExecutionAuthoritySchema> {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    const currentUid = process.getuid?.();
    if (
      !stat.isFile() ||
      stat.size < 2 ||
      stat.size > MAX_AUTHORITY_FILE_BYTES ||
      (stat.mode & 0o077) !== 0 ||
      (currentUid !== undefined && stat.uid !== currentUid)
    ) {
      throw new Error('file authority');
    }
    return MountedExecutionAuthoritySchema.parse(
      parseJsonNoDuplicateKeys(FatalUtf8Decoder.decode(readFileSync(descriptor))),
    );
  } finally {
    closeSync(descriptor);
  }
}

function parseP256PrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (
    key.type !== 'private' ||
    key.asymmetricKeyType !== 'ec' ||
    !['prime256v1', 'P-256'].includes(key.asymmetricKeyDetails?.namedCurve ?? '')
  ) {
    throw new Error('execution key');
  }
  return key;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
