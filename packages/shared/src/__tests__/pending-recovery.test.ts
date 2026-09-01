import { describe, expect, it } from 'vitest';

import {
  AbandonPendingUsageRecoveryResultSchema,
  CreateRecoveryRechargeOrderBodySchema,
  PendingUsageRecoveryListQuerySchema,
  PendingUsageRecoveryUsageParamsSchema,
  PendingUsageRecoveryViewSchema,
  RechargeRequiredBodySchema,
  RecoveryRechargeOrderViewSchema,
} from '../index.js';

const OWNER_USAGE_ID = '11111111-1111-4111-8111-111111111111';
const ACTIVE_INTENT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CAPABILITY_ID = '44444444-4444-4444-8444-444444444444';
const ORDER_ID = '55555555-5555-4555-8555-555555555555';

function activeRecovery() {
  return {
    usageId: OWNER_USAGE_ID,
    sessionId: SESSION_ID,
    capabilityId: CAPABILITY_ID,
    requestText: '退款规则是什么？',
    requestFingerprint: 'a'.repeat(64),
    binding: {
      productKind: 'knowledge_agent_test',
      capability: {
        id: CAPABILITY_ID,
        protocol: 'combo.agent-package-capability/2',
      },
      release: {
        protocol: 'combo.agent-package-release/1',
        releaseId: `release.agent-package.${'b'.repeat(32)}`,
        packageDigest: `sha256:${'c'.repeat(64)}`,
      },
      releaseScope: 'controlled_test',
      knowledge: {
        protocol: 'combo.knowledge-bundle/1',
        resourcePath: 'skills/knowledge/references/knowledge-bundle.json',
        resourceDigest: `sha256:${'d'.repeat(64)}`,
      },
    },
    billing: {
      currency: 'CNY',
      policyVersion: 'runtime-usage-v1',
      validatorPolicyVersion: 'knowledge-validator-v2',
      unitPriceCents: '1',
      freeLimitSnapshot: 3,
    },
    status: 'active',
    activeRechargeIntentId: ACTIVE_INTENT_ID,
    expiresAt: '2026-09-08T12:00:00.000Z',
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:05:00.000Z',
  } as const;
}

describe('pending usage recovery contracts', () => {
  it('parses only the owner-visible active server truth', () => {
    expect(PendingUsageRecoveryViewSchema.parse(activeRecovery())).toEqual(activeRecovery());
    expect(
      PendingUsageRecoveryViewSchema.safeParse({ ...activeRecovery(), requestText: ' padded ' })
        .success,
    ).toBe(false);
    expect(
      PendingUsageRecoveryViewSchema.safeParse({ ...activeRecovery(), gatewaySecret: 'hidden' })
        .success,
    ).toBe(false);
  });

  it('keeps list and exact-read selectors strict and canonical', () => {
    expect(
      PendingUsageRecoveryListQuerySchema.parse({ sessionId: SESSION_ID.toUpperCase() }),
    ).toEqual({ sessionId: SESSION_ID });
    expect(PendingUsageRecoveryListQuerySchema.parse({})).toEqual({});
    expect(PendingUsageRecoveryListQuerySchema.safeParse({ ownerUserId: SESSION_ID }).success).toBe(
      false,
    );
    expect(
      PendingUsageRecoveryUsageParamsSchema.parse({ usageId: OWNER_USAGE_ID.toUpperCase() }),
    ).toEqual({ usageId: OWNER_USAGE_ID });
  });

  it('extends 402 with the authoritative recovery usage while retaining rolling compatibility', () => {
    expect(
      RechargeRequiredBodySchema.parse({
        rechargeRequired: true,
        recoveryUsageId: OWNER_USAGE_ID.toUpperCase(),
        rechargeIntentId: ACTIVE_INTENT_ID.toUpperCase(),
        balanceCents: '0',
        requiredCents: '1',
      }),
    ).toEqual({
      rechargeRequired: true,
      recoveryUsageId: OWNER_USAGE_ID,
      rechargeIntentId: ACTIVE_INTENT_ID,
      balanceCents: '0',
      requiredCents: '1',
    });
    expect(
      RechargeRequiredBodySchema.safeParse({
        rechargeRequired: true,
        rechargeIntentId: OWNER_USAGE_ID,
        balanceCents: '0',
        requiredCents: '1',
      }).success,
    ).toBe(true);
  });

  it('requires explicit recovery and intent identities for every recovery order', () => {
    const parsed = CreateRecoveryRechargeOrderBodySchema.parse({
      recoveryUsageId: OWNER_USAGE_ID.toUpperCase(),
      rechargeIntentId: ACTIVE_INTENT_ID.toUpperCase(),
      amountCents: 1,
      channel: 'qr',
      payType: 'wechat',
    });
    expect(parsed).toEqual({
      recoveryUsageId: OWNER_USAGE_ID,
      rechargeIntentId: ACTIVE_INTENT_ID,
      amountCents: 1,
      channel: 'qr',
      payType: 'wechat',
    });
    expect(
      CreateRecoveryRechargeOrderBodySchema.safeParse({
        rechargeIntentId: ACTIVE_INTENT_ID,
        amountCents: 1,
        channel: 'qr',
        payType: 'wechat',
      }).success,
    ).toBe(false);
    expect(
      CreateRecoveryRechargeOrderBodySchema.safeParse({
        recoveryUsageId: OWNER_USAGE_ID,
        rechargeIntentId: ACTIVE_INTENT_ID,
        amountCents: 1,
        channel: 'qr',
        payType: 'wechat',
        recentOrder: true,
      }).success,
    ).toBe(false);
  });

  it('exposes only the safe recovery-linked order projection', () => {
    const view = {
      id: ORDER_ID,
      recoveryUsageId: OWNER_USAGE_ID,
      rechargeIntentId: ACTIVE_INTENT_ID,
      amountCents: '1',
      channel: 'qr',
      payType: 'alipay',
      status: 'pending',
      reconciliationActive: true,
      paymentAction: { kind: 'qr_code', url: 'https://qr.alipay.com/opaque' },
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:01:00.000Z',
    } as const;
    expect(RecoveryRechargeOrderViewSchema.parse(view)).toEqual(view);
    expect(
      RecoveryRechargeOrderViewSchema.safeParse({ ...view, payTraceNo: 'must-not-leak' }).success,
    ).toBe(false);
  });

  it('uses a minimal idempotent abandonment response', () => {
    expect(AbandonPendingUsageRecoveryResultSchema.parse({ abandoned: true })).toEqual({
      abandoned: true,
    });
    expect(
      AbandonPendingUsageRecoveryResultSchema.safeParse({ abandoned: true, requestText: 'leak' })
        .success,
    ).toBe(false);
  });
});
