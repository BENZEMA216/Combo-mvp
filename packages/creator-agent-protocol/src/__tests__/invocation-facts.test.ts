import { describe, expect, it } from 'vitest';

import {
  WorkerInvocationFactSchema,
  assertWorkerInvocationFactDigest,
  assertWorkerInvocationFactReplay,
  workerInvocationFactDigest,
  type WorkerInvocationPreparedFact,
  type WorkerInvocationStartedFact,
  type WorkerInvocationSucceededFact,
} from '../invocation-facts.js';

const prepared = Object.freeze({
  protocol: 'combo.worker-invocation-fact/1',
  schemaVersion: 1,
  type: 'invocation.prepared',
  sourceEventId: '0198f00d-5000-7000-8000-000000000004',
  invocationId: '0198f00d-5000-7000-8000-000000000002',
  agentVersionDigest: 'a'.repeat(64),
  snapshotDigest: 'b'.repeat(64),
  executionCapabilityDigest: 'c'.repeat(64),
  leaseId: '0198f00d-5000-7000-8000-000000000003',
  fence: '42',
  requestDigest: `hmac-sha256:${'d'.repeat(64)}`,
  prepareCommandId: '0198f00d-5000-7000-8000-000000000004',
} as const satisfies WorkerInvocationPreparedFact);

const started = Object.freeze({
  protocol: 'combo.worker-invocation-fact/1',
  schemaVersion: 1,
  type: 'invocation.started',
  sourceEventId: '0198f00d-5000-7000-8000-000000000005',
  invocationId: prepared.invocationId,
  agentVersionDigest: prepared.agentVersionDigest,
  snapshotDigest: prepared.snapshotDigest,
  executionCapabilityDigest: prepared.executionCapabilityDigest,
  leaseId: prepared.leaseId,
  fence: prepared.fence,
  startCommandId: '0198f00d-5000-7000-8000-000000000005',
  runtimeThreadId: 'thread-vnext-001',
  runtimeTurnId: 'turn-vnext-001',
  dispatchReceiptDigest: `sha256:${'e'.repeat(64)}`,
  sandboxAttestationDigest: `sha256:${'f'.repeat(64)}`,
} as const satisfies WorkerInvocationStartedFact);

const succeeded = Object.freeze({
  protocol: 'combo.worker-invocation-fact/1',
  schemaVersion: 1,
  type: 'invocation.succeeded',
  sourceEventId: prepared.invocationId,
  invocationId: prepared.invocationId,
  agentVersionDigest: prepared.agentVersionDigest,
  snapshotDigest: prepared.snapshotDigest,
  executionCapabilityDigest: prepared.executionCapabilityDigest,
  leaseId: prepared.leaseId,
  fence: prepared.fence,
  runtimeThreadId: started.runtimeThreadId,
  runtimeTurnId: started.runtimeTurnId,
  startedFactDigest: workerInvocationFactDigest(started),
  resultDigest: `hmac-sha256:${'1'.repeat(64)}`,
  localResultCipherDigest: '2'.repeat(64),
} as const satisfies WorkerInvocationSucceededFact);

describe('SCH-001 Worker Invocation fact identity', () => {
  it('uses one strict canonical digest in both journals', () => {
    const digest = workerInvocationFactDigest(prepared);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(assertWorkerInvocationFactDigest(prepared, digest)).toEqual(prepared);
    expect(() => assertWorkerInvocationFactDigest(prepared, '0'.repeat(64))).toThrow('factDigest');
  });

  it('changes for every authority binding and rejects unknown fields', () => {
    const baseline = workerInvocationFactDigest(prepared);
    const mutations = [
      { ...prepared, invocationId: '0198f00d-5000-7000-8000-000000000012' },
      { ...prepared, agentVersionDigest: 'e'.repeat(64) },
      { ...prepared, snapshotDigest: 'f'.repeat(64) },
      { ...prepared, executionCapabilityDigest: '1'.repeat(64) },
      { ...prepared, leaseId: '0198f00d-5000-7000-8000-000000000013' },
      { ...prepared, fence: '43' },
      { ...prepared, requestDigest: `hmac-sha256:${'2'.repeat(64)}` },
      {
        ...prepared,
        sourceEventId: '0198f00d-5000-7000-8000-000000000014',
        prepareCommandId: '0198f00d-5000-7000-8000-000000000014',
      },
    ] as const;
    for (const mutation of mutations) {
      expect(workerInvocationFactDigest(WorkerInvocationFactSchema.parse(mutation))).not.toBe(
        baseline,
      );
    }
    expect(
      WorkerInvocationFactSchema.safeParse({ ...prepared, rawPrompt: 'forbidden' }).success,
    ).toBe(false);
  });

  it('derives one stable phase source identity and rejects transport-derived replacements', () => {
    expect(
      WorkerInvocationFactSchema.safeParse({
        ...prepared,
        sourceEventId: '0198f00d-5000-7000-8000-000000000099',
      }).success,
    ).toBe(false);
    expect(
      WorkerInvocationFactSchema.safeParse({
        ...started,
        sourceEventId: '0198f00d-5000-7000-8000-000000000099',
      }).success,
    ).toBe(false);
    expect(
      WorkerInvocationFactSchema.safeParse({
        ...succeeded,
        sourceEventId: '0198f00d-5000-7000-8000-000000000099',
      }).success,
    ).toBe(false);
  });

  it('binds success to the exact queryable Host turn and started fact', () => {
    const digest = workerInvocationFactDigest(succeeded);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    for (const mutation of [
      { ...succeeded, runtimeThreadId: 'thread-vnext-002' },
      { ...succeeded, runtimeTurnId: 'turn-vnext-002' },
      { ...succeeded, startedFactDigest: '3'.repeat(64) },
    ]) {
      expect(workerInvocationFactDigest(mutation)).not.toBe(digest);
    }
  });

  it('accepts only an exact durable fact replay across transport re-enveloping', () => {
    expect(assertWorkerInvocationFactReplay(prepared, structuredClone(prepared))).toEqual(prepared);
    expect(() =>
      assertWorkerInvocationFactReplay(prepared, {
        ...prepared,
        requestDigest: `hmac-sha256:${'9'.repeat(64)}`,
      }),
    ).toThrow('replay');
    expect(() => assertWorkerInvocationFactReplay(prepared, started)).toThrow('replay');
  });
});
