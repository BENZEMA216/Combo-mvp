import { z } from 'zod';

import { ContractSchemaDefinitions } from './artifacts.js';
import {
  UINT63_DECIMAL_PATTERN_SOURCE,
  UNICODE_SCALAR_NO_CONTROL_OPTIONAL_PATTERN_SOURCE,
  UNICODE_SCALAR_NO_CONTROL_PATTERN_SOURCE,
  UTF8_TEXT_OPTIONAL_PORTABLE_PATTERN_SOURCE,
  UTF8_TEXT_PORTABLE_PATTERN_SOURCE,
} from './primitives.js';

export const PUBLIC_STRING_PATTERN_CENSUS_PROTOCOL =
  'combo.public-string-pattern-census/1' as const;

export const PUBLIC_STRING_PATTERN_PROBE_IDS = Object.freeze([
  'pattern-accepted',
  'pattern-rejected',
  'boundary-n-minus-one',
  'boundary-n',
  'boundary-n-plus-one',
] as const);

export const PublicStringPatternFamilySchema = z.enum([
  'ascii-base64-sha256',
  'ascii-base64url',
  'ascii-bounded-token',
  'ascii-date',
  'ascii-digest',
  'ascii-identifier',
  'ascii-media-type',
  'ascii-protocol-id',
  'ascii-rfc3339-milliseconds',
  'ascii-uint63',
  'ascii-uuid-v4',
  'ascii-uuid-v7',
  'multiline-unicode-scalar',
  'strict-unicode-scalar',
  'strict-url',
]);
export type PublicStringPatternFamily = z.infer<typeof PublicStringPatternFamilySchema>;

const ProbeIdSchema = z.enum(PUBLIC_STRING_PATTERN_PROBE_IDS);

export const PublicStringPatternMachineRowSchema = z
  .object({
    id: z.string().min(1),
    root: z.string().min(1),
    pointer: z.string().startsWith('/'),
    checkIndex: z.number().int().nonnegative(),
    checkKind: z.enum(['regex', 'uuid', 'url', 'datetime', 'email']),
    family: PublicStringPatternFamilySchema,
    patternSource: z.string().nullable(),
    patternFlags: z.string(),
    probeIds: z.tuple([z.literal('pattern-accepted'), z.literal('pattern-rejected')]),
  })
  .strict();
export type PublicStringPatternMachineRow = z.infer<typeof PublicStringPatternMachineRowSchema>;

export const PublicStringLengthMachineRowSchema = z
  .object({
    id: z.string().min(1),
    root: z.string().min(1),
    pointer: z.string().startsWith('/'),
    checkIndex: z.number().int().nonnegative(),
    checkKind: z.enum(['max', 'length']),
    family: PublicStringPatternFamilySchema,
    mode: z.enum(['maximum', 'exact']),
    boundary: z.number().int().positive(),
    probeIds: z.tuple([
      z.literal('boundary-n-minus-one'),
      z.literal('boundary-n'),
      z.literal('boundary-n-plus-one'),
    ]),
  })
  .strict();
export type PublicStringLengthMachineRow = z.infer<typeof PublicStringLengthMachineRowSchema>;

export const PublicStringRuntimeProbeOutcomeSchema = z
  .object({
    rowId: z.string().min(1),
    probeId: ProbeIdSchema,
    expected: z.boolean(),
    accepted: z.boolean(),
    targetIssue: z.boolean(),
  })
  .strict();
export type PublicStringRuntimeProbeOutcome = z.infer<typeof PublicStringRuntimeProbeOutcomeSchema>;

type InternalDef = Record<string, unknown> & { typeName?: string };
type InternalSchema = z.ZodTypeAny & { _def: InternalDef };
type StringCheck = Readonly<{
  kind: string;
  value?: number;
  regex?: RegExp;
}>;
type StringOwner = Readonly<{
  root: string;
  pointer: string;
  schema: z.ZodString;
  checks: readonly StringCheck[];
}>;

type PatternSpec = Readonly<{
  family: PublicStringPatternFamily;
  accepted: string;
  rejected: string;
  repeatCharacter?: string;
}>;

const patternKey = (source: string, flags = '') => `${source}/${flags}`;

