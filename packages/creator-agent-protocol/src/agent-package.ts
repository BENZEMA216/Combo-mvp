import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { z } from 'zod';

import { canonicalizeJson } from './canonical.js';
import { Sha256DigestSchema, containsLoneSurrogate, type Sha256Digest } from './primitives.js';

export const CREATOR_AGENT_PACKAGE_PROTOCOL = 'combo.agent-package/1' as const;
export const CREATOR_AGENT_PACKAGE_FILENAME = 'agent.json' as const;
export const CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES = 65_536;
export type CreatorAgentPackageDigest = Sha256Digest;

const AGENT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,79}$/u;
const SKILL_PATH_PATTERN = /^skills\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/SKILL\.md$/u;
const PACKAGE_FILE_PATH_PATTERN =
  /^(?:AGENT\.md|skills\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,79})+)$/u;
const MAX_PACKAGE_BYTES = 8 * 1_024 * 1_024;

const SafeLine = (minimum: number, maximum: number) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) =>
        !containsLoneSurrogate(value) &&
        !/[\0\r\n\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value),
      'Agent Package text is malformed or unsafe',
    );

const AgentPackageResourceSchema = z
  .object({
    path: z.string().max(240).regex(PACKAGE_FILE_PATH_PATTERN),
    byteLength: z
      .number()
      .int()
      .min(1)
      .max(2 * 1_024 * 1_024),
    digest: Sha256DigestSchema,
  })
  .strict()
  .readonly();

export type CreatorAgentPackageFile = z.infer<typeof AgentPackageResourceSchema>;

export const CreatorAgentPackageManifestSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_PROTOCOL),
    name: z.string().regex(AGENT_NAME_PATTERN),
    description: SafeLine(1, 500),
    instructions: z.literal('AGENT.md'),
    skills: z.array(z.string().regex(SKILL_PATH_PATTERN)).max(1).readonly(),
    files: z.array(AgentPackageResourceSchema).min(1).max(256).readonly(),
  })
  .strict()
  .superRefine((manifest, context) => {
    requireAscendingUnique(manifest.skills, ['skills'], context);
    requireAscendingUnique(
      manifest.files.map((file) => file.path),
      ['files'],
      context,
    );
    const files = new Map(manifest.files.map((file) => [file.path, file]));
    const foldedPaths = new Set<string>();
    for (const [index, file] of manifest.files.entries()) {
      const folded = file.path.toLowerCase();
      if (foldedPaths.has(folded)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'Agent Package paths collide under case folding',
        });
      }
      foldedPaths.add(folded);
      for (const [otherIndex, other] of manifest.files.entries()) {
        if (otherIndex === index) continue;
        const otherFolded = other.path.toLowerCase();
        if (otherFolded.startsWith(`${folded}/`)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['files', otherIndex, 'path'],
            message: 'Agent Package file paths cannot be ancestors of other files',
          });
        }
      }
    }
    const instructions = files.get(manifest.instructions);
    if (instructions === undefined || instructions.byteLength > 65_536) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instructions'],
        message: 'Agent Package must inventory a bounded AGENT.md',
      });
    }
    const skillRoots = new Set<string>();
    for (const [index, path] of manifest.skills.entries()) {
      const skillName = path.split('/')[1] ?? '';
      const file = files.get(path);
      if (file === undefined || file.byteLength > 65_536 || skillName.includes('--')) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['skills', index],
          message: 'Agent Package must inventory every bounded SKILL.md',
        });
      }
      skillRoots.add(path.slice(0, -'/SKILL.md'.length));
    }
    for (const [index, file] of manifest.files.entries()) {
      if (
        file.path !== 'AGENT.md' &&
        ![...skillRoots].some((root) => file.path.startsWith(`${root}/`))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'Agent Package file is outside a declared Skill directory',
        });
      }
      if (file.path.endsWith('/SKILL.md') && !manifest.skills.includes(file.path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'Agent Package contains an undeclared Skill entry',
        });
      }
    }
    if (manifest.files.reduce((total, file) => total + file.byteLength, 0) > MAX_PACKAGE_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: 'Agent Package exceeds the total byte limit',
      });
    }
  })
  .readonly();
export type CreatorAgentPackageManifest = z.infer<typeof CreatorAgentPackageManifestSchema>;

