import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import {
  ExecutionCapabilitySchema,
  executionCapabilityBindingFrom,
  executionCapabilitySigningBytes,
  type ExecutionCapability,
  type ExpectedExecutionCapabilityBinding,
} from '@cb/creator-agent-protocol';

import { RegisteredExecutionCapabilityAuthority } from './capability-authority.js';
import { LeaseRegistry, type LeaseBinding } from './protocol.js';

export const IDS = {
  agentVersion: '0198f00d-0000-7000-8000-000000000001',
  conversationA: '0198f00d-0000-7000-8000-000000000002',
  conversationB: '0198f00d-0000-7000-8000-000000000003',
  invocationA: '0198f00d-0000-7000-8000-000000000004',
  invocationB: '0198f00d-0000-7000-8000-000000000005',
  deployment: '0198f00d-0000-7000-8000-000000000006',
  worker: '0198f00d-0000-7000-8000-000000000007',
  lease: '0198f00d-0000-7000-8000-000000000008',
  workerSession: '0198f00d-0000-7000-8000-00000000000d',
  providerRequest: '0198f00d-0000-7000-8000-000000000009',
  capability: '0198f00d-0000-7000-8000-00000000000a',
  userMessage: '0198f00d-0000-7000-8000-00000000000b',
  resultMessage: '0198f00d-0000-7000-8000-00000000000c',
} as const;

export const NOW_MS = Date.parse('2026-08-13T08:01:00.000Z');
export const DEADLINE_MS = Date.parse('2026-08-13T08:03:00.000Z');
export const REQUEST_DIGEST = `hmac-sha256:${'1'.repeat(64)}`;
export const AGENT_VERSION_DIGEST = '2'.repeat(64);

export interface SignedCapabilityFixture {
  readonly capability: ExecutionCapability;
  readonly expected: ExpectedExecutionCapabilityBinding;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly authority: RegisteredExecutionCapabilityAuthority;
}

export function createSignedCapabilityFixture(
  overrides: Partial<ExecutionCapability> = {},
): SignedCapabilityFixture {
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const unsigned: ExecutionCapability = {
    protocol: 'combo.execution-capability/1',
    schemaVersion: 1,
    capabilityId: IDS.capability,
    invocationId: IDS.invocationA,
    conversationId: IDS.conversationA,
    deploymentId: IDS.deployment,
    agentVersionId: IDS.agentVersion,
    agentVersionDigest: AGENT_VERSION_DIGEST,
    workerInstallationId: IDS.worker,
    leaseId: IDS.lease,
    fence: '0',
    providerRequestId: IDS.providerRequest,
    requestDigest: REQUEST_DIGEST,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    budget: {
      maxInputTokens: 4_096,
      maxOutputTokens: 1_024,
      maxCostMicros: 1_000_000,
    },
    notBefore: '2026-08-13T08:00:00.000Z',
    expiresAt: '2026-08-13T08:03:00.000Z',
    nonce: 'MDE5OGYwMGQtY2FwYWJpbGl0eS1ub25jZQ',
    signatureAlgorithm: 'ES256',
    signatureEncoding: 'ieee-p1363',
    signature: 'A'.repeat(86),
    ...overrides,
  };
  const capability = signCapability(unsigned, keyPair.privateKey);
  return {
    capability,
    expected: executionCapabilityBindingFrom(capability),
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    authority: new RegisteredExecutionCapabilityAuthority(keyPair.publicKey),
  };
}

export function signCapability(
  capability: ExecutionCapability,
  privateKey: KeyObject,
): ExecutionCapability {
  const signature = sign('sha256', executionCapabilitySigningBytes(capability), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return ExecutionCapabilitySchema.parse({ ...capability, signature });
}

export function createLeaseAuthority(nowMs = NOW_MS): {
  readonly registry: LeaseRegistry;
  readonly lease: LeaseBinding;
} {
  const registry = new LeaseRegistry();
  const lease = registry.acquire({
    leaseId: IDS.lease,
    deploymentId: IDS.deployment,
    workerId: IDS.worker,
    workerSessionId: IDS.workerSession,
    connectionId: 'connection-a',
    nowMs,
    ttlMs: 10 * 60_000,
  });
  return {
    registry,
    lease: {
      deploymentId: lease.deploymentId,
      leaseId: lease.leaseId,
      workerSessionId: lease.workerSessionId,
      fence: lease.fence.toString(10),
    },
  };
}
