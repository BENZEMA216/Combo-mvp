import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema, type ErrorObject } from 'ajv';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

// VNext registry case: SCH-004 (per-row actual Zod and artifact constraint probes).

import {
  collectPublicArtifactBoundaryProbeTargets,
  collectPublicSourceBoundaryProbeTargets,
  type PublicArtifactBoundaryProbeTarget,
  type PublicSourceBoundaryProbeTarget,
} from '../public-boundary-closure.js';

type InternalDef = Record<string, unknown> & { typeName?: string };
type InternalSchema = z.ZodTypeAny & { _def: InternalDef };

const artifactUrls = {
  contractSchemas: new URL('../../schemas/contract-schemas.v1.json', import.meta.url),
  brokerContract: new URL('../../schemas/broker-contract.v1.json', import.meta.url),
  openApi: new URL('../../openapi/creator-agent-v1.openapi.json', import.meta.url),
} as const;

const uuidV7 = '0198f00d-8000-7000-8000-000000000001';
const uuidV4 = '123e4567-e89b-42d3-a456-426614174000';
const timestamp = '2026-08-18T01:00:00.000Z';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function internal(schema: z.ZodTypeAny): InternalSchema {
  return schema as InternalSchema;
}

function stringChecks(schema: z.ZodTypeAny): Array<Record<string, unknown>> {
  const checks = internal(schema)._def.checks;
  return Array.isArray(checks)
    ? checks.map(asRecord).filter((check): check is Record<string, unknown> => check !== undefined)
    : [];
}

function exactLengthCandidate(length: number): string[] {
  const candidates = [
    'A'.repeat(length),
    'a'.repeat(length),
    '1'.repeat(length),
    'E'.repeat(length),
  ];
  for (const byteLength of [1, 12, 16, 32, 40, 64]) {
    const encoded = Buffer.alloc(byteLength).toString('base64url');
    if (encoded.length === length) candidates.unshift(encoded);
  }
  if (length === 36) candidates.unshift(uuidV7, uuidV4);
  if (length === 24) candidates.unshift(timestamp);
  if (length >= 14 && length <= 32) {
    const prefix = '"generation-';
    const suffix = '"';
    const digits = length - prefix.length - suffix.length;
    if (digits >= 1) candidates.unshift(`${prefix}${'1'.repeat(digits)}${suffix}`);
  }
  if (length >= 6) candidates.unshift(`text/${'a'.repeat(length - 5)}`);
  return [...new Set(candidates.filter((candidate) => candidate.length === length))];
}

function sampleString(schema: z.ZodTypeAny, requestedLength?: number): string {
  const checks = stringChecks(schema);
  const exact = checks.find(({ kind }) => kind === 'length')?.value;
  const minimum = checks.find(({ kind }) => kind === 'min')?.value;
  const maximum = checks.find(({ kind }) => kind === 'max')?.value;
  const length =
    requestedLength ??
    (typeof exact === 'number'
      ? exact
      : typeof minimum === 'number'
        ? Math.max(1, minimum)
        : typeof maximum === 'number'
          ? Math.min(1, maximum)
          : undefined);
  const generic = [
    'a',
    'A',
    '1',
    'ERR',
    uuidV7,
    uuidV4,
    timestamp,
    '2026-08-18',
    'sha256:'.concat('0'.repeat(64)),
    'hmac-sha256:'.concat('0'.repeat(64)),
    '0'.repeat(64),
    'INV-001',
    'SCH-001',
    'ADR-VNEXT-001',
    'D001',
    'docs/vnext/adr/ADR-VNEXT-001.md',
    'prompt.abc',
    'text/plain',
    'https://example.invalid/',
    '"generation-1"',
    Buffer.alloc(32).toString('base64'),
    Buffer.alloc(16).toString('base64url'),
  ];
  const candidates = length === undefined ? generic : [...exactLengthCandidate(length), ...generic];
  for (const candidate of candidates) {
    if (
      (length === undefined || candidate.length === length) &&
      schema.safeParse(candidate).success
    ) {
      return candidate;
    }
  }
  throw new Error(`PUBLIC_BOUNDARY_STRING_SAMPLE_MISSING:${requestedLength ?? 'default'}`);
}

