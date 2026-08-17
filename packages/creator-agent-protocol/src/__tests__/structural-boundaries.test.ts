import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import { ConsumerEventStreamSchema, decideConsumerEventReplay } from '../consumer-events.js';
import {
  DeploymentGenerationEtagSchema,
  LastEventIdSchema,
  PublicAgentSlugSchema,
} from '../http.js';
import { VnextErrorResponseSchema, errorResponseFor } from '../invocation.js';
import { UnicodeCodePointStringSchema } from '../primitives.js';
import { InvariantRegistrySchema, parseVnextRegistryYaml } from '../registry.js';
import { ProtocolStructuralBoundaryCorpusSchema } from '../structural-boundaries.js';

type CheckedArtifactName = 'contractSchemas' | 'brokerContract' | 'openApi';

const fixtureUrl = new URL(
  '../../fixtures/protocol-structural-boundaries.v1.json',
  import.meta.url,
);
const artifactUrls = {
  contractSchemas: new URL('../../schemas/contract-schemas.v1.json', import.meta.url),
  brokerContract: new URL('../../schemas/broker-contract.v1.json', import.meta.url),
  openApi: new URL('../../openapi/creator-agent-v1.openapi.json', import.meta.url),
} as const satisfies Record<CheckedArtifactName, URL>;
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function collectUnicodePointers(
  artifact: CheckedArtifactName,
  value: unknown,
  path: readonly string[] = [],
  output: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectUnicodePointers(artifact, item, [...path, String(index)], output),
    );
    return output;
  }
  if (value === null || typeof value !== 'object') return output;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'x-combo-unicodeCodePoints')) {
    output.push(`${artifact}:/${path.map(escapePointerSegment).join('/')}`);
  }
  for (const [key, item] of Object.entries(record)) {
    collectUnicodePointers(artifact, item, [...path, key], output);
  }
  return output;
}

function lookupPointer(document: unknown, pointer: string): Record<string, unknown> {
  let current = document;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`STRUCTURAL_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`STRUCTURAL_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
}

