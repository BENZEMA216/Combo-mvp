import { describe, expect, it } from 'vitest';

import {
  WorkerConversationReadyFactSchema,
  assertWorkerConversationReadyFactDigest,
  assertWorkerConversationReadyFactReplay,
  workerConversationReadyFactDigest,
  type WorkerConversationReadyFact,
} from '../conversation-ready-facts.js';
import { readFixture } from './fixture-helpers.js';

async function readyFixture(): Promise<{
  body: WorkerConversationReadyFact & { factDigest: string };
}> {
  return (await readFixture('broker-conversation-ready.v1.json')) as {
    body: WorkerConversationReadyFact & { factDigest: string };
  };
}

describe('Worker Conversation Ready durable facts', () => {
  it('parses the golden fact and binds its stable canonical digest', async () => {
    const { body } = await readyFixture();
    const { factDigest, ...factInput } = body;
    const fact = WorkerConversationReadyFactSchema.parse(factInput);

    expect(fact.sourceEventId).toBe(fact.openCommandId);
    expect(workerConversationReadyFactDigest(fact)).toBe(factDigest);
    expect(assertWorkerConversationReadyFactDigest(fact, factDigest)).toEqual(fact);
    expect(() => assertWorkerConversationReadyFactDigest(fact, '0'.repeat(64))).toThrow(
      'factDigest',
    );
  });

  it('changes for every original authority/evidence binding and rejects unknown fields', async () => {
    const { body } = await readyFixture();
    const { factDigest: _factDigest, ...fact } = body;
    const baseline = workerConversationReadyFactDigest(fact);
    const mutations = [
      { ...fact, conversationId: '0198f00d-5000-7000-8000-000000000011' },
      {
        ...fact,
        sourceEventId: '0198f00d-5000-7000-8000-000000000012',
        openCommandId: '0198f00d-5000-7000-8000-000000000012',
      },
      { ...fact, deploymentId: '0198f00d-5000-7000-8000-000000000013' },
      { ...fact, agentVersionId: '0198f00d-5000-7000-8000-000000000014' },
      { ...fact, agentVersionDigest: '1'.repeat(64) },
      { ...fact, snapshotDigest: '2'.repeat(64) },
      { ...fact, installationId: '0198f00d-5000-7000-8000-000000000015' },
      { ...fact, workerSessionId: '0198f00d-5000-7000-8000-000000000016' },
      { ...fact, leaseId: '0198f00d-5000-7000-8000-000000000017' },
      { ...fact, fence: '43' },
      { ...fact, sandboxInstanceId: '0198f00d-5000-7000-8000-000000000018' },
      { ...fact, runtimeThreadId: 'thread-conversation-002' },
      { ...fact, readyEvidenceDigest: `sha256:${'3'.repeat(64)}` },
    ] as const;
    for (const mutation of mutations) {
      expect(
        workerConversationReadyFactDigest(WorkerConversationReadyFactSchema.parse(mutation)),
      ).not.toBe(baseline);
    }
    expect(
      WorkerConversationReadyFactSchema.safeParse({ ...fact, transportReceipt: 'forbidden' })
        .success,
    ).toBe(false);
  });

  it('requires one stable open-command source and exact replay', async () => {
    const { body } = await readyFixture();
    const { factDigest: _factDigest, ...fact } = body;
    expect(
      WorkerConversationReadyFactSchema.safeParse({
        ...fact,
        sourceEventId: '0198f00d-5000-7000-8000-000000000099',
      }).success,
    ).toBe(false);
    expect(assertWorkerConversationReadyFactReplay(fact, structuredClone(fact))).toEqual(fact);
    expect(() => assertWorkerConversationReadyFactReplay(fact, { ...fact, fence: '43' })).toThrow(
      'replay',
    );
  });
});