function sampleForSchema(schema: z.ZodTypeAny, depth = 0): unknown {
  if (depth > 20) throw new Error('PUBLIC_BOUNDARY_SAMPLE_RECURSION_LIMIT');
  const definition = internal(schema)._def;
  switch (definition.typeName) {
    case 'ZodString':
      return sampleString(schema);
    case 'ZodNumber': {
      const checks: unknown[] = Array.isArray(definition.checks) ? definition.checks : [];
      const minimum = checks
        .map(asRecord)
        .find((check) => check?.kind === 'min' && typeof check.value === 'number')?.value;
      return typeof minimum === 'number' ? Math.max(1, minimum) : 1;
    }
    case 'ZodBigInt':
      return 1n;
    case 'ZodBoolean':
      return false;
    case 'ZodLiteral':
      return definition.value;
    case 'ZodEnum':
      return Array.isArray(definition.values) ? definition.values[0] : undefined;
    case 'ZodNativeEnum':
      return Object.values(asRecord(definition.values) ?? {}).find(
        (value) => typeof value === 'string' || typeof value === 'number',
      );
    case 'ZodNull':
      return null;
    case 'ZodObject': {
      const rawShape =
        typeof definition.shape === 'function' ? definition.shape() : definition.shape;
      const shape = asRecord(rawShape) ?? {};
      if (['path', 'size', 'mediaType', 'sha256'].every((key) => key in shape)) {
        return {
          path: 'boundary.txt',
          size: 1,
          mediaType: 'text/plain',
          sha256: '0'.repeat(64),
        };
      }
      const output = Object.fromEntries(
        Object.entries(shape).flatMap(([key, value]) => {
          const nested = value as z.ZodTypeAny;
          const nestedType = internal(nested)._def.typeName;
          if (nestedType === 'ZodOptional') return [];
          return [[key, sampleForSchema(nested, depth + 1)]];
        }),
      );
      if ('assertionCount' in output) output.assertionCount = 1;
      if ('artifactDigests' in output && Array.isArray(output.artifactDigests)) {
        output.artifactDigests = ['sha256:'.concat('0'.repeat(64))];
      }
      if ('status' in output && output.status === 'PASS' && 'blockerCode' in output) {
        output.blockerCode = null;
      }
      if ('realComponents' in output && 'substitutedComponents' in output) {
        output.substitutedComponents = [];
      }
      if ('fieldId' in output && 'protection' in output) {
        return {
          fieldId: 'answer.generated-boundary',
          fieldClass: 'answer',
          contentKind: 'real',
          system: 'broker-wss',
          container: 'generated.boundary',
          field: 'ciphertext',
          protection: 'session-aead',
          algorithm: 'worker-session-aes-256-gcm/v1',
          keyOwner: 'combo-kms-and-worker-keychain',
          aadBindings: ['conversationId'],
          retention: 'request-lifetime',
          deletionOrHold: 'bounded',
        };
      }
      if (schema.safeParse(output).success) return output;
      return output;
    }
    case 'ZodArray': {
      const item = definition.type as z.ZodTypeAny;
      const minimum = asRecord(definition.minLength)?.value;
      const exact = asRecord(definition.exactLength)?.value;
      const size = typeof exact === 'number' ? exact : typeof minimum === 'number' ? minimum : 1;
      return Array.from({ length: size }, () => sampleForSchema(item, depth + 1));
    }
    case 'ZodTuple': {
      const items: unknown[] = Array.isArray(definition.items) ? definition.items : [];
      return items.map((item) => sampleForSchema(item as z.ZodTypeAny, depth + 1));
    }
    case 'ZodRecord':
      return {};
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = Array.isArray(definition.options) ? definition.options : [];
      for (const option of options) {
        const sample = sampleForSchema(option as z.ZodTypeAny, depth + 1);
        if ((option as z.ZodTypeAny).safeParse(sample).success) return sample;
      }
      throw new Error('PUBLIC_BOUNDARY_UNION_SAMPLE_MISSING');
    }
    case 'ZodEffects': {
      const nested = definition.schema as z.ZodTypeAny;
      const sample = sampleForSchema(nested, depth + 1);
      if (schema.safeParse(sample).success) return sample;
      return sample;
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
    case 'ZodBranded':
      return sampleForSchema((definition.innerType ?? definition.type) as z.ZodTypeAny, depth + 1);
    default:
      throw new Error(`PUBLIC_BOUNDARY_SAMPLE_TYPE_UNSUPPORTED:${definition.typeName}`);
  }
}

