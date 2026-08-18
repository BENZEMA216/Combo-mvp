import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';
import type { ZodIssue } from 'zod';

// VNext registry case: SCH-005 (all structural string owners fail closed without echo).

import { ConsumerEventStreamSchema, decideConsumerEventReplay } from '../consumer-events.js';
import { EvidenceReviewerSignoffSchema } from '../evidence.js';
import {
  DeploymentViewSchema,
  DeploymentGenerationEtagSchema,
  LastEventIdSchema,
  PublicAgentSlugSchema,
  SnapshotPublicationCommitMarkerSchema,
  SnapshotUploadViewSchema,
} from '../http.js';
import { VnextErrorResponseSchema, errorResponseFor } from '../invocation.js';
import {
  ServerIdSchema,
  UNICODE_SCALAR_NO_CONTROL_OPTIONAL_PATTERN_SOURCE,
  UNICODE_SCALAR_NO_CONTROL_PATTERN_SOURCE,
  UTF8_TEXT_OPTIONAL_PORTABLE_PATTERN_SOURCE,
  UTF8_TEXT_PORTABLE_PATTERN_SOURCE,
  UnicodeCodePointStringSchema,
} from '../primitives.js';
import {
  ArchitectureDecisionSchema,
  DataFlowAllowlistSchema,
  DecisionRegistrySchema,
  InvariantRegistrySchema,
  TestCaseRegistrySchema,
  parseVnextRegistryYaml,
} from '../registry.js';
import {
  SnapshotArchiveEnvelopeAadSchema,
  SnapshotManifestEnvelopeAadSchema,
  snapshotPublicationPreparationObjectKey,
} from '../snapshot.js';
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
const UNICODE_CODE_POINT_BOUNDARY_CANARY = 'UNICODE_CODE_POINT_BOUNDARY_CANARY_';

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

function collectPatternSources(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectPatternSources(item, output));
    return output;
  }
  if (value === null || typeof value !== 'object') return output;
  const record = value as Record<string, unknown>;
  if (typeof record.pattern === 'string') output.push(record.pattern);
  Object.values(record).forEach((item) => collectPatternSources(item, output));
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

function pointerIssuePath(pointer: string): string {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .join('/');
}

function flattenZodIssues(issues: readonly ZodIssue[]): ZodIssue[] {
  return issues.flatMap((issue) =>
    issue.code === 'invalid_union'
      ? [issue, ...issue.unionErrors.flatMap((error) => flattenZodIssues(error.issues))]
      : [issue],
  );
}

function exactUnicodeCodePointsWithCanary(targetCodePoints: number): string {
  const canaryCodePoints = [...UNICODE_CODE_POINT_BOUNDARY_CANARY].length;
  if (targetCodePoints < canaryCodePoints) {
    throw new Error(`UNICODE_CODE_POINT_BOUNDARY_TARGET_TOO_SMALL:${targetCodePoints}`);
  }
  return UNICODE_CODE_POINT_BOUNDARY_CANARY + '😀'.repeat(targetCodePoints - canaryCodePoints);
}

function hasRuntimeCodePointBoundaryIssue(
  issues: readonly ZodIssue[],
  pointer: string,
  minimumCodePoints: number,
  maximumCodePoints: number,
): boolean {
  return flattenZodIssues(issues).some(
    (issue) =>
      issue.code === 'custom' &&
      issue.message ===
        `Unicode code points 必须在 ${minimumCodePoints}..${maximumCodePoints} 范围内` &&
      issue.path.map(String).join('/') === pointerIssuePath(pointer),
  );
}

function exactDerivedIssueMessage(ownerId: string): string {
  switch (ownerId) {
    case 'snapshot-publication-preparation-key':
      return 'commit preparationKey 必须由 creatorId 和 snapshotDigest 精确派生';
    case 'snapshot-archive-object-key':
      return 'objectKey 必须由 creatorId 和 snapshotDigest 精确派生';
    case 'snapshot-manifest-object-key':
      return 'manifest objectKey 必须由 creatorId 和 snapshotDigest 精确派生';
    default:
      throw new Error(`STRUCTURAL_EXACT_DERIVED_OWNER_UNKNOWN:${ownerId}`);
  }
}