describe('digest-bound public structural boundaries', () => {
  it('pins every advertised Unicode code-point node in all checked artifacts', async () => {
    const corpus = ProtocolStructuralBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    expect(corpus.scope).toBe('unicode-code-point-and-http-path-header-limits-only');
    const documents = Object.fromEntries(
      await Promise.all(
        Object.entries(artifactUrls).map(async ([name, url]) => [
          name,
          JSON.parse(await readFile(url, 'utf8')),
        ]),
      ),
    ) as Record<CheckedArtifactName, unknown>;
    expect(corpus.checkedArtifactDigests).toEqual({
      contractSchemas: sha256(await readFile(artifactUrls.contractSchemas)),
      brokerContract: sha256(await readFile(artifactUrls.brokerContract)),
      openApi: sha256(await readFile(artifactUrls.openApi)),
    });

    const expectedPointers = corpus.unicodeBoundaries
      .flatMap(({ artifactPointers }) =>
        artifactPointers.map(({ artifact, pointer }) => `${artifact}:${pointer}`),
      )
      .sort();
    const actualPointers = (Object.entries(documents) as [CheckedArtifactName, unknown][])
      .flatMap(([artifact, document]) => collectUnicodePointers(artifact, document))
      .sort();
    expect(actualPointers).toEqual(expectedPointers);

    for (const boundary of corpus.unicodeBoundaries) {
      for (const { artifact, pointer } of boundary.artifactPointers) {
        const node = lookupPointer(documents[artifact], pointer);
        expect(node.minLength, `${artifact}:${pointer}`).toBe(boundary.minimumCodePoints);
        expect(node.maxLength, `${artifact}:${pointer}`).toBe(boundary.maximumCodePoints);
        expect(node['x-combo-unicodeCodePoints'], `${artifact}:${pointer}`).toEqual({
          minimum: boundary.minimumCodePoints,
          maximum: boundary.maximumCodePoints,
        });
      }
    }
  });

  it('uses identical astral-character limits in runtime and standard Ajv validators', async () => {
    const corpus = ProtocolStructuralBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const contractSchemas = JSON.parse(
      await readFile(artifactUrls.contractSchemas, 'utf8'),
    ) as unknown;
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

    for (const boundary of corpus.unicodeBoundaries) {
      const pointer = boundary.artifactPointers.find(
        ({ artifact }) => artifact === 'contractSchemas',
      );
      if (pointer === undefined) throw new Error('STRUCTURAL_CONTRACT_POINTER_MISSING');
      const validateAdvertised = ajv.compile(
        lookupPointer(contractSchemas, pointer.pointer) as AnySchema,
      );
      const runtime = UnicodeCodePointStringSchema(
        boundary.minimumCodePoints,
        boundary.maximumCodePoints,
      );
      for (const length of [
        Math.max(0, boundary.minimumCodePoints - 1),
        boundary.minimumCodePoints,
        boundary.maximumCodePoints,
        boundary.maximumCodePoints + 1,
      ]) {
        const value = '😀'.repeat(length);
        const expected =
          length >= boundary.minimumCodePoints && length <= boundary.maximumCodePoints;
        expect(runtime.safeParse(value).success, `runtime:${length}`).toBe(expected);
        expect(validateAdvertised(value), `advertised:${length}`).toBe(expected);
      }
    }
    expect(UnicodeCodePointStringSchema(0, 64).safeParse('😀'.repeat(1_000_000)).success).toBe(
      false,
    );
  });

  it('drives actual error, registry and HTTP owner parsers with the bounded corpus', async () => {
    const corpus = ProtocolStructuralBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    expect(corpus.ownerCases).toEqual([
      'vnext-error-response',
      'invariant-registry',
      'public-agent-slug',
      'deployment-generation-etag',
      'last-event-id',
    ]);

    const error = errorResponseFor('INVALID_INPUT', 'request-1234');
    expect(
      VnextErrorResponseSchema.safeParse({ ...error, message: '😀'.repeat(512) }).success,
    ).toBe(true);
    expect(
      VnextErrorResponseSchema.safeParse({ ...error, message: '😀'.repeat(513) }).success,
    ).toBe(false);
    expect(
      VnextErrorResponseSchema.safeParse({ ...error, requestId: '😀'.repeat(8) }).success,
    ).toBe(true);
    expect(
      VnextErrorResponseSchema.safeParse({ ...error, requestId: '😀'.repeat(7) }).success,
    ).toBe(false);

    const invariantPath = join(repositoryRoot, 'tests', 'vnext', 'invariants.yaml');
    const invariantInput = parseVnextRegistryYaml(await readFile(invariantPath, 'utf8')) as {
      invariants: Array<{ statement: string }>;
    };
    const exactInvariant = structuredClone(invariantInput);
    exactInvariant.invariants[0]!.statement = '😀'.repeat(1_024);
    expect(InvariantRegistrySchema.safeParse(exactInvariant).success).toBe(true);
    const oversizedInvariant = structuredClone(invariantInput);
    oversizedInvariant.invariants[0]!.statement = '😀'.repeat(1_025);
    expect(InvariantRegistrySchema.safeParse(oversizedInvariant).success).toBe(false);

    expect(PublicAgentSlugSchema.safeParse(`a${'b'.repeat(62)}c`).success).toBe(true);
    expect(PublicAgentSlugSchema.safeParse(`a${'b'.repeat(64)}`).success).toBe(false);
    expect(
      DeploymentGenerationEtagSchema.safeParse('"generation-9223372036854775807"').success,
    ).toBe(true);
    expect(
      DeploymentGenerationEtagSchema.safeParse('"generation-9223372036854775808"').success,
    ).toBe(false);
    expect(LastEventIdSchema.safeParse('9223372036854775807').success).toBe(true);
    expect(LastEventIdSchema.safeParse('9223372036854775808').success).toBe(false);
    const stream = ConsumerEventStreamSchema.parse({
      ownerId: '0198f00d-6000-7000-8000-000000000004',
      conversationId: '0198f00d-6000-7000-8000-000000000001',
      latestCursor: '9223372036854775807',
      expiredThroughCursor: '0',
      updatedAt: '2026-08-20T08:00:10.000Z',
    });
    expect(decideConsumerEventReplay('9223372036854775807', stream)).toEqual({
      decision: 'REPLAY',
      afterCursor: '9223372036854775807',
    });
    expect(() => decideConsumerEventReplay('9223372036854775808', stream)).toThrow();
  });
});