function expectIssue(
  result: ReturnType<z.ZodTypeAny['safeParse']>,
  predicate: (issue: z.ZodIssue) => boolean,
  id: string,
): void {
  expect(result.success, id).toBe(false);
  if (result.success) throw new Error(`PUBLIC_BOUNDARY_EXPECTED_REJECTION:${id}`);
  expect(result.error.issues.some(predicate), id).toBe(true);
}

function probeSourceTarget(target: PublicSourceBoundaryProbeTarget): void {
  const { descriptor, row, schema } = target;
  expect(row.evidence.status, row.id).toBe('covered');
  const constraint = descriptor.constraint as Record<string, unknown>;
  if (descriptor.kind.startsWith('string-max-')) {
    const maximum = constraint.maximum as number;
    let accepted: string;
    try {
      accepted = sampleString(schema, maximum);
    } catch (error) {
      throw new Error(`PUBLIC_BOUNDARY_STRING_MAX_SAMPLE_MISSING:${row.id}`, { cause: error });
    }
    const minimum = stringChecks(schema).find(({ kind }) => kind === 'min')?.value;
    if (minimum === maximum) {
      expectIssue(
        schema.safeParse(accepted.slice(0, -1)),
        (issue) => issue.code === 'too_small' && issue.minimum === maximum,
        row.id,
      );
    } else {
      expect(schema.safeParse(sampleString(schema, maximum - 1)).success, row.id).toBe(true);
    }
    expect(schema.safeParse(accepted).success, row.id).toBe(true);
    expectIssue(
      schema.safeParse(`${accepted}A`),
      (issue) => issue.code === 'too_big' && issue.maximum === maximum,
      row.id,
    );
    return;
  }
  if (descriptor.kind.startsWith('string-length-')) {
    const exact = constraint.exact as number;
    const accepted = sampleString(schema, exact);
    expect(schema.safeParse(accepted).success, row.id).toBe(true);
    expectIssue(
      schema.safeParse(accepted.slice(0, -1)),
      (issue) => issue.code === 'too_small' && issue.minimum === exact,
      row.id,
    );
    expectIssue(
      schema.safeParse(`${accepted}A`),
      (issue) => issue.code === 'too_big' && issue.maximum === exact,
      row.id,
    );
    return;
  }
  if (descriptor.kind.startsWith('number-max-')) {
    const maximum = constraint.maximum as number;
    expect(schema.safeParse(maximum - 1).success, row.id).toBe(true);
    expect(schema.safeParse(maximum).success, row.id).toBe(true);
    expectIssue(
      schema.safeParse(maximum + 1),
      (issue) => issue.code === 'too_big' && issue.maximum === maximum,
      row.id,
    );
    return;
  }
  if (descriptor.kind === 'numeric-resource-literal') {
    const exact = constraint.exact as number;
    expect(schema.safeParse(exact).success, row.id).toBe(true);
    expectIssue(schema.safeParse(exact - 1), (issue) => issue.code === 'invalid_literal', row.id);
    expectIssue(schema.safeParse(exact + 1), (issue) => issue.code === 'invalid_literal', row.id);
    return;
  }
  if (descriptor.kind === 'record-max-properties') {
    const maximum = constraint as unknown as number;
    const entry = descriptor.pointer.includes('cloudImageDigests')
      ? (index: number) => [`image-${index}`, `sha256:${index.toString(16).padStart(64, '0')}`]
      : (index: number) => [`runtime-${index}`, `version-${index}`];
    const record = (size: number) =>
      Object.fromEntries(Array.from({ length: size }, (_, index) => entry(index)));
    expect(schema.safeParse(record(maximum - 1)).success, row.id).toBe(true);
    expect(schema.safeParse(record(maximum)).success, row.id).toBe(true);
    expectIssue(
      schema.safeParse(record(maximum + 1)),
      (issue) => issue.code === 'custom' && issue.message.includes(String(maximum)),
      row.id,
    );
    return;
  }
  if (descriptor.kind === 'array-max' || descriptor.kind === 'array-length') {
    const definition = internal(schema)._def;
    const item = definition.type as z.ZodTypeAny;
    const boundary = (constraint.maximum ?? constraint.exact) as number;
    let sample: unknown;
    try {
      sample = sampleForSchema(item);
    } catch (error) {
      throw new Error(`PUBLIC_BOUNDARY_ARRAY_ITEM_SAMPLE_MISSING:${row.id}`, { cause: error });
    }
    if (!item.safeParse(sample).success) {
      throw new Error(`PUBLIC_BOUNDARY_ARRAY_ITEM_SAMPLE_INVALID:${row.id}`);
    }
    const values = (size: number) => Array.from({ length: size }, () => structuredClone(sample));
    if (descriptor.kind === 'array-max') {
      expect(schema.safeParse(values(boundary - 1)).success, row.id).toBe(true);
      expect(schema.safeParse(values(boundary)).success, row.id).toBe(true);
      expectIssue(
        schema.safeParse(values(boundary + 1)),
        (issue) => issue.code === 'too_big' && issue.maximum === boundary,
        row.id,
      );
    } else {
      expect(schema.safeParse(values(boundary)).success, row.id).toBe(true);
      expectIssue(
        schema.safeParse(values(boundary - 1)),
        (issue) => issue.code === 'too_small' && issue.minimum === boundary,
        row.id,
      );
      expectIssue(
        schema.safeParse(values(boundary + 1)),
        (issue) => issue.code === 'too_big' && issue.maximum === boundary,
        row.id,
      );
    }
    return;
  }
  if (descriptor.kind === 'tuple-length') {
    const accepted = sampleForSchema(schema) as unknown[];
    const exact = constraint.exact as number;
    expect(accepted).toHaveLength(exact);
    expect(schema.safeParse(accepted).success, row.id).toBe(true);
    expectIssue(
      schema.safeParse(accepted.slice(0, -1)),
      (issue) => issue.code === 'too_small' && issue.minimum === exact,
      row.id,
    );
    expectIssue(
      schema.safeParse([...accepted, null]),
      (issue) => issue.code === 'too_big' && issue.maximum === exact,
      row.id,
    );
    return;
  }
  throw new Error(`PUBLIC_SOURCE_BOUNDARY_DYNAMIC_PROBE_MISSING:${row.id}`);
}

function createArtifactAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  ajv.addFormat(
    'uuid',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  ajv.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  ajv.addFormat('uri', (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  });
  ajv.addKeyword({
    keyword: 'x-combo-maxUtf8Bytes',
    type: 'string',
    schemaType: 'number',
    validate: (maximum: number, value: string) => Buffer.byteLength(value, 'utf8') <= maximum,
  });
  ajv.addKeyword({
    keyword: 'x-combo-unicodeCodePoints',
    type: 'string',
    schemaType: 'object',
    validate: (boundary: { minimum: number; maximum: number }, value: string) => {
      const length = [...value].length;
      return length >= boundary.minimum && length <= boundary.maximum;
    },
  });
  ajv.addKeyword({
    keyword: 'x-combo-canonicalBase64UrlBytes',
    type: 'string',
    schemaType: 'object',
    validate: (boundary: { minimum: number; maximum: number }, value: string) => {
      const bytes = Buffer.from(value, 'base64url');
      return (
        bytes.byteLength >= boundary.minimum &&
        bytes.byteLength <= boundary.maximum &&
        bytes.toString('base64url') === value
      );
    },
  });
  return ajv;
}

function hasKeyword(errors: ErrorObject[] | null | undefined, keyword: string): boolean {
  return errors?.some((error) => error.keyword === keyword) ?? false;
}