function patternSpec(
  regex: RegExp,
  family: PublicStringPatternFamily,
  accepted: string,
  rejected: string,
  repeatCharacter?: string,
): readonly [string, PatternSpec] {
  return [
    patternKey(regex.source, regex.flags),
    { family, accepted, rejected, ...(repeatCharacter === undefined ? {} : { repeatCharacter }) },
  ];
}

const UUID_V7 = '0198f00d-8000-7000-8000-000000000001';
const UUID_V4 = '550e8400-e29b-41d4-a716-446655440000';
const SHA64 = 'a'.repeat(64);

const PATTERN_SPECS = new Map<string, PatternSpec>([
  patternSpec(/^[a-f0-9]{64}$/, 'ascii-digest', SHA64, `g${'a'.repeat(63)}`),
  patternSpec(
    /^sha256:[a-f0-9]{64}$/,
    'ascii-digest',
    `sha256:${SHA64}`,
    `sha256:g${'a'.repeat(63)}`,
  ),
  patternSpec(
    /^hmac-sha256:[a-f0-9]{64}$/,
    'ascii-digest',
    `hmac-sha256:${SHA64}`,
    `hmac-sha256:g${'a'.repeat(63)}`,
  ),
  patternSpec(/^[a-f0-9]{40}$/u, 'ascii-digest', 'a'.repeat(40), `g${'a'.repeat(39)}`),
  patternSpec(
    new RegExp(UTF8_TEXT_PORTABLE_PATTERN_SOURCE, 'u'),
    'multiline-unicode-scalar',
    'safe\ntext',
    'safe\u0000text',
    'a',
  ),
  patternSpec(
    new RegExp(UTF8_TEXT_OPTIONAL_PORTABLE_PATTERN_SOURCE, 'u'),
    'multiline-unicode-scalar',
    '',
    'safe\u0000text',
    'a',
  ),
  patternSpec(
    new RegExp(UNICODE_SCALAR_NO_CONTROL_PATTERN_SOURCE, 'u'),
    'strict-unicode-scalar',
    '安全文本',
    'safe\u0000text',
    'a',
  ),
  patternSpec(
    new RegExp(UNICODE_SCALAR_NO_CONTROL_OPTIONAL_PATTERN_SOURCE, 'u'),
    'strict-unicode-scalar',
    '',
    'safe\u0000text',
    'a',
  ),
  patternSpec(/^[a-z]{2,3}(?:-[A-Z]{2})?$/u, 'ascii-identifier', 'zh-CN', 'ZH_cn'),
  patternSpec(
    /^(?:text\/[a-z0-9.+-]+|application\/(?:json|csv|javascript|xml|yaml|toml))(?:; charset=utf-8)?$/u,
    'ascii-media-type',
    'text/plain; charset=utf-8',
    'image/png',
  ),
  patternSpec(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    'ascii-uuid-v7',
    UUID_V7,
    UUID_V4,
  ),
  patternSpec(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    'ascii-uuid-v4',
    UUID_V4,
    UUID_V7,
  ),
  patternSpec(/^[a-z0-9][a-z0-9._:/-]{0,255}$/u, 'ascii-bounded-token', 'kms/key-1', 'KMS'),
  patternSpec(/^[a-z0-9][a-z0-9._:-]{2,127}$/u, 'ascii-bounded-token', 'key-id', 'KEY'),
  patternSpec(/^[A-Za-z0-9._:-]+$/u, 'ascii-bounded-token', 'runtime-1', 'runtime/1', 'A'),
  patternSpec(/^[A-Z][A-Z0-9_]{1,127}$/u, 'ascii-bounded-token', 'ERROR_CODE', 'error_code'),
  patternSpec(/^[A-Z][A-Z0-9_]{2,127}$/u, 'ascii-bounded-token', 'BLOCKED_CODE', 'blocked'),
  patternSpec(/^[A-Za-z0-9_-]+$/, 'ascii-base64url', 'AQ', 'A!', 'A'),
  patternSpec(
    /^[A-Za-z0-9+/]{43}=$/u,
    'ascii-base64-sha256',
    `${'A'.repeat(43)}=`,
    `${'A'.repeat(43)}-`,
  ),
  patternSpec(
    new RegExp(`^(?:${UINT63_DECIMAL_PATTERN_SOURCE})$`, 'u'),
    'ascii-uint63',
    '9223372036854775807',
    '9223372036854775808',
    '1',
  ),
  patternSpec(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    'ascii-rfc3339-milliseconds',
    '2026-08-13T08:00:00.000Z',
    '2026-08-13T08:00:00Z',
  ),
  patternSpec(
    /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/u,
    'ascii-bounded-token',
    'agent-1',
    'Agent-1',
    'a',
  ),
  patternSpec(
    new RegExp(`^"generation-(?:${UINT63_DECIMAL_PATTERN_SOURCE})"$`, 'u'),
    'ascii-uint63',
    '"generation-9223372036854775807"',
    '"generation-9223372036854775808"',
  ),
  patternSpec(/^[1-9][0-9]{0,7}$/u, 'ascii-bounded-token', '1', '0'),
  patternSpec(/^[a-z0-9][a-z0-9._-]{2,127}$/u, 'ascii-bounded-token', 'release-1', 'Release'),
  patternSpec(/^[a-z][a-z0-9-]{1,63}$/u, 'ascii-bounded-token', 'runtime-1', 'Runtime'),
  patternSpec(
    /^[A-Za-z0-9][A-Za-z0-9._+()-]{0,127}$/u,
    'ascii-bounded-token',
    'runtime-1',
    'runtime/1',
  ),
  patternSpec(
    /^[A-Za-z0-9][A-Za-z0-9._+()-]{0,255}$/u,
    'ascii-bounded-token',
    'runtime-1',
    'runtime/1',
  ),
  patternSpec(
    /^[A-Za-z0-9][A-Za-z0-9._+()-]{0,63}$/u,
    'ascii-bounded-token',
    'runtime-1',
    'runtime/1',
  ),
  patternSpec(
    /^(?:SCH|SNP|AVR|DEP|BRK|CJR|WJR|HST|RTP|ISO|CRD|CRT|CON|SEC|FLT|PER|K8S|BKP|OBS|E2E|AQL)-[A-Z0-9-]+$/u,
    'ascii-protocol-id',
    'SCH-005',
    'sch-005',
  ),
  patternSpec(/^INV-\d{3}$/u, 'ascii-protocol-id', 'INV-001', 'INV-1'),
  patternSpec(
    /^ADR-VNEXT-(?:00[1-9]|01\d|020)$/u,
    'ascii-protocol-id',
    'ADR-VNEXT-001',
    'ADR-VNEXT-021',
  ),
  patternSpec(
    /^ADR-VNEXT-(?:02[1-9]|03[0-2])$/u,
    'ascii-protocol-id',
    'ADR-VNEXT-021',
    'ADR-VNEXT-020',
  ),
  patternSpec(/^D(?:00[1-9]|01[0-2])$/u, 'ascii-protocol-id', 'D001', 'D013'),
  patternSpec(/^\d{4}-\d{2}-\d{2}$/u, 'ascii-date', '2026-08-18', '2026/08/18'),
  patternSpec(
    /^docs\/vnext\/adr\/ADR-VNEXT-\d{3}\.md$/u,
    'ascii-identifier',
    'docs/vnext/adr/ADR-VNEXT-034.md',
    '../ADR-VNEXT-034.md',
  ),
  patternSpec(
    /^(?:prompt|answer|context)\.[a-z0-9][a-z0-9._-]{2,255}$/u,
    'ascii-identifier',
    'answer.generated',
    'other.generated',
  ),
  patternSpec(/^[a-z][a-z0-9_.-]{0,127}$/u, 'ascii-identifier', 'runtime.table', 'Runtime'),
  patternSpec(/^[a-z][A-Za-z0-9_.[\]-]{0,255}$/u, 'ascii-identifier', 'field[0]', '/field'),
]);