function hasRuntimeCustomIssue(
  issues: readonly ZodIssue[],
  pointer: string,
  message: string,
): boolean {
  return flattenZodIssues(issues).some(
    (issue) =>
      issue.code === 'custom' &&
      issue.message === message &&
      issue.path.map(String).join('/') === pointerIssuePath(pointer),
  );
}

async function readOwnerFixture(ownerFixture: {
  path: string;
  format: 'json' | 'yaml';
}): Promise<unknown> {
  const source = await readFile(join(repositoryRoot, ownerFixture.path), 'utf8');
  return ownerFixture.format === 'json' ? JSON.parse(source) : parseVnextRegistryYaml(source);
}

function inlineUnicodeOwnerFixture(source: string): unknown {
  const creatorId = '0198f00d-8000-7000-8000-000000000001';
  const snapshotDigest = '05b3abf2579a5eb66403cd78be557fd860633a1fe2103c7642030defe32c657f';
  switch (source) {
    case 'inline:vnext-error-response':
      return errorResponseFor('INVALID_INPUT', 'request-1234');
    case 'inline:snapshot-publication-commit-marker':
      return {
        protocol: 'combo.snapshot-publication-commit/1',
        schemaVersion: 1,
        creatorId,
        snapshotDigest,
        preparationKey: snapshotPublicationPreparationObjectKey(creatorId, snapshotDigest),
        preparationDigest: '0'.repeat(64),
      };
    case 'inline:snapshot-upload-view':
      return {
        protocol: 'combo.creator-agent-http/1',
        uploadId: '0198f00d-8000-7000-8000-000000000002',
        state: 'REJECTED',
        snapshotId: null,
        snapshotDigest,
        errorCode: 'SNAPSHOT_REJECTED',
        updatedAt: '2026-08-20T08:00:10.000Z',
      };
    case 'inline:deployment-view':
      return {
        protocol: 'combo.creator-agent-http/1',
        agentId: '0198f00d-8000-7000-8000-000000000003',
        desiredState: 'OFFLINE',
        desiredVersionId: null,
        servingVersionId: null,
        observedState: 'BLOCKED',
        generation: '1',
        lastErrorCode: 'MODEL_QUOTA_EXHAUSTED',
        updatedAt: '2026-08-20T08:00:10.000Z',
      };
    default:
      throw new Error(`STRUCTURAL_INLINE_FIXTURE_UNKNOWN:${source}`);
  }
}

function parseUnicodeRuntimeOwner(parser: string, input: unknown) {
  switch (parser) {
    case 'InvariantRegistrySchema':
      return InvariantRegistrySchema.safeParse(input);
    case 'TestCaseRegistrySchema':
      return TestCaseRegistrySchema.safeParse(input);
    case 'DecisionRegistrySchema':
      return DecisionRegistrySchema.safeParse(input);
    case 'ArchitectureDecisionSchema':
      return ArchitectureDecisionSchema.safeParse(input);
    case 'DataFlowAllowlistSchema':
      return DataFlowAllowlistSchema.safeParse(input);
    case 'VnextErrorResponseSchema':
      return VnextErrorResponseSchema.safeParse(input);
    case 'SnapshotPublicationCommitMarkerSchema':
      return SnapshotPublicationCommitMarkerSchema.safeParse(input);
    case 'SnapshotUploadViewSchema':
      return SnapshotUploadViewSchema.safeParse(input);
    case 'DeploymentViewSchema':
      return DeploymentViewSchema.safeParse(input);
    case 'SnapshotArchiveEnvelopeAadSchema':
      return SnapshotArchiveEnvelopeAadSchema.safeParse(input);
    case 'SnapshotManifestEnvelopeAadSchema':
      return SnapshotManifestEnvelopeAadSchema.safeParse(input);
    default:
      throw new Error(`STRUCTURAL_RUNTIME_PARSER_UNKNOWN:${parser}`);
  }
}

