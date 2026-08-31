import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { z } from 'zod';

import {
  verifyCreatorAgentPackageManifest,
  type CreatorAgentPackageFile,
  type CreatorAgentPackageManifest,
} from './agent-package.js';
import { canonicalizeJson } from './canonical.js';
import { Sha256DigestSchema, containsUnsafeAgentText, type Sha256Digest } from './primitives.js';

export const CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL = 'combo.knowledge-bundle/1' as const;
export const CREATOR_KNOWLEDGE_SKILL_PATH = 'skills/knowledge/SKILL.md' as const;
export const CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH =
  'skills/knowledge/references/knowledge-bundle.json' as const;
export const CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES = 2 * 1_024 * 1_024;
export const CREATOR_KNOWLEDGE_BUNDLE_MAX_CHUNKS = 500;
export const CREATOR_KNOWLEDGE_CHUNK_MAX_BYTES = 32 * 1_024;

const CHUNK_ID_PATTERN = /^chunk\.knowledge\.[0-9a-f]{32}$/u;
const SOURCE_ID_PATTERN = /^source\.knowledge\.[0-9a-f]{32}$/u;
const CITATION_LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _()（）·，。、-]{0,119}$/u;
const KNOWLEDGE_AGENT_PACKAGE_PATHS = [
  'AGENT.md',
  CREATOR_KNOWLEDGE_SKILL_PATH,
  CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
] as const;
const MAX_JSON_NODES = 4_096;
const MAX_JSON_DEPTH = 8;

const CreatorKnowledgeSourceSchema = z
  .object({
    sourceId: z.string().regex(SOURCE_ID_PATTERN),
    displayLabel: z
      .string()
      .regex(CITATION_LABEL_PATTERN)
      .refine((value) => value.normalize('NFC') === value, 'Citation label must use NFC')
      .refine(
        (value) => value.trim() === value && !/ {2,}/u.test(value),
        'Citation label whitespace must be canonical',
      )
      .refine((value) => !containsUnsafeAgentText(value), 'Citation label is malformed or unsafe'),
  })
  .strict()
  .readonly();

const CreatorKnowledgeChunkSchema = z
  .object({
    id: z.string().regex(CHUNK_ID_PATTERN),
    source: CreatorKnowledgeSourceSchema,
    content: z
      .string()
      .min(1)
      .max(CREATOR_KNOWLEDGE_CHUNK_MAX_BYTES)
      .refine((value) => value.normalize('NFC') === value, 'Knowledge content must use NFC')
      .refine(
        (value) => !containsUnsafeAgentText(value),
        'Knowledge content is malformed or unsafe',
      )
      .refine(
        (value) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(value),
        'Knowledge content must contain visible evidence',
      )
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= CREATOR_KNOWLEDGE_CHUNK_MAX_BYTES,
        'Knowledge content exceeds the UTF-8 byte limit',
      ),
    contentDigest: Sha256DigestSchema,
  })
  .strict()
  .superRefine((chunk, context) => {
    if (rawDigest(Buffer.from(chunk.content, 'utf8')) !== chunk.contentDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentDigest'],
        message: 'Knowledge content digest does not match the exact UTF-8 bytes',
      });
    }
  })
  .readonly();

const CreatorKnowledgeBundleSchema = z
  .object({
    protocol: z.literal(CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL),
    chunks: z
      .array(CreatorKnowledgeChunkSchema)
      .min(1)
      .max(CREATOR_KNOWLEDGE_BUNDLE_MAX_CHUNKS)
      .readonly(),
  })
  .strict()
  .superRefine((bundle, context) => {
    const sourceLabels = new Map<string, string>();
    for (const [index, chunk] of bundle.chunks.entries()) {
      const existingLabel = sourceLabels.get(chunk.source.sourceId);
      if (existingLabel !== undefined && existingLabel !== chunk.source.displayLabel) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['chunks', index, 'source', 'displayLabel'],
          message: 'Knowledge source ID must map to one exact citation label',
        });
      } else {
        sourceLabels.set(chunk.source.sourceId, chunk.source.displayLabel);
      }
    }
    for (let index = 1; index < bundle.chunks.length; index += 1) {
      if (bundle.chunks[index - 1]!.id >= bundle.chunks[index]!.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['chunks', index, 'id'],
          message: 'Knowledge chunk IDs must be unique and in ascending order',
        });
      }
    }
  })
  .readonly();

export type CreatorKnowledgeBundle = z.infer<typeof CreatorKnowledgeBundleSchema>;
export type CreatorKnowledgeChunk = z.infer<typeof CreatorKnowledgeChunkSchema>;

export function createCreatorKnowledgeBundle(input: unknown): CreatorKnowledgeBundle {
  return verifyCreatorKnowledgeBundle(input);
}