const FORMAT_FAMILIES = Object.freeze({
  uuid: 'ascii-uuid-v7',
  url: 'strict-url',
  datetime: 'ascii-rfc3339-milliseconds',
  email: 'ascii-identifier',
} as const satisfies Record<'uuid' | 'url' | 'datetime' | 'email', PublicStringPatternFamily>);

const FORMAT_EXAMPLES = Object.freeze({
  uuid: { accepted: UUID_V7, rejected: 'not-a-uuid' },
  url: { accepted: 'https://uploads.example.invalid/object', rejected: 'not a url' },
  datetime: { accepted: '2026-08-13T08:00:00.000Z', rejected: '2026-13-13T08:00:00.000Z' },
  email: { accepted: 'test@example.invalid', rejected: 'not-an-email' },
} as const);

function asInternalSchema(value: unknown): InternalSchema | undefined {
  if (value === null || typeof value !== 'object' || !('_def' in value)) return undefined;
  return value as InternalSchema;
}

function pointerChild(pointer: string, segment: string | number): string {
  const escaped = String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
  return `${pointer}/${escaped}`;
}

function collectStringOwners(
  schema: z.ZodTypeAny,
  root: string,
  pointer: string,
  output: StringOwner[],
  stack: Set<z.ZodTypeAny>,
): void {
  if (stack.has(schema)) return;
  stack.add(schema);
  const definition = (schema as InternalSchema)._def;
  const nested = (value: unknown, childPointer = pointer) => {
    const child = asInternalSchema(value);
    if (child !== undefined) collectStringOwners(child, root, childPointer, output, stack);
  };
  switch (definition.typeName) {
    case 'ZodString':
      output.push({
        root,
        pointer: pointer || '/',
        schema: schema as z.ZodString,
        checks: (Array.isArray(definition.checks) ? definition.checks : []) as StringCheck[],
      });
      break;
    case 'ZodArray':
      nested(definition.type, pointerChild(pointer, 'items'));
      break;
    case 'ZodTuple': {
      const items = (Array.isArray(definition.items) ? definition.items : []) as unknown[];
      items.forEach((item, index) =>
        nested(item, pointerChild(pointerChild(pointer, 'items'), index)),
      );
      break;
    }
    case 'ZodObject': {
      const shape = typeof definition.shape === 'function' ? definition.shape() : definition.shape;
      if (shape !== null && typeof shape === 'object') {
        for (const [key, value] of Object.entries(shape as Record<string, unknown>)) {
          nested(value, pointerChild(pointer, key));
        }
      }
      break;
    }
    case 'ZodRecord':
      nested(definition.keyType, pointerChild(pointer, 'propertyNames'));
      nested(definition.valueType, pointerChild(pointer, 'additionalProperties'));
      break;
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = (Array.isArray(definition.options) ? definition.options : []) as unknown[];
      options.forEach((option, index) =>
        nested(option, pointerChild(pointerChild(pointer, 'anyOf'), index)),
      );
      break;
    }
    case 'ZodIntersection':
      nested(definition.left, pointerChild(pointer, 'left'));
      nested(definition.right, pointerChild(pointer, 'right'));
      break;
    case 'ZodEffects':
      nested(definition.schema);
      break;
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
    case 'ZodBranded':
      nested(definition.innerType ?? definition.type);
      break;
    case 'ZodPipeline':
      nested(definition.in, pointerChild(pointer, 'in'));
      nested(definition.out, pointerChild(pointer, 'out'));
      break;
    case 'ZodLazy':
      if (typeof definition.getter === 'function') nested(definition.getter());
      break;
    default:
      break;
  }
  stack.delete(schema);
}