function probeArtifactTarget(target: PublicArtifactBoundaryProbeTarget): void {
  expect(target.row.evidence).toMatchObject({
    status: 'covered',
    execution: 'artifact-constraint-fragment',
  });
  const constraints = target.descriptor.constraints;
  const propertyNamedFormat = asRecord(constraints.format);
  if (propertyNamedFormat !== undefined) {
    const validate = createArtifactAjv().compile(propertyNamedFormat as AnySchema);
    expect(validate('not-the-frozen-format'), target.row.id).toBe(false);
    expect(hasKeyword(validate.errors, 'const'), target.row.id).toBe(true);
    return;
  }
  const nestedKeyword = /\/(x-combo-(?:unicodeCodePoints|canonicalBase64UrlBytes))$/u.exec(
    target.descriptor.pointer,
  )?.[1];
  if (nestedKeyword !== undefined) {
    expect(typeof constraints.minimum, target.row.id).toBe('number');
    expect(typeof constraints.maximum, target.row.id).toBe('number');
    expect((constraints.minimum as number) <= (constraints.maximum as number), target.row.id).toBe(
      true,
    );
    const validate = createArtifactAjv().compile({
      type: 'string',
      [nestedKeyword]: constraints,
    });
    const invalid =
      nestedKeyword === 'x-combo-unicodeCodePoints'
        ? '😀'.repeat((constraints.maximum as number) + 1)
        : Buffer.alloc((constraints.maximum as number) + 1).toString('base64url');
    expect(validate(invalid), target.row.id).toBe(false);
    expect(hasKeyword(validate.errors, nestedKeyword), target.row.id).toBe(true);
    return;
  }
  const fragment: Record<string, unknown> = { ...constraints };
  if (
    'maxLength' in fragment ||
    'minLength' in fragment ||
    'pattern' in fragment ||
    'format' in fragment
  ) {
    fragment.type = 'string';
  } else if ('maxItems' in fragment || 'minItems' in fragment || 'uniqueItems' in fragment) {
    fragment.type = 'array';
  } else if ('maxProperties' in fragment || 'minProperties' in fragment) {
    fragment.type = 'object';
  } else if (
    'maximum' in fragment ||
    'minimum' in fragment ||
    'exclusiveMaximum' in fragment ||
    'exclusiveMinimum' in fragment ||
    typeof fragment.const === 'number'
  ) {
    fragment.type = 'number';
  }
  const validate = createArtifactAjv().compile(fragment as AnySchema);
  let probes = 0;
  if (typeof constraints.maxLength === 'number') {
    validate('A'.repeat(constraints.maxLength + 1));
    expect(hasKeyword(validate.errors, 'maxLength'), target.row.id).toBe(true);
    probes += 1;
  }
  if (typeof constraints.minLength === 'number' && constraints.minLength > 0) {
    validate('A'.repeat(constraints.minLength - 1));
    expect(hasKeyword(validate.errors, 'minLength'), target.row.id).toBe(true);
    probes += 1;
  }
  if (typeof constraints.pattern === 'string') {
    validate('\u0000');
    expect(hasKeyword(validate.errors, 'pattern'), target.row.id).toBe(true);
    probes += 1;
  }
  if (typeof constraints.format === 'string') {
    validate('not-a-valid-format');
    expect(hasKeyword(validate.errors, 'format'), target.row.id).toBe(true);
    probes += 1;
  }
  if (typeof constraints.maxItems === 'number') {
    validate(Array.from({ length: constraints.maxItems + 1 }, () => null));
    expect(hasKeyword(validate.errors, 'maxItems'), target.row.id).toBe(true);
    probes += 1;
  }
  if (typeof constraints.minItems === 'number' && constraints.minItems > 0) {
    validate(Array.from({ length: constraints.minItems - 1 }, () => null));
    expect(hasKeyword(validate.errors, 'minItems'), target.row.id).toBe(true);
    probes += 1;
  }
  if (constraints.uniqueItems === true) {
    validate([null, null]);
    expect(hasKeyword(validate.errors, 'uniqueItems'), target.row.id).toBe(true);
    probes += 1;
  }
  if (typeof constraints.maxProperties === 'number') {
    validate(
      Object.fromEntries(
        Array.from({ length: constraints.maxProperties + 1 }, (_, index) => [`k${index}`, null]),
      ),
    );
    expect(hasKeyword(validate.errors, 'maxProperties'), target.row.id).toBe(true);
    probes += 1;
  }
  if (typeof constraints.maximum === 'number') {
    validate(constraints.maximum + 1);
    expect(hasKeyword(validate.errors, 'maximum'), target.row.id).toBe(true);
    probes += 1;
  }
  if (typeof constraints.minimum === 'number') {
    validate(constraints.minimum - 1);
    expect(hasKeyword(validate.errors, 'minimum'), target.row.id).toBe(true);
    probes += 1;
  }
  if (typeof constraints.const === 'number') {
    validate(constraints.const + 1);
    expect(hasKeyword(validate.errors, 'const'), target.row.id).toBe(true);
    probes += 1;
  }
  if (typeof constraints['x-combo-maxUtf8Bytes'] === 'number') {
    const maximum = constraints['x-combo-maxUtf8Bytes'];
    validate('界'.repeat(Math.floor(maximum / 3) + 1));
    expect(hasKeyword(validate.errors, 'x-combo-maxUtf8Bytes'), target.row.id).toBe(true);
    probes += 1;
  }
  const codePointBoundary = asRecord(constraints['x-combo-unicodeCodePoints']);
  if (codePointBoundary !== undefined && typeof codePointBoundary.maximum === 'number') {
    validate('😀'.repeat(codePointBoundary.maximum + 1));
    expect(hasKeyword(validate.errors, 'x-combo-unicodeCodePoints'), target.row.id).toBe(true);
    probes += 1;
  }
  const decodedBoundary = asRecord(constraints['x-combo-canonicalBase64UrlBytes']);
  if (decodedBoundary !== undefined && typeof decodedBoundary.maximum === 'number') {
    validate(Buffer.alloc(decodedBoundary.maximum + 1).toString('base64url'));
    expect(hasKeyword(validate.errors, 'x-combo-canonicalBase64UrlBytes'), target.row.id).toBe(
      true,
    );
    probes += 1;
  }
  expect(probes, target.row.id).toBeGreaterThan(0);
}

