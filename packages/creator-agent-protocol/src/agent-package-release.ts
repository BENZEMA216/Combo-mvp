import { isProxy } from 'node:util/types';

import { z } from 'zod';

import { canonicalizeJson } from './canonical.js';
import { Sha256DigestSchema } from './primitives.js';

export const CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL = 'combo.agent-package-release/1' as const;
export const CREATOR_AGENT_PACKAGE_RELEASE_MAX_BYTES = 512;

const RELEASE_ID_PATTERN = /^release\.agent-package\.[0-9a-f]{32}$/u;
const RELEASE_KEYS = ['packageDigest', 'protocol', 'releaseId'] as const;
const RELEASE_KEY_SET = new Set<string>(RELEASE_KEYS);

export const CreatorAgentPackageReleaseIdSchema = z
  .string()
  .regex(RELEASE_ID_PATTERN)
  .brand<'CreatorAgentPackageReleaseId'>();
export type CreatorAgentPackageReleaseId = z.infer<typeof CreatorAgentPackageReleaseIdSchema>;

const CreatorAgentPackageReleaseSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL),
    releaseId: CreatorAgentPackageReleaseIdSchema,
    packageDigest: Sha256DigestSchema,
  })
  .strict()
  .readonly();
export type CreatorAgentPackageRelease = z.infer<typeof CreatorAgentPackageReleaseSchema>;

export function createCreatorAgentPackageRelease(input: unknown): CreatorAgentPackageRelease {
  return verifyCreatorAgentPackageRelease(input);
}

export function verifyCreatorAgentPackageRelease(input: unknown): CreatorAgentPackageRelease {
  const snapshot = snapshotRelease(input);
  const before = canonicalizeJson(snapshot);
  if (Buffer.byteLength(before, 'utf8') > CREATOR_AGENT_PACKAGE_RELEASE_MAX_BYTES) {
    throw new TypeError('Agent Package Release exceeds the canonical byte limit');
  }
  const release = CreatorAgentPackageReleaseSchema.parse(snapshot);
  if (canonicalizeJson(release) !== before) {
    throw new TypeError('Agent Package Release changed during schema parsing');
  }
  return release;
}

export function serializeCreatorAgentPackageRelease(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageRelease(input));
}

export function parseCreatorAgentPackageRelease(text: string): CreatorAgentPackageRelease {
  if (typeof text !== 'string') {
    throw new TypeError('Agent Package Release must be JSON text');
  }
  if (
    text.length > CREATOR_AGENT_PACKAGE_RELEASE_MAX_BYTES ||
    Buffer.byteLength(text, 'utf8') > CREATOR_AGENT_PACKAGE_RELEASE_MAX_BYTES
  ) {
    throw new TypeError('Agent Package Release exceeds the canonical byte limit');
  }

  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('Agent Package Release is not valid JSON');
  }
  const release = verifyCreatorAgentPackageRelease(input);
  if (canonicalizeJson(release) !== text) {
    throw new TypeError('Agent Package Release is not exact canonical JSON');
  }
  return release;
}

function snapshotRelease(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) {
    throw new TypeError('Agent Package Release must be a plain JSON object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Agent Package Release must be a plain JSON object');
  }

  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== RELEASE_KEYS.length ||
    keys.some((key) => typeof key !== 'string' || !RELEASE_KEY_SET.has(key))
  ) {
    throw new TypeError('Agent Package Release must contain only exact protocol fields');
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let valueBytes = 0;
  for (const key of RELEASE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Agent Package Release fields must be enumerable data properties');
    }
    if (typeof descriptor.value !== 'string') {
      throw new TypeError('Agent Package Release fields must contain string data');
    }
    if (descriptor.value.length > CREATOR_AGENT_PACKAGE_RELEASE_MAX_BYTES) {
      throw new TypeError('Agent Package Release exceeds the canonical byte limit');
    }
    valueBytes += Buffer.byteLength(descriptor.value, 'utf8');
    if (valueBytes > CREATOR_AGENT_PACKAGE_RELEASE_MAX_BYTES) {
      throw new TypeError('Agent Package Release exceeds the canonical byte limit');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