function allStringOwners(): StringOwner[] {
  const output: StringOwner[] = [];
  for (const [root, schema] of Object.entries(ContractSchemaDefinitions)) {
    collectStringOwners(schema, root, '', output, new Set());
  }
  return output;
}

function specForOwner(owner: StringOwner): PatternSpec {
  if (owner.checks.some((check) => check.kind === 'url')) {
    return {
      family: 'strict-url',
      accepted: 'https://uploads.example.invalid/object',
      rejected: 'https://uploads.example.invalid/safe\u0000object',
    };
  }
  const regexCheck = owner.checks.find((check) => check.kind === 'regex');
  if (regexCheck?.regex instanceof RegExp) {
    const spec = PATTERN_SPECS.get(patternKey(regexCheck.regex.source, regexCheck.regex.flags));
    if (spec === undefined) {
      throw new TypeError(
        `PUBLIC_STRING_PATTERN_UNKNOWN:${owner.root}:${owner.pointer}:${regexCheck.regex.source}/${regexCheck.regex.flags}`,
      );
    }
    return spec;
  }
  const format = owner.checks.find((check) =>
    ['uuid', 'url', 'datetime', 'email'].includes(check.kind),
  )?.kind as keyof typeof FORMAT_FAMILIES | undefined;
  if (format !== undefined) {
    return {
      family: FORMAT_FAMILIES[format],
      ...FORMAT_EXAMPLES[format],
    };
  }
  throw new TypeError(`PUBLIC_STRING_PATTERN_OWNER_UNCLASSIFIED:${owner.root}:${owner.pointer}`);
}