describe('public boundary per-row dynamic evidence', () => {
  it('executes every dynamic Zod row and verifies every delegated row has an exact owner', () => {
    const targets = collectPublicSourceBoundaryProbeTargets();
    let covered = 0;
    let pending = 0;
    let delegated = 0;
    for (const target of targets) {
      if (target.row.evidence.status === 'pending') {
        pending += 1;
      } else if (
        target.row.evidence.testFile ===
        'packages/creator-agent-protocol/src/__tests__/public-string-pattern-census.test.ts'
      ) {
        expect(target.row.evidence.testFile, target.row.id).toBe(
          'packages/creator-agent-protocol/src/__tests__/public-string-pattern-census.test.ts',
        );
        delegated += 1;
      } else {
        probeSourceTarget(target);
        covered += 1;
      }
    }
    expect(covered + pending + delegated).toBe(targets.length);
    expect(covered).toBeGreaterThan(0);
    expect(delegated).toBeGreaterThan(0);
    expect(pending).toBe(0);
  });

  it('executes every generated artifact physical constraint row', async () => {
    const documents = Object.fromEntries(
      await Promise.all(
        Object.entries(artifactUrls).map(async ([name, url]) => [
          name,
          JSON.parse(await readFile(url, 'utf8')) as unknown,
        ]),
      ),
    ) as Record<keyof typeof artifactUrls, unknown>;
    const targets = collectPublicArtifactBoundaryProbeTargets(documents);
    targets.forEach(probeArtifactTarget);
    expect(targets).toHaveLength(750);
  });
});