function unicodeScalarProbes(parity: {
  canaryPrefix: string;
  probeRecipe: {
    accepted: readonly { id: string; codeUnits: readonly number[] }[];
    forbiddenControlRanges: readonly { id: string; start: number; end: number }[];
    allowedControlCodeUnits: readonly number[];
    loneSurrogates: readonly { id: string; codeUnit: number }[];
  };
}) {
  const value = (codeUnits: readonly number[]) =>
    parity.canaryPrefix + String.fromCharCode(...codeUnits);
  const accepted = parity.probeRecipe.accepted.map((probe) => ({
    id: probe.id,
    value: value(probe.codeUnits),
  }));
  const allowed = new Set(parity.probeRecipe.allowedControlCodeUnits);
  const controls = parity.probeRecipe.forbiddenControlRanges.flatMap((range) =>
    Array.from({ length: range.end - range.start + 1 }, (_, offset) => range.start + offset)
      .filter((codeUnit) => !allowed.has(codeUnit))
      .map((codeUnit) => ({
        id: `${range.id}-${codeUnit.toString(16).padStart(2, '0')}`,
        value: value([codeUnit]),
      })),
  );
  const rejected = [
    ...controls,
    ...parity.probeRecipe.loneSurrogates.map((probe) => ({
      id: probe.id,
      value: value([probe.codeUnit]),
    })),
  ];
  return { accepted, rejected, all: [...accepted, ...rejected] };
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

  it('binds every Unicode code-point runtime owner to the compact scalar-control matrix', async () => {
    const corpus = ProtocolStructuralBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const parity = corpus.unicodeScalarParity;
    const probes = unicodeScalarProbes(parity);
    expect(probes.accepted).toHaveLength(parity.probeRecipe.expectedCounts.accepted);
    expect(probes.rejected).toHaveLength(parity.probeRecipe.expectedCounts.rejected);
    expect(probes.all).toHaveLength(parity.probeRecipe.expectedCounts.total);
    expect(parity.strictPatternSource).toBe(UNICODE_SCALAR_NO_CONTROL_PATTERN_SOURCE);
    expect(parity.strictOptionalPatternSource).toBe(
      UNICODE_SCALAR_NO_CONTROL_OPTIONAL_PATTERN_SOURCE,
    );
    const strictRuntimeOwnerIds = new Set<string>(parity.strictRuntimeOwnerIds);
    const strictArtifactPointers = new Set(
      parity.strictArtifactPointers.map(({ artifact, pointer }) => `${artifact}:${pointer}`),
    );

    let outcomes = 0;
    for (const owner of parity.runtimeOwners) {
      const fixture =
        owner.fixtureFormat === 'inline'
          ? inlineUnicodeOwnerFixture(owner.fixtureSource)
          : await readOwnerFixture({
              path: owner.fixtureSource,
              format: owner.fixtureFormat,
            });
      const extractsOwner =
        owner.runtimeParser === 'ArchitectureDecisionSchema' ||
        owner.runtimeParser === 'SnapshotArchiveEnvelopeAadSchema' ||
        owner.runtimeParser === 'SnapshotManifestEnvelopeAadSchema';
      const parserInput = extractsOwner ? lookupValue(fixture, owner.ownerPointer) : fixture;
      const valuePointer = extractsOwner
        ? owner.instancePointer
        : `${owner.ownerPointer}${owner.instancePointer}`;
      expect(
        parseUnicodeRuntimeOwner(owner.runtimeParser, parserInput).success,
        `runtime:${owner.id}:fixture`,
      ).toBe(true);

      for (const probe of probes.all) {
        const scalarForbidden = probes.rejected.some(({ id }) => id === probe.id);
        const strictWhitespaceForbidden =
          strictRuntimeOwnerIds.has(owner.id) &&
          (probe.id === 'tab' || probe.id === 'lf' || probe.id === 'cr');
        const expected =
          owner.kind === 'ordinary' && !scalarForbidden && !strictWhitespaceForbidden;
        const result = parseUnicodeRuntimeOwner(
          owner.runtimeParser,
          replacePointer(parserInput, valuePointer, probe.value),
        );
        expect(result.success, `runtime:${owner.id}:${probe.id}`).toBe(expected);
        if (!expected && !result.success) {
          const shouldHaveRegexIssue = scalarForbidden || strictWhitespaceForbidden;
          expect(
            flattenZodIssues(result.error.issues).some(
              (issue) =>
                issue.code === 'invalid_string' &&
                issue.validation === 'regex' &&
                issue.path.map(String).join('/') === pointerIssuePath(valuePointer),
            ),
            `runtime-regex:${owner.id}:${probe.id}`,
          ).toBe(shouldHaveRegexIssue);
          expect(JSON.stringify(result.error.issues)).not.toContain(parity.canaryPrefix);
        }
        outcomes += 1;
      }
    }

    const documents = Object.fromEntries(
      await Promise.all(
        Object.entries(artifactUrls).map(async ([name, url]) => [
          name,
          JSON.parse(await readFile(url, 'utf8')),
        ]),
      ),
    ) as Record<CheckedArtifactName, unknown>;
    const publicPointers = corpus.unicodeBoundaries.flatMap(
      ({ minimumCodePoints, artifactPointers }) =>
        artifactPointers.map(({ artifact, pointer }) => ({
          artifact,
          pointer,
          minimumCodePoints,
        })),
    );
    expect(publicPointers).toHaveLength(parity.expectedCounts.publicNodes);
    expect(strictArtifactPointers.size).toBe(parity.expectedCounts.strictPublicNodes);
    expect(
      [...strictArtifactPointers].every((key) =>
        publicPointers.some(({ artifact, pointer }) => `${artifact}:${pointer}` === key),
      ),
    ).toBe(true);
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    for (const { artifact, pointer, minimumCodePoints } of publicPointers) {
      const publicNode = lookupPointer(documents[artifact], pointer);
      const strict = strictArtifactPointers.has(`${artifact}:${pointer}`);
      const expectedPattern = strict
        ? minimumCodePoints === 0
          ? parity.strictOptionalPatternSource
          : parity.strictPatternSource
        : minimumCodePoints === 0
          ? UTF8_TEXT_OPTIONAL_PORTABLE_PATTERN_SOURCE
          : UTF8_TEXT_PORTABLE_PATTERN_SOURCE;
      expect(
        [...new Set(collectPatternSources(publicNode))],
        `pattern:${artifact}:${pointer}`,
      ).toEqual([expectedPattern]);
      const validate = ajv.compile(publicNode as AnySchema);
      for (const probe of probes.all) {
        const scalarForbidden = probes.rejected.some(({ id }) => id === probe.id);
        const strictWhitespaceForbidden =
          strict && (probe.id === 'tab' || probe.id === 'lf' || probe.id === 'cr');
        const expected = !scalarForbidden && !strictWhitespaceForbidden;
        expect(validate(probe.value), `public:${artifact}:${pointer}:${probe.id}`).toBe(expected);
        if (!expected) {
          expect(JSON.stringify(validate.errors)).not.toContain(parity.canaryPrefix);
        }
        outcomes += 1;
      }
    }

    expect(corpus.unicodeBoundaries).toHaveLength(parity.expectedCounts.helperBoundaries);
    for (const boundary of corpus.unicodeBoundaries) {
      const helper = UnicodeCodePointStringSchema(
        boundary.minimumCodePoints,
        boundary.maximumCodePoints,
      );
      for (const probe of probes.accepted) {
        expect(helper.safeParse(probe.value).success, `helper:${probe.id}`).toBe(true);
        outcomes += 1;
      }
      for (const probe of probes.rejected) {
        const result = helper.safeParse(probe.value);
        expect(result.success, `helper:${probe.id}`).toBe(false);
        if (!result.success) {
          expect(JSON.stringify(result.error.issues)).not.toContain(parity.canaryPrefix);
        }
        outcomes += 1;
      }
    }

    for (const wrapper of parity.nullableWrappers) {
      const validate = ajv.compile(
        lookupPointer(documents[wrapper.artifact], wrapper.pointer) as AnySchema,
      );
      expect(validate(null), `nullable:${wrapper.id}:null`).toBe(true);
      expect(validate(probes.accepted[3]!.value), `nullable:${wrapper.id}:scalar`).toBe(true);
      expect(validate(probes.accepted[0]!.value), `nullable:${wrapper.id}:tab`).toBe(false);
      expect(validate(probes.rejected.at(-1)!.value), `nullable:${wrapper.id}:surrogate`).toBe(
        false,
      );
    }

    const messageNode = lookupPointer(
      documents.contractSchemas,
      '/schemas/VnextErrorResponse/definitions/VnextErrorResponse/properties/message',
    );
    const validateAllOf = ajv.compile({
      allOf: [{ type: 'string', pattern: parity.syntheticBasePatternSource }, messageNode],
    });
    expect(validateAllOf('base-alpha')).toBe(true);
    expect(validateAllOf('other')).toBe(false);
    expect(validateAllOf(probes.rejected.at(-1)!.value)).toBe(false);

    expect(outcomes).toBe(parity.expectedCounts.outcomes);
  }, 60_000);

  it('drives exact Unicode code-point maxima through all actual runtime owners', async () => {
    const corpus = ProtocolStructuralBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const parity = corpus.unicodeScalarParity;
    const nullableOwnerIds = new Set<string>(parity.nullableWrappers.map(({ id }) => id));
    let baselines = 0;
    let exactDerivedBaselines = 0;
    let outcomes = 0;
    let accepted = 0;
    let rejected = 0;
    let targetIssues = 0;
    let exactDerivedIssues = 0;
    let noCanaryChecks = 0;
    let nullableRuntimeChecks = 0;

    for (const owner of parity.runtimeOwners) {
      const fixture =
        owner.fixtureFormat === 'inline'
          ? inlineUnicodeOwnerFixture(owner.fixtureSource)
          : await readOwnerFixture({
              path: owner.fixtureSource,
              format: owner.fixtureFormat,
            });
      const extractsOwner =
        owner.runtimeParser === 'ArchitectureDecisionSchema' ||
        owner.runtimeParser === 'SnapshotArchiveEnvelopeAadSchema' ||
        owner.runtimeParser === 'SnapshotManifestEnvelopeAadSchema';
      const parserInput = extractsOwner ? lookupValue(fixture, owner.ownerPointer) : fixture;
      const valuePointer = extractsOwner
        ? owner.instancePointer
        : `${owner.ownerPointer}${owner.instancePointer}`;
      expect(
        parseUnicodeRuntimeOwner(owner.runtimeParser, parserInput).success,
        `baseline:${owner.id}`,
      ).toBe(true);
      baselines += 1;
      if (owner.kind === 'exact-derived') exactDerivedBaselines += 1;

      for (const delta of [-1, 0, 1] as const) {
        const targetCodePoints = owner.maximumCodePoints + delta;
        const value = exactUnicodeCodePointsWithCanary(targetCodePoints);
        expect([...value].length, `${owner.id}:${delta}:code-points`).toBe(targetCodePoints);
        expect(value.length, `${owner.id}:${delta}:utf16-code-units`).toBeGreaterThan(
          targetCodePoints,
        );
        const result = parseUnicodeRuntimeOwner(
          owner.runtimeParser,
          replacePointer(parserInput, valuePointer, value),
        );
        const expected = owner.kind === 'ordinary' && delta <= 0;
        expect(result.success, `runtime-max:${owner.id}:${delta}`).toBe(expected);
        if (result.success) accepted += 1;
        else rejected += 1;

        if (!result.success) {
          const hasLengthIssue = hasRuntimeCodePointBoundaryIssue(
            result.error.issues,
            valuePointer,
            owner.minimumCodePoints,
            owner.maximumCodePoints,
          );
          expect(hasLengthIssue, `runtime-max-issue:${owner.id}:${delta}`).toBe(delta === 1);
          if (hasLengthIssue) targetIssues += 1;

          if (owner.kind === 'exact-derived') {
            const hasDerivedIssue = hasRuntimeCustomIssue(
              result.error.issues,
              valuePointer,
              exactDerivedIssueMessage(owner.id),
            );
            expect(hasDerivedIssue, `runtime-derived-issue:${owner.id}:${delta}`).toBe(true);
            if (hasDerivedIssue) exactDerivedIssues += 1;
          }

          const noCanary = !JSON.stringify(result.error.issues).includes(
            UNICODE_CODE_POINT_BOUNDARY_CANARY,
          );
          expect(noCanary, `runtime-max-no-canary:${owner.id}:${delta}`).toBe(true);
          if (noCanary) noCanaryChecks += 1;
        }
        outcomes += 1;
      }

      if (nullableOwnerIds.has(owner.id)) {
        expect(
          parseUnicodeRuntimeOwner(
            owner.runtimeParser,
            replacePointer(parserInput, valuePointer, null),
          ).success,
          `runtime-nullable:${owner.id}`,
        ).toBe(true);
        nullableRuntimeChecks += 1;
      }
    }

    expect({
      baselines,
      exactDerivedBaselines,
      outcomes,
      accepted,
      rejected,
      targetIssues,
      exactDerivedIssues,
      noCanaryChecks,
      nullableRuntimeChecks,
    }).toEqual({
      baselines: 29,
      exactDerivedBaselines: 3,
      outcomes: 87,
      accepted: 52,
      rejected: 35,
      targetIssues: 29,
      exactDerivedIssues: 9,
      noCanaryChecks: 35,
      nullableRuntimeChecks: 2,
    });
  }, 60_000);

  it('drives exact Unicode code-point maxima through all advertised public nodes', async () => {
    const corpus = ProtocolStructuralBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    const documents = Object.fromEntries(
      await Promise.all(
        Object.entries(artifactUrls).map(async ([name, url]) => [
          name,
          JSON.parse(await readFile(url, 'utf8')),
        ]),
      ),
    ) as Record<CheckedArtifactName, unknown>;
    const publicNodes = corpus.unicodeBoundaries.flatMap((boundary) =>
      boundary.artifactPointers.map(({ artifact, pointer }) => ({
        artifact,
        pointer,
        maximumCodePoints: boundary.maximumCodePoints,
      })),
    );
    expect(publicNodes).toHaveLength(corpus.unicodeScalarParity.expectedCounts.publicNodes);
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    let outcomes = 0;
    let accepted = 0;
    let rejected = 0;
    let targetIssues = 0;
    let noCanaryChecks = 0;
    let nullableContractChecks = 0;

    for (const { artifact, pointer, maximumCodePoints } of publicNodes) {
      const validate = ajv.compile(lookupPointer(documents[artifact], pointer) as AnySchema);
      for (const delta of [-1, 0, 1] as const) {
        const targetCodePoints = maximumCodePoints + delta;
        const value = exactUnicodeCodePointsWithCanary(targetCodePoints);
        expect([...value].length, `${artifact}:${pointer}:${delta}:code-points`).toBe(
          targetCodePoints,
        );
        expect(value.length, `${artifact}:${pointer}:${delta}:utf16-code-units`).toBeGreaterThan(
          targetCodePoints,
        );
        const expected = delta <= 0;
        const valid = validate(value);
        expect(valid, `public-max:${artifact}:${pointer}:${delta}`).toBe(expected);
        if (valid) accepted += 1;
        else rejected += 1;

        if (!expected) {
          const hasTargetIssue = validate.errors?.some(
            (issue) =>
              issue.instancePath === '' &&
              issue.keyword === 'maxLength' &&
              issue.params.limit === maximumCodePoints,
          );
          expect(hasTargetIssue, `public-max-issue:${artifact}:${pointer}`).toBe(true);
          if (hasTargetIssue) targetIssues += 1;
          const noCanary = !JSON.stringify(validate.errors).includes(
            UNICODE_CODE_POINT_BOUNDARY_CANARY,
          );
          expect(noCanary, `public-max-no-canary:${artifact}:${pointer}`).toBe(true);
          if (noCanary) noCanaryChecks += 1;
        }
        outcomes += 1;
      }
    }

    for (const wrapper of corpus.unicodeScalarParity.nullableWrappers) {
      const validate = ajv.compile(
        lookupPointer(documents[wrapper.artifact], wrapper.pointer) as AnySchema,
      );
      expect(validate(null), `contract-nullable:${wrapper.id}`).toBe(true);
      nullableContractChecks += 1;
    }

    expect({
      outcomes,
      accepted,
      rejected,
      targetIssues,
      noCanaryChecks,
      nullableContractChecks,
    }).toEqual({
      outcomes: 141,
      accepted: 94,
      rejected: 47,
      targetIssues: 47,
      noCanaryChecks: 47,
      nullableContractChecks: 2,
    });
  }, 60_000);

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
