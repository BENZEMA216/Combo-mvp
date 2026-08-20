import { describe, expect, it } from 'vitest';

import {
  WorkerConversationReadyFactSchema,
  workerConversationReadyFactDigest,
  type WorkerConversationReadyFact,
} from '../conversation-ready-facts.js';
import { readFixture } from './fixture-helpers.js';
import {
  PROPERTY_RUNS,
  PROPERTY_SEED_BASE,
  PROPERTY_SEED_COUNT,
  propertySeedMatrix,
} from './property-matrix.js';

class XorShift32 {
  public constructor(private state: number) {
    if (state === 0) this.state = 0x6d2b79f5;
  }

  public next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }
}

describe('Worker Conversation Ready fact property model', () => {
  it(`${PROPERTY_SEED_COUNT} seeds from ${PROPERTY_SEED_BASE} mutate ${PROPERTY_RUNS} facts and always change the canonical factDigest`, async () => {
    const envelope = (await readFixture('broker-conversation-ready.v1.json')) as {
      body: WorkerConversationReadyFact & { factDigest: string };
    };
    const { factDigest: _factDigest, ...fact } = envelope.body;
    const baseline = workerConversationReadyFactDigest(fact);
    const mutations = (
      random: XorShift32,
    ): ReadonlyArray<(value: WorkerConversationReadyFact) => unknown> => [
      (value) => ({ ...value, conversationId: '0198f00d-5000-7000-8000-000000000011' }),
      (value) => ({
        ...value,
        sourceEventId: '0198f00d-5000-7000-8000-000000000012',
        openCommandId: '0198f00d-5000-7000-8000-000000000012',
      }),
      (value) => ({ ...value, deploymentId: '0198f00d-5000-7000-8000-000000000013' }),
      (value) => ({ ...value, agentVersionId: '0198f00d-5000-7000-8000-000000000014' }),
      (value) => ({ ...value, agentVersionDigest: '1'.repeat(64) }),
      (value) => ({ ...value, snapshotDigest: '2'.repeat(64) }),
      (value) => ({ ...value, installationId: '0198f00d-5000-7000-8000-000000000015' }),
      (value) => ({ ...value, workerSessionId: '0198f00d-5000-7000-8000-000000000016' }),
      (value) => ({ ...value, leaseId: '0198f00d-5000-7000-8000-000000000017' }),
      (value) => ({ ...value, fence: String(43 + (random.next() % 1000)) }),
      (value) => ({ ...value, sandboxInstanceId: '0198f00d-5000-7000-8000-000000000018' }),
      (value) => ({ ...value, runtimeThreadId: `thread-conversation-${random.next()}` }),
      (value) => ({ ...value, readyEvidenceDigest: `sha256:${'3'.repeat(64)}` }),
    ];

    for (const { seed, runs } of propertySeedMatrix()) {
      const random = new XorShift32(seed);
      const seedMutations = mutations(random);
      for (let run = 0; run < runs; run += 1) {
        const mutate = seedMutations[random.next() % seedMutations.length]!;
        const mutation = WorkerConversationReadyFactSchema.parse(mutate(fact));
        expect(workerConversationReadyFactDigest(mutation)).not.toBe(baseline);
      }
    }
  });
});
