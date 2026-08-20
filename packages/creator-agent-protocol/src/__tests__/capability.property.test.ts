import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ExecutionCapabilitySchema,
  decideExecutionCapabilityUse,
  executionCapabilitySigningBytes,
  type ExecutionCapability,
  type ExecutionCapabilityUseRecord,
} from '../broker.js';
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

function signCapability(
  capability: ExecutionCapability,
  privateKey: KeyObject,
): ExecutionCapability {
  const signature = sign('sha256', executionCapabilitySigningBytes(capability), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return ExecutionCapabilitySchema.parse({ ...capability, signature });
}

describe('Execution Capability durable use property model', () => {
  it(`${PROPERTY_SEED_COUNT} seeds from ${PROPERTY_SEED_BASE} run ${PROPERTY_RUNS} replay/second-turn decisions with upstream attempt <= 1`, async () => {
    const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const prepare = (await readFixture('broker-invocation-prepare.v1.json')) as {
      body: { executionCapability: unknown };
    };
    const capability = signCapability(
      ExecutionCapabilitySchema.parse(prepare.body.executionCapability),
      keyPair.privateKey,
    );
    for (const { seed, runs } of propertySeedMatrix()) {
      const first = decideExecutionCapabilityUse(capability, null);
      if (first.action !== 'DISPATCH_ONCE') throw new Error('first use 必须 dispatch');
      const random = new XorShift32(seed);
      let record: ExecutionCapabilityUseRecord = first.nextRecord;
      let dispatchDecisions = 1;

      for (let run = 0; run < runs; run += 1) {
        if (record.state === 'DISPATCHED' && random.next() % 97 === 0) {
          record = {
            ...record,
            state: 'DURABLE_RESULT',
            resultDigest: `hmac-sha256:${'9'.repeat(64)}`,
          };
        }
        const secondTurn = Boolean(random.next() & 1);
        const candidate = secondTurn
          ? signCapability(
              {
                ...capability,
                invocationId: '0198f00d-9999-7999-8999-999999999995',
                providerRequestId: '0198f00d-9999-7999-8999-999999999996',
                requestDigest: `hmac-sha256:${'8'.repeat(64)}`,
                nonce: 'MDE5OGYwMGQtc2Vjb25kLXR1cm4tbm9uY2U',
              },
              keyPair.privateKey,
            )
          : capability;
        const decision = decideExecutionCapabilityUse(candidate, record);
        if (decision.action === 'DISPATCH_ONCE') {
          dispatchDecisions += 1;
          record = decision.nextRecord;
        }
        expect(record.providerUpstreamRequestCount).toBeLessThanOrEqual(1);
        if (secondTurn) expect(decision.action).toBe('SECURITY_BLOCK');
      }

      expect(dispatchDecisions).toBe(1);
    }
  });
});
