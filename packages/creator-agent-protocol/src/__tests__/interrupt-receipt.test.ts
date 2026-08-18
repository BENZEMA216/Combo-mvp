import { describe, expect, it } from 'vitest';

// VNext registry case: SCH-001 interrupt receipt goldens and Broker bindings.

import { BrokerEnvelopeSchema, parseBrokerFrame } from '../broker.js';
import {
  WorkerInvocationCancelledFactSchema,
  workerInvocationFactDigest,
} from '../invocation-facts.js';
import {
  WorkerCancelReasonSchema,
  WorkerInterruptReceiptSchema,
  workerInterruptReceiptDigest,
  type WorkerInterruptReceipt,
} from '../interrupt-receipt.js';
import { readFixture, readFixtureText } from './fixture-helpers.js';

const alternateUuid = '0198f00d-6000-7000-8000-000000000099';

function localReceipt(
  host: WorkerInterruptReceipt,
  phase: 'PREPARED' | 'STARTING',
): WorkerInterruptReceipt {
  return WorkerInterruptReceiptSchema.parse({
    ...host,
    outcome: 'PROVED_NOT_EXECUTED',
    evidenceAuthority: 'LOCAL_DISPATCH_COUNTER',
    dispatchAttemptCount: 0,
    startCommandId: phase === 'PREPARED' ? null : host.startCommandId,
    dispatchNonce: phase === 'PREPARED' ? null : host.dispatchNonce,
    runtimeThreadId: null,
    runtimeTurnId: null,
    dispatchReceiptDigest: null,
    sandboxInstanceId: null,
    sandboxAttestationDigest: null,
    hostTerminalDigest: null,
  });
}

function recomputeCancelledFactDigest(body: Record<string, unknown>): string {
  const fact = WorkerInvocationCancelledFactSchema.parse({
    protocol: body.protocol,
    schemaVersion: body.schemaVersion,
    type: body.type,
    sourceEventId: body.sourceEventId,
    invocationId: body.invocationId,
    agentVersionDigest: body.agentVersionDigest,
    snapshotDigest: body.snapshotDigest,
    executionCapabilityDigest: body.executionCapabilityDigest,
    leaseId: body.leaseId,
    fence: body.fence,
    interruptReceiptDigest: body.interruptReceiptDigest,
  });
  return workerInvocationFactDigest(fact);
}