function patternRowId(owner: StringOwner, kind: string, index: number): string {
  return `source:${owner.root}:${owner.pointer}:string-${kind}-${index}`;
}

export function collectPublicStringPatternRows(): PublicStringPatternMachineRow[] {
  const rows: PublicStringPatternMachineRow[] = [];
  for (const owner of allStringOwners()) {
    const spec = specForOwner(owner);
    owner.checks.forEach((check, checkIndex) => {
      if (check.kind !== 'regex' && !['uuid', 'url', 'datetime', 'email'].includes(check.kind)) {
        return;
      }
      rows.push(
        PublicStringPatternMachineRowSchema.parse({
          id: patternRowId(owner, check.kind, checkIndex),
          root: owner.root,
          pointer: owner.pointer,
          checkIndex,
          checkKind: check.kind,
          family:
            check.kind === 'regex' || check.kind === 'uuid'
              ? spec.family
              : FORMAT_FAMILIES[check.kind as keyof typeof FORMAT_FAMILIES],
          patternSource: check.regex?.source ?? null,
          patternFlags: check.regex?.flags ?? '',
          probeIds: ['pattern-accepted', 'pattern-rejected'],
        }),
      );
    });
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

function ownerLengthMode(owner: StringOwner): 'maximum' | 'exact' {
  const minimum = owner.checks.find((check) => check.kind === 'min')?.value;
  const maximum = owner.checks.find((check) => check.kind === 'max')?.value;
  return minimum !== undefined && minimum === maximum ? 'exact' : 'maximum';
}

export function collectPublicStringLengthRows(): PublicStringLengthMachineRow[] {
  const rows: PublicStringLengthMachineRow[] = [];
  for (const owner of allStringOwners()) {
    const spec = specForOwner(owner);
    owner.checks.forEach((check, checkIndex) => {
      if ((check.kind !== 'max' && check.kind !== 'length') || check.value === undefined) return;
      rows.push(
        PublicStringLengthMachineRowSchema.parse({
          id: patternRowId(owner, check.kind, checkIndex),
          root: owner.root,
          pointer: owner.pointer,
          checkIndex,
          checkKind: check.kind,
          family: spec.family,
          mode: check.kind === 'length' ? 'exact' : ownerLengthMode(owner),
          boundary: check.value,
          probeIds: ['boundary-n-minus-one', 'boundary-n', 'boundary-n-plus-one'],
        }),
      );
    });
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

function valueAtLength(owner: StringOwner, spec: PatternSpec, length: number): string {
  if (length < 0) return '';
  if (spec.family === 'ascii-uuid-v4') {
    const base = UUID_V4;
    return length <= base.length ? base.slice(0, length) : base + '0'.repeat(length - base.length);
  }
  if (spec.family === 'ascii-uuid-v7') {
    const base = UUID_V7;
    return length <= base.length ? base.slice(0, length) : base + '0'.repeat(length - base.length);
  }
  if (spec.family === 'ascii-uint63') {
    const etag = owner.checks.some(
      (check) => check.regex?.source.startsWith('^"generation-') === true,
    );
    if (etag) {
      const prefix = '"generation-';
      const suffix = '"';
      const digits = Math.max(0, length - prefix.length - suffix.length);
      return `${prefix}${'1'.repeat(digits)}${suffix}`;
    }
    return '1'.repeat(length);
  }
  if (spec.family === 'ascii-media-type') {
    const prefix = 'text/';
    return `${prefix}${'a'.repeat(Math.max(1, length - prefix.length))}`;
  }
  if (spec.family === 'ascii-bounded-token' && spec.accepted === 'agent-1') {
    return 'a'.repeat(length);
  }
  return (spec.repeatCharacter ?? 'A').repeat(length);
}

function acceptedForOwner(owner: StringOwner, spec: PatternSpec): string {
  const exact = owner.checks.find((check) => check.kind === 'length')?.value;
  const minimum = owner.checks.find((check) => check.kind === 'min')?.value;
  const target = exact ?? minimum;
  if (target !== undefined && spec.repeatCharacter !== undefined && spec.accepted.length < target) {
    return valueAtLength(owner, spec, target);
  }
  return spec.accepted;
}

function expectedTargetIssue(
  result: ReturnType<z.ZodString['safeParse']>,
  kind: string,
  exactSize = false,
): boolean {
  if (result.success) return false;
  return result.error.issues.some((issue) => {
    if (kind === 'regex') return issue.code === 'invalid_string' && issue.validation === 'regex';
    if (['uuid', 'url', 'datetime', 'email'].includes(kind)) {
      return issue.code === 'invalid_string' && issue.validation === kind;
    }
    if (kind === 'max') {
      return exactSize
        ? issue.code === 'too_small' || issue.code === 'too_big'
        : issue.code === 'too_big';
    }
    if (kind === 'length') return issue.code === 'too_small' || issue.code === 'too_big';
    return false;
  });
}

export function runPublicStringRuntimeProbes(): PublicStringRuntimeProbeOutcome[] {
  const outcomes: PublicStringRuntimeProbeOutcome[] = [];
  for (const owner of allStringOwners()) {
    const spec = specForOwner(owner);
    owner.checks.forEach((check, checkIndex) => {
      if (check.kind === 'regex' || ['uuid', 'url', 'datetime', 'email'].includes(check.kind)) {
        const rowId = patternRowId(owner, check.kind, checkIndex);
        const examples =
          check.kind === 'regex'
            ? { accepted: acceptedForOwner(owner, spec), rejected: spec.rejected }
            : check.kind === 'uuid'
              ? { accepted: acceptedForOwner(owner, spec), rejected: 'not-a-uuid' }
              : FORMAT_EXAMPLES[check.kind as keyof typeof FORMAT_EXAMPLES];
        for (const [probeId, value, expected] of [
          ['pattern-accepted', examples.accepted, true],
          ['pattern-rejected', examples.rejected, false],
        ] as const) {
          const result = owner.schema.safeParse(value);
          outcomes.push(
            PublicStringRuntimeProbeOutcomeSchema.parse({
              rowId,
              probeId,
              expected,
              accepted: result.success,
              targetIssue: expected || expectedTargetIssue(result, check.kind),
            }),
          );
        }
      }
      if ((check.kind === 'max' || check.kind === 'length') && check.value !== undefined) {
        const rowId = patternRowId(owner, check.kind, checkIndex);
        const mode = check.kind === 'length' ? 'exact' : ownerLengthMode(owner);
        for (const [probeId, delta] of [
          ['boundary-n-minus-one', -1],
          ['boundary-n', 0],
          ['boundary-n-plus-one', 1],
        ] as const) {
          const expected = delta === 0 || (delta < 0 && mode === 'maximum');
          const result = owner.schema.safeParse(valueAtLength(owner, spec, check.value + delta));
          outcomes.push(
            PublicStringRuntimeProbeOutcomeSchema.parse({
              rowId,
              probeId,
              expected,
              accepted: result.success,
              targetIssue: expected || expectedTargetIssue(result, check.kind, mode === 'exact'),
            }),
          );
        }
      }
    });
  }
  return outcomes.sort((left, right) =>
    `${left.rowId}:${left.probeId}`.localeCompare(`${right.rowId}:${right.probeId}`),
  );
}

export const PUBLIC_STRING_PATTERN_CENSUS_EXCLUSIONS = Object.freeze([
  'cross-field-super-refine-is-outside-string-leaf-census',
  'decoded-byte-refinements-remain-delegated-to-decoded-boundary-corpus',
] as const);
