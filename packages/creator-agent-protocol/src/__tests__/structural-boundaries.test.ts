import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import { ConsumerEventStreamSchema, decideConsumerEventReplay } from '../consumer-events.js';
import { EvidenceReviewerSignoffSchema } from '../evidence.js';
import {
  DeploymentGenerationEtagSchema,
  LastEventIdSchema,
  PublicAgentSlugSchema,
} from '../http.js';
import { VnextErrorResponseSchema, errorResponseFor } from '../invocation.js';
import { ServerIdSchema, UnicodeCodePointStringSchema } from '../primitives.js';
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

function lookupValue(document: unknown, pointer: string): unknown {
  let current = document;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`STRUCTURAL_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function replacePointer(document: unknown, pointer: string, replacement: unknown): unknown {
  const clone = structuredClone(document);
  const segments = pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  let current = clone;
  for (const segment of segments.slice(0, -1)) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`STRUCTURAL_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`STRUCTURAL_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  (current as Record<string, unknown>)[segments.at(-1)!] = replacement;
  return clone;
}

async function readOwnerFixture(ownerFixture: {
  path: string;
  format: 'json' | 'yaml';
}): Promise<unknown> {
  const source = await readFile(join(repositoryRoot, ownerFixture.path), 'utf8');
  return ownerFixture.format === 'json' ? JSON.parse(source) : parseVnextRegistryYaml(source);
}

describe('digest-bound public structural boundaries', () => {
  it('pins every advertised Unicode code-point node in all checked artifacts', async () => {
    const corpus = ProtocolStructuralBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    expect(corpus.scope).toBe('unicode-http-and-frozen-resource-boundaries-only');
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

  it('uses one owner UUID fixture across runtime, contract and OpenAPI Ajv boundaries', async () => {
    const corpus = ProtocolStructuralBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const boundary = corpus.serverIdBoundary;
    const owner = await readOwnerFixture(boundary.ownerFixture);
    const exact = lookupValue(owner, boundary.ownerFixture.valuePointer);
    if (typeof exact !== 'string') throw new Error('SERVER_ID_OWNER_VALUE_NOT_STRING');
    const values = {
      nMinusOne: exact.slice(0, -1),
      n: exact,
      nPlusOne: `${exact}0`,
      uuidV4: '550e8400-e29b-41d4-a716-446655440000',
      uuidV8: `${exact.slice(0, 14)}8${exact.slice(15)}`,
      uppercase: exact.toUpperCase(),
    } as const;
    expect(values.n).toHaveLength(boundary.maximumLength);
    expect(values.nMinusOne).toHaveLength(boundary.maximumLength - 1);
    expect(values.nPlusOne).toHaveLength(boundary.maximumLength + 1);

    const contractSchemas = JSON.parse(await readFile(artifactUrls.contractSchemas, 'utf8')) as {
      schemas: Record<string, AnySchema>;
    };
    const openApi = JSON.parse(await readFile(artifactUrls.openApi, 'utf8')) as {
      components: { schemas: Record<string, AnySchema> };
    };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validateContract = ajv.compile(contractSchemas.schemas[boundary.contractSchema]!);
    const validateOpenApi = ajv.compile(openApi.components.schemas[boundary.openApiComponent]!);
    for (const [name, value] of Object.entries(values)) {
      const expected = name === 'n';
      expect(ServerIdSchema.safeParse(value).success, `runtime:${name}`).toBe(expected);
      expect(validateContract(value), `contract:${name}`).toBe(expected);
      expect(validateOpenApi(value), `openapi:${name}`).toBe(expected);
    }

    const openApiDocument = openApi as unknown;
    for (const { artifact, pointer } of boundary.pathParameterPointers) {
      expect(artifact).toBe('openApi');
      expect(lookupPointer(openApiDocument, pointer)).toEqual({
        $ref: '#/components/schemas/ServerId',
      });
    }
  });

  it('uses each gate owner fixture for the frozen N-1/N/N+1 and uniqueness matrix', async () => {
    const corpus = ProtocolStructuralBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const contractSchemas = JSON.parse(await readFile(artifactUrls.contractSchemas, 'utf8')) as {
      schemas: Record<string, AnySchema>;
    };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const gates = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'] as const;

    for (const boundary of corpus.gateSetBoundaries) {
      const owner = await readOwnerFixture(boundary.ownerFixture);
      const validateRuntime = (candidate: unknown) =>
        boundary.runtimeParser === 'EvidenceReviewerSignoffSchema'
          ? EvidenceReviewerSignoffSchema.safeParse(candidate).success
          : InvariantRegistrySchema.safeParse(candidate).success;
      const validateAdvertised = ajv.compile(contractSchemas.schemas[boundary.contractSchema]!);
      const candidates = {
        nMinusOne: replacePointer(
          owner,
          boundary.ownerFixture.valuePointer,
          gates.slice(0, boundary.maximumItems - 1),
        ),
        n: replacePointer(owner, boundary.ownerFixture.valuePointer, [...gates]),
        nPlusOne: replacePointer(owner, boundary.ownerFixture.valuePointer, [...gates, 'G8']),
        duplicate: replacePointer(owner, boundary.ownerFixture.valuePointer, ['G0', 'G0']),
        reverse: replacePointer(owner, boundary.ownerFixture.valuePointer, ['G1', 'G0']),
      };

      for (const accepted of ['nMinusOne', 'n'] as const) {
        expect(validateRuntime(candidates[accepted]), `runtime:${boundary.id}:${accepted}`).toBe(
          true,
        );
        expect(
          validateAdvertised(candidates[accepted]),
          `contract:${boundary.id}:${accepted}`,
        ).toBe(true);
      }
      for (const rejected of ['nPlusOne', 'duplicate'] as const) {
        expect(validateRuntime(candidates[rejected]), `runtime:${boundary.id}:${rejected}`).toBe(
          false,
        );
        expect(
          validateAdvertised(candidates[rejected]),
          `contract:${boundary.id}:${rejected}`,
        ).toBe(false);
      }

      const expectedRuntimeReverse = boundary.reverseSemantics === 'runtime-accepts';
      expect(validateRuntime(candidates.reverse), `runtime:${boundary.id}:reverse`).toBe(
        expectedRuntimeReverse,
      );
      expect(validateAdvertised(candidates.reverse), `contract:${boundary.id}:reverse`).toBe(true);
      expect(lookupPointer(contractSchemas, boundary.contractPointer)).toMatchObject({
        minItems: boundary.minimumItems,
        maxItems: boundary.maximumItems,
        uniqueItems: boundary.uniqueItems,
      });
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
      'evidence-reviewer-signoff',
      'public-agent-slug',
      'deployment-generation-etag',
      'last-event-id',
      'server-id-path-uuidv7',
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
