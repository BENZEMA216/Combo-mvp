import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ContractSchemaDefinitions } from './artifacts.js';
import { canonicalizeJson } from './canonical.js';
import { BROKER_MAX_FRAME_BYTES } from './broker.js';
import {
  EVIDENCE_MAX_STRUCTURED_JSON_BYTES,
  MAX_PROPERTIES_SCHEMA_DESCRIPTION_PREFIX,
} from './evidence.js';
import { VNEXT_REGISTRY_YAML_MAX_ALIAS_EXPANSIONS } from './registry.js';
import {
  PUBLIC_SOURCE_AST_CENSUS_DIGEST,
  PUBLIC_SOURCE_AST_CENSUS_EXCLUSIONS,
  PUBLIC_SOURCE_AST_CENSUS_FAMILY_COUNTS,
  PUBLIC_SOURCE_AST_CENSUS_PROTOCOL,
  PUBLIC_SOURCE_AST_CENSUS_ROW_COUNT,
} from './public-source-census-contract.js';
import {
  SNAPSHOT_EXACT_PUBLICATION_COMMIT_MARKER_BYTES,
  SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES,
  SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES,
  SNAPSHOT_MAX_PUBLICATION_PREPARATION_MARKER_BYTES,
} from './snapshot.js';

export const PUBLIC_BOUNDARY_CLOSURE_PROTOCOL = 'combo.public-boundary-closure/1' as const;
export const PUBLIC_BOUNDARY_CLOSURE_AUTHORITY = 'ADR-VNEXT-034' as const;
export const PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH =
  'packages/creator-agent-protocol/fixtures/public-manual-cap-outcomes.v1.json' as const;
export const REGISTRY_YAML_MAX_ALIAS_COUNT = VNEXT_REGISTRY_YAML_MAX_ALIAS_EXPANSIONS;

const ArtifactNameSchema = z.enum(['contractSchemas', 'brokerContract', 'openApi']);
const BoundaryUnitSchema = z.enum([
  'string-code-units',
  'string-pattern',
  'number',
  'array-items',
  'tuple-items',
  'object-properties',
  'raw-bytes',
  'canonical-bytes',
  'yaml-alias-expansions',
]);
const BoundaryModeSchema = z.enum(['maximum', 'exact', 'pattern']);
const EvidenceBindingSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('covered'),
      probeId: z.string().min(1),
      testFile: z.string().min(1),
      execution: z.enum([
        'dynamic-zod-node',
        'artifact-constraint-fragment',
        'delegated-actual-root',
        'manual-cap-exact-probe',
      ]),
      fixture: z.string().min(1).optional(),
      outcomeFixture: z.literal(PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH).optional(),
      actualRoot: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('pending'),
      probeId: z.string().min(1),
      reason: z.enum([
        'full-source-ast-location-census',
        'snapshot-manifest-reachable-n-minus-one-n-plus-one',
        'formal-t0-linux-evidence',
      ]),
      plannedTestFile: z.string().min(1).optional(),
      actualRoot: z.string().min(1).optional(),
    })
    .strict(),
]);
export type PublicBoundaryEvidenceBinding = z.infer<typeof EvidenceBindingSchema>;

export const PublicBoundaryFingerprintRowSchema = z
  .object({
    id: z.string().min(1),
    fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    evidence: EvidenceBindingSchema,
  })
  .strict();
export type PublicBoundaryFingerprintRow = z.infer<typeof PublicBoundaryFingerprintRowSchema>;

export const PublicBoundaryManualCapSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    unit: BoundaryUnitSchema,
    mode: BoundaryModeSchema,
    boundary: z.number().int().positive(),
    probeOwner: z.string().min(1),
    expectedOutcomes: z.tuple([
      z.object({ delta: z.literal(-1), accepted: z.boolean() }).strict(),
      z.object({ delta: z.literal(0), accepted: z.boolean() }).strict(),
      z.object({ delta: z.literal(1), accepted: z.boolean() }).strict(),
    ]),
    evidence: EvidenceBindingSchema,
  })
  .strict()
  .superRefine((cap, context) => {
    if (
      cap.evidence.status !== 'covered' ||
      cap.evidence.outcomeFixture !== PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', 'outcomeFixture'],
        message: 'manual cap必须绑定machine outcome fixture',
      });
    }
  });