describe('Worker interrupt receipt contract', () => {
  it('freezes HOST and both zero-dispatch LOCAL canonical digests', async () => {
    const host = WorkerInterruptReceiptSchema.parse(
      await readFixture('worker-interrupt-receipt.v1.json'),
    );
    expect(workerInterruptReceiptDigest(host)).toBe(
      'sha256:4286a6461aeddb087f310ba2c290c65c00648c5919e5128369ae91c705947309',
    );
    expect(workerInterruptReceiptDigest(localReceipt(host, 'PREPARED'))).toBe(
      'sha256:4d7b82e024bfce59aec3717c48668b84b0bd378a1be8775809e95d59e7bf54ea',
    );
    expect(workerInterruptReceiptDigest(localReceipt(host, 'STARTING'))).toBe(
      'sha256:97ba79b1e6e3dc8062417db3f9bd53c178b68798c2d4314e59c7566e45dd1732',
    );
  });

  it('binds every mutable receipt field and rejects every fixed-field mutation', async () => {
    const host = WorkerInterruptReceiptSchema.parse(
      await readFixture('worker-interrupt-receipt.v1.json'),
    );
    const baseline = workerInterruptReceiptDigest(host);
    const mutations: ReadonlyArray<readonly [keyof typeof host, unknown]> = [
      ['installationId', alternateUuid],
      ['invocationId', alternateUuid],
      ['conversationId', alternateUuid],
      ['agentVersionId', alternateUuid],
      ['agentVersionDigest', '1'.repeat(64)],
      ['snapshotDigest', '2'.repeat(64)],
      ['leaseId', alternateUuid],
      ['fence', '43'],
      ['executionCapabilityDigest', '3'.repeat(64)],
      ['startCommandId', alternateUuid],
      ['cancelCommandId', alternateUuid],
      ['cancelReason', 'DEADLINE'],
      ['interruptNonce', alternateUuid],
      ['dispatchNonce', alternateUuid],
      ['runtimeThreadId', 'thread-interrupt-002'],
      ['runtimeTurnId', 'turn-interrupt-002'],
      ['dispatchReceiptDigest', `sha256:${'4'.repeat(64)}`],
      ['sandboxInstanceId', alternateUuid],
      ['sandboxAttestationDigest', `sha256:${'5'.repeat(64)}`],
      ['hostTerminalDigest', `sha256:${'6'.repeat(64)}`],
    ];
    for (const [field, value] of mutations) {
      const parsed = WorkerInterruptReceiptSchema.parse({ ...host, [field]: value });
      expect(workerInterruptReceiptDigest(parsed), field).not.toBe(baseline);
    }
    for (const [field, value] of [
      ['protocol', 'combo.worker-interrupt-receipt/2'],
      ['schemaVersion', 2],
      ['outcome', 'PROVED_NOT_EXECUTED'],
      ['evidenceAuthority', 'LOCAL_DISPATCH_COUNTER'],
      ['dispatchAttemptCount', 2],
    ] as const) {
      expect(
        WorkerInterruptReceiptSchema.safeParse({ ...host, [field]: value }).success,
        field,
      ).toBe(false);
    }
  });

  it('admits only the two exact LOCAL lineages and one complete HOST proof', async () => {
    const host = WorkerInterruptReceiptSchema.parse(
      await readFixture('worker-interrupt-receipt.v1.json'),
    );
    const prepared = localReceipt(host, 'PREPARED');
    const starting = localReceipt(host, 'STARTING');
    expect(WorkerInterruptReceiptSchema.safeParse(prepared).success).toBe(true);
    expect(WorkerInterruptReceiptSchema.safeParse(starting).success).toBe(true);

    for (const invalid of [
      { ...prepared, startCommandId: host.startCommandId },
      { ...prepared, dispatchNonce: host.dispatchNonce },
      { ...starting, startCommandId: null },
      { ...starting, dispatchNonce: null },
      { ...prepared, runtimeThreadId: host.runtimeThreadId },
      { ...host, dispatchAttemptCount: 0 },
      { ...host, hostTerminalDigest: null },
      { ...host, rawHostReceipt: 'forbidden' },
    ]) {
      expect(WorkerInterruptReceiptSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('reuses the closed cancel reason enum', () => {
    expect(WorkerCancelReasonSchema.options).toEqual([
      'CONSUMER_REQUEST',
      'DRAIN_DEADLINE',
      'SECURITY_REVOKE',
      'DEADLINE',
    ]);
    expect(WorkerCancelReasonSchema.safeParse('MODEL_DECIDED').success).toBe(false);
  });

  it('parses cancel/cancelled goldens and binds receipt digest plus exact fact fields', async () => {
    const command = await readFixture('broker-invocation-cancel.v1.json');
    const cancelled = BrokerEnvelopeSchema.parse(
      await readFixture('broker-invocation-cancelled.v1.json'),
    );
    expect(BrokerEnvelopeSchema.safeParse(command).success).toBe(true);
    expect(parseBrokerFrame(await readFixtureText('broker-invocation-cancelled.v1.json'))).toEqual(
      cancelled,
    );
    if (cancelled.type !== 'invocation.cancelled') throw new Error('fixture type mismatch');
    expect(workerInterruptReceiptDigest(cancelled.body.interruptReceipt)).toBe(
      cancelled.body.interruptReceiptDigest,
    );

    const changedReceipt = structuredClone(cancelled);
    if (changedReceipt.type !== 'invocation.cancelled') throw new Error('fixture type mismatch');
    changedReceipt.body.interruptReceipt.interruptNonce = alternateUuid;
    expect(BrokerEnvelopeSchema.safeParse(changedReceipt).success).toBe(false);

    const unknownReason = structuredClone(command) as {
      body: { reason: string };
    };
    unknownReason.body.reason = 'MODEL_DECIDED';
    expect(BrokerEnvelopeSchema.safeParse(unknownReason).success).toBe(false);
  });

  it('rejects receipt/fact cross-mixes even when both canonical digests are recomputed', async () => {
    const baseline = BrokerEnvelopeSchema.parse(
      await readFixture('broker-invocation-cancelled.v1.json'),
    );
    if (baseline.type !== 'invocation.cancelled') throw new Error('fixture type mismatch');
    for (const [field, value] of [
      ['invocationId', alternateUuid],
      ['agentVersionDigest', '1'.repeat(64)],
      ['snapshotDigest', '2'.repeat(64)],
      ['executionCapabilityDigest', '3'.repeat(64)],
      ['leaseId', alternateUuid],
      ['fence', '43'],
    ] as const) {
      const candidate = structuredClone(baseline);
      if (candidate.type !== 'invocation.cancelled') throw new Error('fixture type mismatch');
      candidate.body.interruptReceipt = WorkerInterruptReceiptSchema.parse({
        ...candidate.body.interruptReceipt,
        [field]: value,
      });
      candidate.body.interruptReceiptDigest = workerInterruptReceiptDigest(
        candidate.body.interruptReceipt,
      );
      candidate.body.factDigest = recomputeCancelledFactDigest(
        candidate.body as unknown as Record<string, unknown>,
      );
      expect(BrokerEnvelopeSchema.safeParse(candidate).success, field).toBe(false);
    }
  });

  it('exposes only bounded control identities and digests', async () => {
    const receipt = WorkerInterruptReceiptSchema.parse(
      await readFixture('worker-interrupt-receipt.v1.json'),
    );
    expect(Object.keys(receipt).sort()).toEqual(
      [
        'protocol',
        'schemaVersion',
        'installationId',
        'invocationId',
        'conversationId',
        'agentVersionId',
        'agentVersionDigest',
        'snapshotDigest',
        'leaseId',
        'fence',
        'executionCapabilityDigest',
        'startCommandId',
        'cancelCommandId',
        'cancelReason',
        'interruptNonce',
        'outcome',
        'evidenceAuthority',
        'dispatchAttemptCount',
        'dispatchNonce',
        'runtimeThreadId',
        'runtimeTurnId',
        'dispatchReceiptDigest',
        'sandboxInstanceId',
        'sandboxAttestationDigest',
        'hostTerminalDigest',
      ].sort(),
    );
    expect(JSON.stringify(receipt)).not.toMatch(
      /prompt|answer|plaintext|ciphertext|rawHost|cookie|token|credential/iu,
    );
  });
});
