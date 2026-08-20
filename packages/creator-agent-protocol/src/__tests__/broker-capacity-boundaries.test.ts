import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import {
  BrokerCapacitySchema,
  BrokerHandshakeSchema,
  BrokerHandshakeUnsignedSchema,
  parseBrokerHandshake,
  type BrokerHandshake,
} from '../broker.js';
import { currentBrokerContractDigest } from '../artifacts.js';
import { canonicalizeJson } from '../canonical.js';
import { BrokerCapacityBoundaryCorpusSchema } from '../broker-capacity-boundaries.js';

const corpusUrl = new URL('../../fixtures/broker-capacity-boundaries.v1.json', import.meta.url);
const corpusFixturePath = 'broker-capacity-boundaries.v1.json';
const fixtureDirectoryUrl = new URL('../../fixtures/', import.meta.url);
const fixtureIndexUrl = new URL('../../fixtures/index.json', import.meta.url);
const artifactUrls = {
  contractSchemas: new URL('../../schemas/contract-schemas.v1.json', import.meta.url),
  brokerContract: new URL('../../schemas/broker-contract.v1.json', import.meta.url),
} as const;

function sha256(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function lookupPointer(document: unknown, pointer: string): Record<string, unknown> {
  let current = document;
  for (const segment of pointerSegments(pointer)) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`BROKER_CAPACITY_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`BROKER_CAPACITY_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
}

function mutateCapacity(
  handshake: BrokerHandshake,
  field: 'maxActiveConversations' | 'maxActiveTurns',
  value: number,
): unknown {
  return {
    ...handshake,
    capacity: { ...handshake.capacity, [field]: value },
  };
}

function unsignedHandshake(handshake: BrokerHandshake): unknown {
  const { challengeSignature: _challengeSignature, ...unsigned } = handshake;
  return unsigned;
}

describe('digest-bound Broker capacity singleton boundaries', () => {
  it('pins frozen authority, explicit exclusions, base fixture and four advertised const paths', async () => {
    const corpusBytes = await readFile(corpusUrl);
    const corpus = BrokerCapacityBoundaryCorpusSchema.parse(
      JSON.parse(corpusBytes.toString('utf8')),
    );
    expect(corpus.scope).toBe('broker-handshake-capacity-singleton-only');
    expect(corpus.evidenceClass).toBe('contract-and-real-transport-handshake-only');
    expect(corpus.authority).toEqual({
      technicalPlanSections: ['技术方案 §11.1 Worker 握手', '技术方案 §7.3、§12.8、§17.3 WIP=1'],
      testPlanSections: [
        '测试方案 §6.1 SCH-004',
        '测试方案 §3.2 E3 Contract/Fake System',
        '测试方案 §21.2 Alpha 容量场景',
      ],
      testCaseId: 'SCH-004',
    });
    expect(corpus.exclusions).toEqual([
      'agent-version-runtime-policy-max-active-turns',
      'creator-and-conversation-wip-enforcement',
      'queue-postgresql-advisory-and-sqlite-capacity',
      'creator-http-openapi',
      'tls-wss-termination-and-public-ingress',
      'real-inference-cloud-capacity-and-soak',
    ]);

    const fixtureIndex = JSON.parse(await readFile(fixtureIndexUrl, 'utf8')) as {
      fixtures: Array<{ path: string; bytes: number; digest: string }>;
    };
    expect(fixtureIndex.fixtures.find(({ path }) => path === corpusFixturePath)).toEqual({
      path: corpusFixturePath,
      bytes: corpusBytes.byteLength,
      digest: sha256(corpusBytes),
    });
    const baseBytes = await readFile(new URL(corpus.baseFixture.path, fixtureDirectoryUrl));
    expect(sha256(baseBytes)).toBe(corpus.baseFixture.digest);
    expect(fixtureIndex.fixtures.find(({ path }) => path === corpus.baseFixture.path)).toEqual({
      path: corpus.baseFixture.path,
      bytes: baseBytes.byteLength,
      digest: corpus.baseFixture.digest,
    });
    expect(BrokerHandshakeSchema.safeParse(JSON.parse(baseBytes.toString('utf8'))).success).toBe(
      true,
    );

    const documents = {
      contractSchemas: JSON.parse(await readFile(artifactUrls.contractSchemas, 'utf8')) as unknown,
      brokerContract: JSON.parse(await readFile(artifactUrls.brokerContract, 'utf8')) as unknown,
    };
    expect(corpus.checkedArtifactDigests).toEqual({
      contractSchemas: sha256(await readFile(artifactUrls.contractSchemas)),
      brokerContract: sha256(await readFile(artifactUrls.brokerContract)),
      advertisedBrokerContract: currentBrokerContractDigest(),
    });
    expect(corpus.advertisedConstraints).toHaveLength(4);
    expect(corpus.outcomeCounts.total).toBe(
      corpus.outcomeCounts.protocolRuntime +
        corpus.outcomeCounts.advertisedArtifacts +
        corpus.outcomeCounts.gatewayTransport +
        corpus.outcomeCounts.workerTransport,
    );
    for (const constraint of corpus.advertisedConstraints) {
      expect(
        lookupPointer(documents[constraint.artifact], constraint.artifactPointer),
        `${constraint.artifact}:${constraint.field}`,
      ).toEqual({ type: 'number', const: 1 });
    }
  });

  it('runs identical 0/1/2 variants through four runtime and two advertised owners', async () => {
    const corpus = BrokerCapacityBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const handshake = BrokerHandshakeSchema.parse(
      JSON.parse(await readFile(new URL(corpus.baseFixture.path, fixtureDirectoryUrl), 'utf8')),
    );
    const contractSchemas = JSON.parse(await readFile(artifactUrls.contractSchemas, 'utf8')) as {
      schemas: Record<string, AnySchema>;
    };
    const brokerContract = JSON.parse(await readFile(artifactUrls.brokerContract, 'utf8')) as {
      schemas: Record<string, AnySchema>;
    };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const advertised = [
      ['contractSchemas', ajv.compile(contractSchemas.schemas.BrokerHandshake!)],
      ['brokerContract', ajv.compile(brokerContract.schemas.BrokerHandshake!)],
    ] as const;
    let runtimeOutcomes = 0;
    let advertisedOutcomes = 0;

    for (const boundary of corpus.boundaries) {
      for (const probe of boundary.probes) {
        expect(probe.value, `${boundary.field}:${probe.delta}`).toBe(
          boundary.maximum + probe.delta,
        );
        const candidate = mutateCapacity(handshake, boundary.field, probe.value);
        const candidateRecord = candidate as { capacity: unknown };
        const signedResult = BrokerHandshakeSchema.safeParse(candidate);
        const expected = probe.expected === 'accepted';
        const runtimeResults = [
          [
            'BrokerCapacitySchema',
            BrokerCapacitySchema.safeParse(candidateRecord.capacity).success,
          ],
          [
            'BrokerHandshakeUnsignedSchema',
            BrokerHandshakeUnsignedSchema.safeParse(unsignedHandshake(candidate as BrokerHandshake))
              .success,
          ],
          ['BrokerHandshakeSchema', signedResult.success],
          [
            'parseBrokerHandshake',
            (() => {
              try {
                parseBrokerHandshake(canonicalizeJson(candidate));
                return true;
              } catch {
                return false;
              }
            })(),
          ],
        ] as const;
        for (const [owner, accepted] of runtimeResults) {
          expect(accepted, `${owner}:${boundary.field}:${probe.delta}`).toBe(expected);
          runtimeOutcomes += 1;
        }
        for (const [owner, validate] of advertised) {
          expect(validate(candidate), `${owner}:${boundary.field}:${probe.delta}`).toBe(expected);
          if (!expected) {
            expect(validate.errors).toContainEqual(
              expect.objectContaining({
                instancePath: `/capacity/${boundary.field}`,
                keyword: 'const',
                params: { allowedValue: 1 },
              }),
            );
          }
          advertisedOutcomes += 1;
        }
      }
    }
    expect(runtimeOutcomes).toBe(corpus.outcomeCounts.protocolRuntime);
    expect(advertisedOutcomes).toBe(corpus.outcomeCounts.advertisedArtifacts);
  });
});