export type PublicBoundaryManualCap = z.infer<typeof PublicBoundaryManualCapSchema>;

const DelegatedFixtureSchema = z
  .object({
    path: z.string().min(1),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    testFiles: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type PublicBoundaryDelegatedFixture = z.infer<typeof DelegatedFixtureSchema>;

const ManualOutcomeFixtureBindingSchema = z
  .object({
    path: z.literal(PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();

const SourceAstCensusSchema = z
  .object({
    protocol: z.literal(PUBLIC_SOURCE_AST_CENSUS_PROTOCOL),
    digest: z.literal(PUBLIC_SOURCE_AST_CENSUS_DIGEST),
    rowCount: z.literal(PUBLIC_SOURCE_AST_CENSUS_ROW_COUNT),
    familyCounts: z.record(z.string().min(1), z.number().int().nonnegative()),
    testFile: z.literal(
      'packages/creator-agent-protocol/src/__tests__/public-source-ast-census.test.ts',
    ),
    exclusions: z.tuple([
      z.literal('runtime-http-body-limit-remains-explicit-non-product-policy'),
      z.literal('derived-byte-equalities-are-invariants-not-independent-product-caps'),
    ]),
  })
  .strict();

const RequiredExternalEvidenceSchema = z
  .object({
    environment: z.literal('T0-LINUX-CI'),
    status: z.literal('NOT_RUN'),
    command: z.literal('pnpm vnext:test:g0'),
    binding: z.literal('clean-source-sha-and-workflow-run-required'),
  })
  .strict();

export const PublicBoundaryClosureCorpusSchema = z
  .object({
    protocol: z.literal(PUBLIC_BOUNDARY_CLOSURE_PROTOCOL),
    schemaVersion: z.literal(1),
    authority: z.literal(PUBLIC_BOUNDARY_CLOSURE_AUTHORITY),
    status: z.literal('implemented'),
    checkedArtifactDigests: z.record(
      ArtifactNameSchema,
      z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    ),
    sourceRows: z.array(PublicBoundaryFingerprintRowSchema).min(1),
    artifactRows: z.array(PublicBoundaryFingerprintRowSchema).min(1),
    manualCaps: z.array(PublicBoundaryManualCapSchema).length(7),
    manualOutcomeFixture: ManualOutcomeFixtureBindingSchema,
    delegatedFixtures: z.array(DelegatedFixtureSchema),
    sourceAstCensus: SourceAstCensusSchema,
    remainingBoundaryClasses: z.tuple([]),
    requiredExternalEvidence: z.tuple([RequiredExternalEvidenceSchema]),
    nonClaims: z.tuple([
      z.literal('does-not-prove-formal-t0-linux-pass'),
      z.literal('does-not-complete-snp-008'),
      z.literal('does-not-prove-transport-storage-or-production'),
    ]),
  })
  .strict();
export type PublicBoundaryClosureCorpus = z.infer<typeof PublicBoundaryClosureCorpusSchema>;

export const PUBLIC_BOUNDARY_SOURCE_AST_CENSUS = Object.freeze({
  protocol: PUBLIC_SOURCE_AST_CENSUS_PROTOCOL,
  digest: PUBLIC_SOURCE_AST_CENSUS_DIGEST,
  rowCount: PUBLIC_SOURCE_AST_CENSUS_ROW_COUNT,
  familyCounts: PUBLIC_SOURCE_AST_CENSUS_FAMILY_COUNTS,
  testFile:
    'packages/creator-agent-protocol/src/__tests__/public-source-ast-census.test.ts' as const,
  exclusions: PUBLIC_SOURCE_AST_CENSUS_EXCLUSIONS,
});

type CanonicalScalar = null | boolean | number | string;
type CanonicalValue = CanonicalScalar | CanonicalValue[] | { [key: string]: CanonicalValue };
type InternalDef = Record<string, unknown> & { typeName?: string; description?: string };
type InternalSchema = z.ZodTypeAny & { _def: InternalDef };

type SourceBoundaryRow = Readonly<{
  schema: z.ZodTypeAny;
  root: string;
  pointer: string;
  kind: string;
  unit: z.infer<typeof BoundaryUnitSchema>;
  mode: z.infer<typeof BoundaryModeSchema>;
  constraint: CanonicalValue;
}>;

type ArtifactBoundaryRow = Readonly<{
  node: Record<string, unknown>;
  artifact: z.infer<typeof ArtifactNameSchema>;
  pointer: string;
  constraints: Record<string, CanonicalValue>;
}>;

const ARTIFACT_CONSTRAINT_KEYS = [
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'x-combo-maxUtf8Bytes',
  'x-combo-unicodeCodePoints',
  'x-combo-canonicalBase64UrlBytes',
] as const;

const NUMERIC_RESOURCE_LITERAL_NAMES = new Set([
  'fileDescriptors',
  'idleTtlSeconds',
  'maxActiveConversations',
  'maxActiveTurns',
  'maxUtf8Bytes',
  'memoryBytes',
  'pids',
  'scratchBytes',
  'turnDeadlineSeconds',
  'vcpu',
]);

function numericResourcePointer(pointer: string): boolean {
  return NUMERIC_RESOURCE_LITERAL_NAMES.has(pointer.split('/').at(-1) ?? '');
}

function sha256Canonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalizeJson(value)).digest('hex')}`;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointerChild(pointer: string, segment: string | number): string {
  return `${pointer}/${escapePointerSegment(String(segment))}`;
}

function asInternalSchema(value: unknown): InternalSchema | undefined {
  if (value === null || typeof value !== 'object' || !('_def' in value)) return undefined;
  return value as InternalSchema;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function addSourceRow(
  rows: SourceBoundaryRow[],
  schema: z.ZodTypeAny,
  root: string,
  pointer: string,
  kind: string,
  unit: SourceBoundaryRow['unit'],
  mode: SourceBoundaryRow['mode'],
  constraint: CanonicalValue,
): void {
  rows.push({ schema, root, pointer: pointer || '/', kind, unit, mode, constraint });
}

function collectSourceSchema(
  schema: z.ZodTypeAny,
  root: string,
  pointer: string,
  rows: SourceBoundaryRow[],
  stack: Set<z.ZodTypeAny>,
): void {
  if (stack.has(schema)) return;
  stack.add(schema);
  const internal = schema as InternalSchema;
  const definition = internal._def;
  const maxPropertiesDescription = definition.description?.startsWith(
    MAX_PROPERTIES_SCHEMA_DESCRIPTION_PREFIX,
  )
    ? Number(definition.description.slice(MAX_PROPERTIES_SCHEMA_DESCRIPTION_PREFIX.length))
    : undefined;
  if (Number.isSafeInteger(maxPropertiesDescription) && maxPropertiesDescription! > 0) {
    addSourceRow(
      rows,
      schema,
      root,
      pointer,
      'record-max-properties',
      'object-properties',
      'maximum',
      maxPropertiesDescription!,
    );
  }

  switch (definition.typeName) {
    case 'ZodString': {
      const checks: unknown[] = Array.isArray(definition.checks) ? definition.checks : [];
      checks.forEach((rawCheck, index) => {
        const check = asRecord(rawCheck);
        if (check === undefined || typeof check.kind !== 'string') return;
        if (check.kind === 'max' && typeof check.value === 'number') {
          addSourceRow(
            rows,
            schema,
            root,
            pointer,
            `string-max-${index}`,
            'string-code-units',
            'maximum',
            { maximum: check.value },
          );
        } else if (check.kind === 'length' && typeof check.value === 'number') {
          addSourceRow(
            rows,
            schema,
            root,
            pointer,
            `string-length-${index}`,
            'string-code-units',
            'exact',
            {
              exact: check.value,
            },
          );
        } else if (check.kind === 'regex' && check.regex instanceof RegExp) {
          addSourceRow(
            rows,
            schema,
            root,
            pointer,
            `string-regex-${index}`,
            'string-pattern',
            'pattern',
            { flags: check.regex.flags, source: check.regex.source },
          );
        } else if (['uuid', 'url', 'datetime', 'email'].includes(check.kind)) {
          addSourceRow(
            rows,
            schema,
            root,
            pointer,
            `string-${check.kind}-${index}`,
            'string-pattern',
            'pattern',
            {
              check: check.kind,
            },
          );
        }
      });
      break;
    }
    case 'ZodNumber': {
      const checks: unknown[] = Array.isArray(definition.checks) ? definition.checks : [];
      checks.forEach((rawCheck, index) => {
        const check = asRecord(rawCheck);
        if (check?.kind === 'max' && typeof check.value === 'number') {
          addSourceRow(rows, schema, root, pointer, `number-max-${index}`, 'number', 'maximum', {
            inclusive: check.inclusive === true,
            maximum: check.value,
          });
        }
      });
      break;
    }
    case 'ZodLiteral': {
      if (typeof definition.value === 'number' && numericResourcePointer(pointer)) {
        addSourceRow(rows, schema, root, pointer, 'numeric-resource-literal', 'number', 'exact', {
          exact: definition.value,
        });
      }
      break;
    }
    case 'ZodArray': {
      const maxLength = asRecord(definition.maxLength)?.value;
      const exactLength = asRecord(definition.exactLength)?.value;
      if (typeof maxLength === 'number') {
        addSourceRow(rows, schema, root, pointer, 'array-max', 'array-items', 'maximum', {
          maximum: maxLength,
        });
      }
      if (typeof exactLength === 'number') {
        addSourceRow(rows, schema, root, pointer, 'array-length', 'array-items', 'exact', {
          exact: exactLength,
        });
      }
      const item = asInternalSchema(definition.type);
      if (item !== undefined)
        collectSourceSchema(item, root, pointerChild(pointer, 'items'), rows, stack);
      break;
    }
    case 'ZodTuple': {
      const items: unknown[] = Array.isArray(definition.items) ? definition.items : [];
      if (definition.rest === null || definition.rest === undefined) {
        addSourceRow(rows, schema, root, pointer, 'tuple-length', 'tuple-items', 'exact', {
          exact: items.length,
        });
      }
      items.forEach((item, index) => {
        const nested = asInternalSchema(item);
        if (nested !== undefined) {
          collectSourceSchema(
            nested,
            root,
            pointerChild(pointerChild(pointer, 'items'), index),
            rows,
            stack,
          );
        }
      });
      break;
    }
    case 'ZodObject': {
      const rawShape =
        typeof definition.shape === 'function' ? definition.shape() : definition.shape;
      const shape = asRecord(rawShape) ?? {};
      for (const [key, value] of Object.entries(shape)) {
        const nested = asInternalSchema(value);
        if (nested !== undefined)
          collectSourceSchema(nested, root, pointerChild(pointer, key), rows, stack);
      }
      break;
    }
    case 'ZodRecord': {
      const key = asInternalSchema(definition.keyType);
      const value = asInternalSchema(definition.valueType);
      if (key !== undefined)
        collectSourceSchema(key, root, pointerChild(pointer, 'propertyNames'), rows, stack);
      if (value !== undefined) {
        collectSourceSchema(
          value,
          root,
          pointerChild(pointer, 'additionalProperties'),
          rows,
          stack,
        );
      }
      break;
    }
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options: unknown[] = Array.isArray(definition.options) ? definition.options : [];
      options.forEach((option, index) => {
        const nested = asInternalSchema(option);
        if (nested !== undefined) {
          collectSourceSchema(
            nested,
            root,
            pointerChild(pointerChild(pointer, 'anyOf'), index),
            rows,
            stack,
          );
        }
      });
      break;
    }
    case 'ZodIntersection': {
      for (const [name, value] of [
        ['left', definition.left],
        ['right', definition.right],
      ] as const) {
        const nested = asInternalSchema(value);
        if (nested !== undefined)
          collectSourceSchema(nested, root, pointerChild(pointer, name), rows, stack);
      }
      break;
    }
    case 'ZodEffects': {
      const nested = asInternalSchema(definition.schema);
      if (nested !== undefined) collectSourceSchema(nested, root, pointer, rows, stack);
      break;
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
    case 'ZodBranded': {
      const nested = asInternalSchema(definition.innerType ?? definition.type);
      if (nested !== undefined) collectSourceSchema(nested, root, pointer, rows, stack);
      break;
    }
    case 'ZodPipeline': {
      for (const [name, value] of [
        ['in', definition.in],
        ['out', definition.out],
      ] as const) {
        const nested = asInternalSchema(value);
        if (nested !== undefined)
          collectSourceSchema(nested, root, pointerChild(pointer, name), rows, stack);
      }
      break;
    }
    case 'ZodLazy': {
      const nested =
        typeof definition.getter === 'function' ? asInternalSchema(definition.getter()) : undefined;
      if (nested !== undefined) collectSourceSchema(nested, root, pointer, rows, stack);
      break;
    }
    default:
      break;
  }
  stack.delete(schema);
}

function sourceRowId(row: SourceBoundaryRow): string {
  return `source:${row.root}:${row.pointer}:${row.kind}`;
}

function sourceEvidenceBinding(row: SourceBoundaryRow): PublicBoundaryEvidenceBinding {
  const id = sourceRowId(row);
  if (/^string-(?:regex|uuid|datetime|url|email)-/u.test(row.kind)) {
    return {
      status: 'covered',
      probeId: `public-string-pattern:${id}`,
      testFile:
        'packages/creator-agent-protocol/src/__tests__/public-string-pattern-census.test.ts',
      execution: 'dynamic-zod-node',
    };
  }
  if (
    /^(?:string-max-|string-length-|number-max-|array-max$|array-length$|tuple-length$|numeric-resource-literal$|record-max-properties$)/u.test(
      row.kind,
    )
  ) {
    return {
      status: 'covered',
      probeId: `dynamic-zod:${id}`,
      testFile: 'packages/creator-agent-protocol/src/__tests__/public-boundary-row-probes.test.ts',
      execution: 'dynamic-zod-node',
    };
  }
  throw new TypeError(`PUBLIC_SOURCE_BOUNDARY_PROBE_CLASSIFICATION_MISSING:${id}`);
}

function canonicalSourceDescriptor(row: SourceBoundaryRow): Omit<SourceBoundaryRow, 'schema'> {
  const { schema: _schema, ...descriptor } = row;
  return descriptor;
}

export type PublicSourceBoundaryProbeTarget = Readonly<{
  row: PublicBoundaryFingerprintRow;
  schema: z.ZodTypeAny;
  descriptor: Omit<SourceBoundaryRow, 'schema'>;
}>;

export function collectPublicSourceBoundaryProbeTargets(): PublicSourceBoundaryProbeTarget[] {
  const rows: SourceBoundaryRow[] = [];
  for (const [root, schema] of Object.entries(ContractSchemaDefinitions)) {
    collectSourceSchema(schema, root, '', rows, new Set());
  }
  return rows
    .map((row) => {
      const descriptor = canonicalSourceDescriptor(row);
      return {
        row: {
          id: sourceRowId(row),
          fingerprint: sha256Canonical(descriptor),
          evidence: sourceEvidenceBinding(row),
        },
        schema: row.schema,
        descriptor,
      };
    })
    .sort((left, right) => left.row.id.localeCompare(right.row.id));
}

export function collectPublicSourceBoundaryRows(): PublicBoundaryFingerprintRow[] {
  return collectPublicSourceBoundaryProbeTargets().map(({ row }) => row);
}

function collectArtifactDocument(
  artifact: z.infer<typeof ArtifactNameSchema>,
  value: unknown,
  pointer: string,
  rows: ArtifactBoundaryRow[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectArtifactDocument(artifact, item, pointerChild(pointer, index), rows),
    );
    return;
  }
  const object = asRecord(value);
  if (object === undefined) return;
  const constraints: Record<string, CanonicalValue> = {};
  for (const key of ARTIFACT_CONSTRAINT_KEYS) {
    const candidate = object[key];
    if (
      candidate === null ||
      typeof candidate === 'boolean' ||
      typeof candidate === 'number' ||
      typeof candidate === 'string' ||
      Array.isArray(candidate) ||
      asRecord(candidate) !== undefined
    ) {
      if (candidate !== undefined) constraints[key] = candidate as CanonicalValue;
    }
  }
  if (typeof object.const === 'number' && numericResourcePointer(pointer)) {
    constraints.const = object.const;
  }
  if (Object.keys(constraints).length > 0) {
    rows.push({ node: object, artifact, pointer: pointer || '/', constraints });
  }
  for (const [key, candidate] of Object.entries(object)) {
    collectArtifactDocument(artifact, candidate, pointerChild(pointer, key), rows);
  }
}

function artifactRowId(row: ArtifactBoundaryRow): string {
  return `artifact:${row.artifact}:${row.pointer}`;
}

function canonicalArtifactDescriptor(row: ArtifactBoundaryRow): Omit<ArtifactBoundaryRow, 'node'> {
  const { node: _node, ...descriptor } = row;
  return descriptor;
}

export type PublicArtifactBoundaryProbeTarget = Readonly<{
  row: PublicBoundaryFingerprintRow;
  node: Record<string, unknown>;
  descriptor: Omit<ArtifactBoundaryRow, 'node'>;
}>;

export function collectPublicArtifactBoundaryProbeTargets(
  documents: Readonly<Record<z.infer<typeof ArtifactNameSchema>, unknown>>,
): PublicArtifactBoundaryProbeTarget[] {
  const rows: ArtifactBoundaryRow[] = [];
  for (const [artifact, document] of Object.entries(documents) as Array<
    [z.infer<typeof ArtifactNameSchema>, unknown]
  >) {
    collectArtifactDocument(artifact, document, '', rows);
  }
  return rows
    .map((row) => {
      const descriptor = canonicalArtifactDescriptor(row);
      const id = artifactRowId(row);
      return {
        row: {
          id,
          fingerprint: sha256Canonical(descriptor),
          evidence: {
            status: 'covered',
            probeId: `artifact-fragment:${id}`,
            testFile:
              'packages/creator-agent-protocol/src/__tests__/public-boundary-row-probes.test.ts',
            execution: 'artifact-constraint-fragment',
          },
        },
        node: row.node,
        descriptor,
      } satisfies PublicArtifactBoundaryProbeTarget;
    })
    .sort((left, right) => left.row.id.localeCompare(right.row.id));
}

export function collectPublicArtifactBoundaryRows(
  documents: Readonly<Record<z.infer<typeof ArtifactNameSchema>, unknown>>,
): PublicBoundaryFingerprintRow[] {
  return collectPublicArtifactBoundaryProbeTargets(documents).map(({ row }) => row);
}

export const PUBLIC_BOUNDARY_MANUAL_CAPS: readonly PublicBoundaryManualCap[] = Object.freeze([
  {
    id: 'broker-frame-bytes',
    source: 'src/broker.ts:BROKER_MAX_FRAME_BYTES',
    unit: 'raw-bytes',
    mode: 'maximum',
    boundary: BROKER_MAX_FRAME_BYTES,
    probeOwner: 'parseBrokerHandshake+parseBrokerFrame',
    expectedOutcomes: [
      { delta: -1, accepted: true },
      { delta: 0, accepted: true },
      { delta: 1, accepted: false },
    ],
    evidence: {
      status: 'covered',
      probeId: 'manual-cap:broker-frame:n-minus-one-n-plus-one',
      testFile: 'packages/creator-agent-protocol/src/__tests__/wire-boundaries.test.ts',
      execution: 'manual-cap-exact-probe',
      outcomeFixture: PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH,
      fixture: 'packages/creator-agent-protocol/fixtures/protocol-wire-boundaries.v1.json',
      actualRoot: 'parseBrokerHandshake+parseBrokerFrame',
    },
  },
  {
    id: 'evidence-structured-json-bytes',
    source: 'src/evidence.ts:EVIDENCE_MAX_STRUCTURED_JSON_BYTES',
    unit: 'raw-bytes',
    mode: 'maximum',
    boundary: EVIDENCE_MAX_STRUCTURED_JSON_BYTES,
    probeOwner: 'validateEvidenceBundleChain',
    expectedOutcomes: [
      { delta: -1, accepted: true },
      { delta: 0, accepted: true },
      { delta: 1, accepted: false },
    ],
    evidence: {
      status: 'covered',
      probeId: 'manual-cap:evidence-json:n-minus-one-n-plus-one',
      testFile: 'packages/creator-agent-protocol/src/__tests__/schemas.test.ts',
      execution: 'manual-cap-exact-probe',
      outcomeFixture: PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH,
      actualRoot: 'validateEvidenceBundleChain',
    },
  },
  {
    id: 'snapshot-manifest-canonical-bytes',
    source: 'src/snapshot.ts:SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES',
    unit: 'canonical-bytes',
    mode: 'maximum',
    boundary: SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES,
    probeOwner: '@cb/creator-agent-snapshot:parseSnapshotManifest',
    expectedOutcomes: [
      { delta: -1, accepted: true },
      { delta: 0, accepted: true },
      { delta: 1, accepted: false },
    ],
    evidence: {
      status: 'covered',
      probeId: 'manual-cap:snapshot-manifest-canonical:n-minus-one-n-plus-one',
      testFile:
        'packages/creator-agent-snapshot/src/__tests__/manifest-canonical-byte-maximum.test.ts',
      execution: 'manual-cap-exact-probe',
      outcomeFixture: PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH,
      actualRoot: '@cb/creator-agent-snapshot:parseSnapshotManifest',
    },
  },
  {
    id: 'snapshot-manifest-raw-defense-bytes',
    source: 'src/snapshot.ts:SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES',
    unit: 'raw-bytes',
    mode: 'maximum',
    boundary: SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES,
    probeOwner: 'parseSnapshotManifestCipherObject',
    expectedOutcomes: [
      { delta: -1, accepted: true },
      { delta: 0, accepted: true },
      { delta: 1, accepted: false },
    ],
    evidence: {
      status: 'covered',
      probeId: 'manual-cap:snapshot-manifest-raw-defense:n-minus-one-n-plus-one',
      testFile:
        'packages/creator-agent-snapshot/src/__tests__/manifest-canonical-byte-maximum.test.ts',
      execution: 'manual-cap-exact-probe',
      outcomeFixture: PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH,
      actualRoot: 'parseSnapshotManifestCipherObject',
    },
  },
  {
    id: 'snapshot-publication-preparation-canonical-bytes',
    source: 'src/snapshot.ts:SNAPSHOT_MAX_PUBLICATION_PREPARATION_MARKER_BYTES',
    unit: 'canonical-bytes',
    mode: 'maximum',
    boundary: SNAPSHOT_MAX_PUBLICATION_PREPARATION_MARKER_BYTES,
    probeOwner: 'parseSnapshotPublicationPreparationMarker',
    expectedOutcomes: [
      { delta: -1, accepted: true },
      { delta: 0, accepted: true },
      { delta: 1, accepted: false },
    ],
    evidence: {
      status: 'covered',
      probeId: 'manual-cap:preparation-marker:n-minus-one-n-plus-one',
      testFile:
        'packages/creator-agent-protocol/src/__tests__/publication-marker-byte-boundaries.test.ts',
      execution: 'manual-cap-exact-probe',
      outcomeFixture: PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH,
      actualRoot: 'parseSnapshotPublicationPreparationMarker',
    },
  },
  {
    id: 'snapshot-publication-commit-canonical-bytes',
    source: 'src/snapshot.ts:SNAPSHOT_EXACT_PUBLICATION_COMMIT_MARKER_BYTES',
    unit: 'canonical-bytes',
    mode: 'exact',
    boundary: SNAPSHOT_EXACT_PUBLICATION_COMMIT_MARKER_BYTES,
    probeOwner: 'parseSnapshotPublicationCommitMarker',
    expectedOutcomes: [
      { delta: -1, accepted: false },
      { delta: 0, accepted: true },
      { delta: 1, accepted: false },
    ],
    evidence: {
      status: 'covered',
      probeId: 'manual-cap:commit-marker:exact-n-minus-one-n-plus-one',
      testFile:
        'packages/creator-agent-protocol/src/__tests__/publication-marker-byte-boundaries.test.ts',
      execution: 'manual-cap-exact-probe',
      outcomeFixture: PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH,
      actualRoot: 'parseSnapshotPublicationCommitMarker',
    },
  },
  {
    id: 'registry-yaml-alias-expansions',
    source: 'src/registry.ts:VNEXT_REGISTRY_YAML_MAX_ALIAS_EXPANSIONS',
    unit: 'yaml-alias-expansions',
    mode: 'maximum',
    boundary: REGISTRY_YAML_MAX_ALIAS_COUNT,
    probeOwner: 'parseVnextRegistryYaml',
    expectedOutcomes: [
      { delta: -1, accepted: true },
      { delta: 0, accepted: true },
      { delta: 1, accepted: false },
    ],
    evidence: {
      status: 'covered',
      probeId: 'manual-cap:registry-yaml-alias:n-minus-one-n-plus-one',
      testFile: 'packages/creator-agent-protocol/src/__tests__/public-boundary-closure.test.ts',
      execution: 'manual-cap-exact-probe',
      outcomeFixture: PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH,
      actualRoot: 'parseVnextRegistryYaml',
    },
  },
]);

export function artifactDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