export function createCreatorAgentPackageManifest(input: unknown): CreatorAgentPackageManifest {
  return exactDetached(CreatorAgentPackageManifestSchema, input, 'Agent Package manifest');
}

export function verifyCreatorAgentPackageManifest(input: unknown): CreatorAgentPackageManifest {
  return exactDetached(CreatorAgentPackageManifestSchema, input, 'Agent Package manifest');
}

export function digestCreatorAgentPackage(input: unknown): CreatorAgentPackageDigest {
  const bytes = serializeCreatorAgentPackageManifest(input);
  return rawDigest(Buffer.from(bytes, 'utf8'));
}

export function digestCreatorAgentPackageFile(bytes: Uint8Array): Sha256Digest {
  if (!(bytes instanceof Uint8Array) || isProxy(bytes)) {
    throw new TypeError('Agent Package file bytes must be a Uint8Array');
  }
  return rawDigest(bytes);
}

function requireAscendingUnique(
  values: readonly string[],
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: 'Agent Package paths must be unique and in ascending order',
      });
    }
  }
}

export function serializeCreatorAgentPackageManifest(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageManifest(input));
}

export function parseCreatorAgentPackageManifest(text: string): CreatorAgentPackageManifest {
  if (typeof text !== 'string') throw new TypeError('Agent Package manifest must be JSON text');
  if (Buffer.byteLength(text, 'utf8') > CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES) {
    throw new TypeError('Agent Package manifest exceeds the canonical byte limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('Agent Package manifest is not valid JSON');
  }
  const manifest = verifyCreatorAgentPackageManifest(value);
  if (canonicalizeJson(manifest) !== text) {
    throw new TypeError('Agent Package manifest is not exact canonical JSON');
  }
  return manifest;
}

function exactDetached<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
  label: string,
): z.output<Schema> {
  const budget = { nodes: 0, bytes: 0 };
  const snapshot = snapshotJson(input, 0, budget);
  const before = canonicalizeJson(snapshot);
  if (Buffer.byteLength(before, 'utf8') > CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES) {
    throw new TypeError('Agent Package value exceeds the canonical byte limit');
  }
  const parsed = schema.parse(snapshot);
  if (canonicalizeJson(parsed) !== before) {
    throw new TypeError(`${label} changed during schema parsing`);
  }
  deepFreeze(parsed);
  return parsed;
}

function snapshotJson(
  input: unknown,
  depth: number,
  budget: { nodes: number; bytes: number },
): unknown {
  budget.nodes += 1;
  if (budget.nodes > 2_048 || depth > 16) {
    throw new TypeError('Agent Package value exceeds the canonical complexity limit');
  }
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError('Agent Package value is not canonical JSON');
    return input;
  }
  if (typeof input === 'string') {
    budget.bytes += Buffer.byteLength(input, 'utf8');
    if (budget.bytes > CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES || containsLoneSurrogate(input)) {
      throw new TypeError('Agent Package value exceeds the canonical byte limit');
    }
    return input;
  }
  if (typeof input !== 'object' || isProxy(input)) {
    throw new TypeError('Agent Package value must contain only plain JSON values');
  }
  if (Array.isArray(input)) {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
    if (
      keys.length !== input.length ||
      keys.some((key, index) => typeof key !== 'string' || key !== String(index))
    ) {
      throw new TypeError('Agent Package value must contain only dense arrays');
    }
    return keys.map((key) => {
      const descriptor = descriptors[key as string];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Agent Package properties must be enumerable data properties');
      }
      return snapshotJson(descriptor.value, depth + 1, budget);
    });
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Agent Package value must contain only plain JSON objects');
  }
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (
      typeof key !== 'string' ||
      key === '__proto__' ||
      key === 'prototype' ||
      key === 'constructor'
    ) {
      throw new TypeError('Agent Package value contains an unsafe property');
    }
    budget.bytes += Buffer.byteLength(key, 'utf8');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Agent Package properties must be enumerable data properties');
    }
    output[key] = snapshotJson(descriptor.value, depth + 1, budget);
  }
  return output;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (!Object.isFrozen(value)) Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

function rawDigest(bytes: Uint8Array): Sha256Digest {
  return Sha256DigestSchema.parse(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}
