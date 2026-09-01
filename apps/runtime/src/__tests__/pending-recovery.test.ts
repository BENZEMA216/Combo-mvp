import { describe, expect, it } from 'vitest';

import type { KnowledgeAgentBinding } from '@cb/shared';
import {
  PendingUsageRecoveryConflictError,
  PendingUsageRecoveryExpiredError,
  assertPendingUsageRecoveryMatches,
  toPendingUsageRecoveryView,
  type PendingUsageRecoveryRecord,
} from '../modules/billing/pending-recovery.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const USAGE_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CAPABILITY_ID = '44444444-4444-4444-8444-444444444444';
const INTENT_ID = '55555555-5555-4555-8555-555555555555';

const binding: KnowledgeAgentBinding = {
  productKind: 'knowledge_agent_test',
  capability: { id: CAPABILITY_ID, protocol: 'combo.agent-package-capability/2' },
  release: {
    protocol: 'combo.agent-package-release/1',
    releaseId: `release.agent-package.${'a'.repeat(32)}`,
    packageDigest: `sha256:${'b'.repeat(64)}`,
  },
  releaseScope: 'controlled_test',
  knowledge: {
    protocol: 'combo.knowledge-bundle/1',
    resourcePath: 'skills/knowledge/references/knowledge-bundle.json',
    resourceDigest: `sha256:${'c'.repeat(64)}`,
  },
};

function record(overrides: Partial<PendingUsageRecoveryRecord> = {}): PendingUsageRecoveryRecord {
  return {
    ownerUserId: OWNER_ID,
    usageId: USAGE_ID,
    sessionId: SESSION_ID,
    capabilityId: CAPABILITY_ID,
    requestText: '退款规则是什么？',
    requestFingerprint: 'd'.repeat(64),
    binding,
    billingPolicyVersion: 'runtime-usage-v1',
    validatorPolicyVersion: 'knowledge-validator-v2',
    unitPriceCents: 1n,
    freeLimitSnapshot: 3,
    activeRechargeIntentId: INTENT_ID,
    recoveryStatus: 'active',
    terminalTurnId: null,
    expiresAt: new Date('2026-09-08T12:00:00.000Z'),
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    updatedAt: new Date('2026-09-01T12:05:00.000Z'),
    isUnexpired: true,
    ...overrides,
  };
}

const expected = {
  ownerUserId: OWNER_ID,
  usageId: USAGE_ID,
  sessionId: SESSION_ID,
  capabilityId: CAPABILITY_ID,
  requestText: '退款规则是什么？',
  requestFingerprint: 'd'.repeat(64),
  binding,
  billingPolicyVersion: 'runtime-usage-v1',
  validatorPolicyVersion: 'knowledge-validator-v2',
  unitPriceCents: 1n,
  freeLimitSnapshot: 3,
} as const;

describe('pending usage recovery invariants', () => {
  it('accepts only the exact active request and binding while trusting frozen row snapshots', () => {
    expect(() =>
      assertPendingUsageRecoveryMatches(record(), expected, new Date('2026-09-02T00:00:00Z')),
    ).not.toThrow();

    for (const mismatch of [
      { requestText: '价格是多少？' },
      { requestFingerprint: 'e'.repeat(64) },
      { sessionId: '66666666-6666-4666-8666-666666666666' },
      { capabilityId: '77777777-7777-4777-8777-777777777777' },
      {
        binding: {
          ...binding,
          release: { ...binding.release, packageDigest: `sha256:${'f'.repeat(64)}` },
        },
      },
    ]) {
      expect(() =>
        assertPendingUsageRecoveryMatches(
          record(),
          { ...expected, ...mismatch },
          new Date('2026-09-02T00:00:00Z'),
        ),
      ).toThrow(PendingUsageRecoveryConflictError);
    }
    expect(() =>
      assertPendingUsageRecoveryMatches(
        record(),
        {
          ...expected,
          billingPolicyVersion: 'current-deploy-v9',
          validatorPolicyVersion: 'current-validator-v9',
          unitPriceCents: 999n,
          freeLimitSnapshot: 99,
        },
        new Date('2026-09-02T00:00:00Z'),
      ),
    ).not.toThrow();
  });

  it('rejects expired, terminal, and cross-owner recovery reuse', () => {
    expect(() =>
      assertPendingUsageRecoveryMatches(record(), expected, new Date('2026-09-08T12:00:00Z')),
    ).toThrow(PendingUsageRecoveryExpiredError);
    expect(() =>
      assertPendingUsageRecoveryMatches(
        record({ recoveryStatus: 'abandoned', requestText: null }),
        expected,
        new Date('2026-09-02T00:00:00Z'),
      ),
    ).toThrow(PendingUsageRecoveryConflictError);
    expect(() =>
      assertPendingUsageRecoveryMatches(
        record({ ownerUserId: '88888888-8888-4888-8888-888888888888' }),
        expected,
        new Date('2026-09-02T00:00:00Z'),
      ),
    ).toThrow(PendingUsageRecoveryConflictError);
  });

  it('projects active server truth without owner or terminal internals', () => {
    expect(toPendingUsageRecoveryView(record())).toEqual({
      usageId: USAGE_ID,
      sessionId: SESSION_ID,
      capabilityId: CAPABILITY_ID,
      requestText: '退款规则是什么？',
      requestFingerprint: 'd'.repeat(64),
      binding,
      billing: {
        currency: 'CNY',
        policyVersion: 'runtime-usage-v1',
        validatorPolicyVersion: 'knowledge-validator-v2',
        unitPriceCents: '1',
        freeLimitSnapshot: 3,
      },
      status: 'active',
      activeRechargeIntentId: INTENT_ID,
      expiresAt: '2026-09-08T12:00:00.000Z',
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:05:00.000Z',
    });
    expect(() =>
      toPendingUsageRecoveryView(record({ recoveryStatus: 'accepted', requestText: null })),
    ).toThrow(PendingUsageRecoveryConflictError);
  });
});
