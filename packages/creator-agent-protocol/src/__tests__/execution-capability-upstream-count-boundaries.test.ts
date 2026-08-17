import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import {
  BrokerEnvelopeSchema,
  ExecutionCapabilityUseRecordSchema,
  decideExecutionCapabilityUse,
  executionCapabilityDigest,
  type ExecutionCapability,
} from '../broker.js';
import { canonicalSha256 } from '../canonical.js';
import { ExecutionCapabilityUpstreamCountBoundaryCorpusSchema } from '../execution-capability-upstream-count-boundaries.js';

const corpusUrl = new URL(
  '../../fixtures/execution-capability-upstream-count-boundaries.v1.json',
  import.meta.url,
);
const corpusFixturePath = 'execution-capability-upstream-count-boundaries.v1.json';
const fixtureDirectoryUrl = new URL('../../fixtures/', import.meta.url);
const fixtureIndexUrl = new URL('../../fixtures/index.json', import.meta.url);
const contractSchemasUrl = new URL('../../schemas/contract-schemas.v1.json', import.meta.url);

function sha256(bytes: Uint8Array): `sha256:${string}` {
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
      throw new Error(`UPSTREAM_COUNT_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`UPSTREAM_COUNT_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
}

async function baseCapability(): Promise<ExecutionCapability> {
  const envelope = BrokerEnvelopeSchema.parse(
    JSON.parse(
      await readFile(new URL('broker-invocation-prepare.v1.json', fixtureDirectoryUrl), 'utf8'),
    ),
  );
  if (envelope.type !== 'invocation.prepare') {
    throw new Error('UPSTREAM_COUNT_BOUNDARY_EXPECTED_PREPARE');
  }
  return envelope.body.executionCapability;
}

function recordFor(
  capability: ExecutionCapability,
  probe: { state: 'UNUSED' | 'DISPATCHED'; providerUpstreamRequestCount: 0 | 1 | 2 },
) {
  return {
    capabilityId: capability.capabilityId,
    capabilityDigest: executionCapabilityDigest(capability),
    providerRequestId: capability.providerRequestId,
    requestDigest: capability.requestDigest,
    state: probe.state,
    providerUpstreamRequestCount: probe.providerUpstreamRequestCount,
    resultDigest: null,
  };
}

describe('digest-bound Execution Capability upstream-count boundary', () => {
  it('pins P0 authority, explicit exclusions, the base fixture and one advertised maximum', async () => {
    const corpusBytes = await readFile(corpusUrl);
    const corpus = ExecutionCapabilityUpstreamCountBoundaryCorpusSchema.parse(
      JSON.parse(corpusBytes.toString('utf8')),
    );
    expect(corpus.scope).toBe('provider-upstream-count-only');
    expect(corpus.evidenceClass).toBe('schema-decision-contract-and-real-file-sqlite-only');
    expect(corpus.authority).toMatchObject({
      invariantId: 'INV-010',
      severity: 'P0',
      gates: ['G0', 'G4'],
      decisionRegistryId: 'ADR-VNEXT-010',
      additiveRegistryCaseId: 'SCH-004',
    });
    expect(corpus.exclusions).toEqual([
      'real-provider-upstream-sink',
      'multi-process-concurrency',
      'crash-and-network-fault-matrix',
      'ten-thousand-random-sequences',
      'real-linux-codex-e4',
      'chaos-recovery-e6',
      'does-not-complete-inv-010',
      'does-not-complete-sch-004',
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
    expect(corpus.checkedArtifactDigests.contractSchemas).toBe(
      sha256(await readFile(contractSchemasUrl)),
    );

    const contractSchemas = JSON.parse(await readFile(contractSchemasUrl, 'utf8')) as unknown;
    expect(
      lookupPointer(contractSchemas, corpus.advertisedConstraint.artifactPointer),
    ).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: corpus.advertisedConstraint.maximum,
    });
    expect(corpus.outcomeCounts.total).toBe(
      corpus.outcomeCounts.runtimeSchema +
        corpus.outcomeCounts.runtimeDecision +
        corpus.outcomeCounts.advertisedContract +
        corpus.outcomeCounts.realFileSqlite,
    );
  });

  it('runs the same digest-bound 0/1/2 records through schema, decision and contract owners', async () => {
    const corpus = ExecutionCapabilityUpstreamCountBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const capability = await baseCapability();
    const contractSchemas = JSON.parse(await readFile(contractSchemasUrl, 'utf8')) as {
      schemas: Record<string, AnySchema>;
    };
    const validateContract = new Ajv({
      allErrors: true,
      strict: false,
      validateFormats: false,
    }).compile(contractSchemas.schemas.ExecutionCapabilityUseRecord!);
    let schemaOutcomes = 0;
    let decisionOutcomes = 0;
    let advertisedOutcomes = 0;

    for (const probe of corpus.probes) {
      const record = recordFor(capability, probe);
      expect(`sha256:${canonicalSha256(record)}`, probe.id).toBe(probe.canonicalRecordDigest);
      const expected = probe.schemaExpected === 'accepted';
      const schemaResult = ExecutionCapabilityUseRecordSchema.safeParse(record);
      expect(schemaResult.success, `schema:${probe.id}`).toBe(expected);
      schemaOutcomes += 1;

      const decision = decideExecutionCapabilityUse(
        capability,
        record as Parameters<typeof decideExecutionCapabilityUse>[1],
      );
      expect(decision.action, `decision:${probe.id}`).toBe(probe.decisionExpected.action);
      if (probe.id === 'unused-zero') {
        expect(decision).toMatchObject({
          action: 'DISPATCH_ONCE',
          nextRecord: { providerUpstreamRequestCount: 1 },
        });
      } else if (probe.id === 'dispatched-one') {
        expect(decision).toMatchObject({
          action: 'RETURN_IN_PROGRESS',
          record: { providerUpstreamRequestCount: 1 },
        });
      } else {
        expect(decision).toEqual({
          action: 'SECURITY_BLOCK',
          code: 'CAPABILITY_LEDGER_INVALID',
        });
      }
      decisionOutcomes += 1;

      expect(validateContract(record), `contract:${probe.id}`).toBe(expected);
      if (!expected) {
        expect(validateContract.errors).toContainEqual(
          expect.objectContaining({
            instancePath: '/providerUpstreamRequestCount',
            keyword: 'maximum',
            params: { comparison: '<=', limit: 1 },
          }),
        );
      }
      advertisedOutcomes += 1;
    }

    expect(schemaOutcomes).toBe(corpus.outcomeCounts.runtimeSchema);
    expect(decisionOutcomes).toBe(corpus.outcomeCounts.runtimeDecision);
    expect(advertisedOutcomes).toBe(corpus.outcomeCounts.advertisedContract);
  });
});