export function verifyCreatorKnowledgeBundle(input: unknown): CreatorKnowledgeBundle {
  const snapshot = snapshotJson(input, 0, { nodes: 0, bytes: 0 });
  const before = canonicalizeJson(snapshot);
  if (Buffer.byteLength(before, 'utf8') > CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES) {
    throw new TypeError('Knowledge Bundle exceeds the canonical byte limit');
  }
  const bundle = CreatorKnowledgeBundleSchema.parse(snapshot);
  if (canonicalizeJson(bundle) !== before) {
    throw new TypeError('Knowledge Bundle changed during schema parsing');
  }
  return deepFreeze(bundle);
}

export function serializeCreatorKnowledgeBundle(input: unknown): string {
  return canonicalizeJson(verifyCreatorKnowledgeBundle(input));
}

export function parseCreatorKnowledgeBundle(text: string): CreatorKnowledgeBundle {
  if (typeof text !== 'string') throw new TypeError('Knowledge Bundle must be JSON text');
  if (
    text.length > CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES ||
    Buffer.byteLength(text, 'utf8') > CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES
  ) {
    throw new TypeError('Knowledge Bundle exceeds the canonical byte limit');
  }
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('Knowledge Bundle is not valid JSON');
  }
  const bundle = verifyCreatorKnowledgeBundle(input);
  if (canonicalizeJson(bundle) !== text) {
    throw new TypeError('Knowledge Bundle is not exact canonical JSON');
  }
  return bundle;
}

export function digestCreatorKnowledgeBundle(input: unknown): Sha256Digest {
  return rawDigest(Buffer.from(serializeCreatorKnowledgeBundle(input), 'utf8'));
}

/**
 * Resolves the only knowledge selector allowed by V1: a fixed file inventoried by the exact Package.
 * The caller must still read those exact bytes and compare both byteLength and digest before parsing.
 */
export function resolveCreatorKnowledgeBundleResource(input: unknown): Readonly<{
  manifest: CreatorAgentPackageManifest;
  resource: CreatorAgentPackageFile;
}> {
  const manifest = verifyCreatorAgentPackageManifest(input);
  if (manifest.skills.length !== 1 || manifest.skills[0] !== CREATOR_KNOWLEDGE_SKILL_PATH) {
    throw new TypeError('Knowledge Agent Package must declare the fixed knowledge Skill');
  }
  if (
    manifest.files.length !== KNOWLEDGE_AGENT_PACKAGE_PATHS.length ||
    manifest.files.some(
      (candidate, index) => candidate.path !== KNOWLEDGE_AGENT_PACKAGE_PATHS[index],
    )
  ) {
    throw new TypeError('Knowledge Agent Package must contain only the fixed Test profile files');
  }
  const resource = manifest.files.find(
    (candidate) => candidate.path === CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
  );
  if (resource === undefined) {
    throw new TypeError('Knowledge Agent Package must inventory the fixed Knowledge Bundle');
  }
  return Object.freeze({ manifest, resource });
}

function snapshotJson(
  input: unknown,
  depth: number,
  budget: { nodes: number; bytes: number },
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new TypeError('Knowledge Bundle exceeds the canonical complexity limit');
  }
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError('Knowledge Bundle is not canonical JSON');
    return input;
  }
  if (typeof input === 'string') {
    budget.bytes += Buffer.byteLength(input, 'utf8');
    if (budget.bytes > CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES || containsUnsafeAgentText(input)) {
      throw new TypeError('Knowledge Bundle exceeds the canonical byte limit');
    }
    return input;
  }
  if (typeof input !== 'object' || isProxy(input)) {
    throw new TypeError('Knowledge Bundle must contain only plain JSON values');
  }
  if (Array.isArray(input)) {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
    if (
      keys.length !== input.length ||
      keys.some((key, index) => typeof key !== 'string' || key !== String(index))
    ) {
      throw new TypeError('Knowledge Bundle must contain only dense arrays');
    }
    return keys.map((key) => {
      const descriptor = descriptors[key as string];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Knowledge Bundle properties must be enumerable data properties');
      }
      return snapshotJson(descriptor.value, depth + 1, budget);
    });
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Knowledge Bundle must contain only plain JSON objects');
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (
      typeof key !== 'string' ||
      key === '__proto__' ||
      key === 'prototype' ||
      key === 'constructor'
    ) {
      throw new TypeError('Knowledge Bundle contains an unsafe property');
    }
    budget.bytes += Buffer.byteLength(key, 'utf8');
    if (budget.bytes > CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES) {
      throw new TypeError('Knowledge Bundle exceeds the canonical byte limit');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Knowledge Bundle properties must be enumerable data properties');
    }
    output[key] = snapshotJson(descriptor.value, depth + 1, budget);
  }
  return output;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    if (!Object.isFrozen(value)) Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function rawDigest(bytes: Uint8Array): Sha256Digest {
  return Sha256DigestSchema.parse(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}
