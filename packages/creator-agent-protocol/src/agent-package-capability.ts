import { isProxy } from 'node:util/types';

import { canonicalizeJson } from './canonical.js';
import {
  verifyCreatorAgentPackageRelease,
  type CreatorAgentPackageRelease,
} from './agent-package-release.js';

export const CREATOR_AGENT_PACKAGE_CAPABILITY_PROTOCOL =
  'combo.agent-package-capability/2' as const;
export const CREATOR_AGENT_PACKAGE_CAPABILITY_VERSION = 2 as const;
export const CREATOR_AGENT_PACKAGE_CAPABILITY_MAX_BYTES = 1_024;

const CAPABILITY_KEYS = ['protocol', 'release', 'version'] as const;
const CAPABILITY_KEY_SET = new Set<string>(CAPABILITY_KEYS);

/**
 * Migration-only projection from the legacy Capability index to one exact Agent Package Release.
 * It intentionally contains no copied Package behavior, knowledge bytes, prompts, tools, or price.
 */
export type CreatorAgentPackageCapability = Readonly<{
  version: typeof CREATOR_AGENT_PACKAGE_CAPABILITY_VERSION;
  protocol: typeof CREATOR_AGENT_PACKAGE_CAPABILITY_PROTOCOL;
  release: CreatorAgentPackageRelease;
}>;

export function createCreatorAgentPackageCapability(input: unknown): CreatorAgentPackageCapability {
  return verifyCreatorAgentPackageCapability(input);
}

export function verifyCreatorAgentPackageCapability(input: unknown): CreatorAgentPackageCapability {
  const snapshot = snapshotCapability(input);
  const canonical = canonicalizeJson(snapshot);
  if (Buffer.byteLength(canonical, 'utf8') > CREATOR_AGENT_PACKAGE_CAPABILITY_MAX_BYTES) {
    throw new TypeError('Agent Package Capability exceeds the canonical byte limit');
  }
  return Object.freeze(snapshot);
}

export function serializeCreatorAgentPackageCapability(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageCapability(input));
}

export function parseCreatorAgentPackageCapability(text: string): CreatorAgentPackageCapability {
  if (typeof text !== 'string') {
    throw new TypeError('Agent Package Capability must be JSON text');
  }
  if (
    text.length > CREATOR_AGENT_PACKAGE_CAPABILITY_MAX_BYTES ||
    Buffer.byteLength(text, 'utf8') > CREATOR_AGENT_PACKAGE_CAPABILITY_MAX_BYTES
  ) {
    throw new TypeError('Agent Package Capability exceeds the canonical byte limit');
  }

  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('Agent Package Capability is not valid JSON');
  }
  const capability = verifyCreatorAgentPackageCapability(input);
  if (canonicalizeJson(capability) !== text) {
    throw new TypeError('Agent Package Capability is not exact canonical JSON');
  }
  return capability;
}

function snapshotCapability(input: unknown): {
  version: typeof CREATOR_AGENT_PACKAGE_CAPABILITY_VERSION;
  protocol: typeof CREATOR_AGENT_PACKAGE_CAPABILITY_PROTOCOL;
  release: CreatorAgentPackageRelease;
} {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) {
    throw new TypeError('Agent Package Capability must be a plain JSON object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Agent Package Capability must be a plain JSON object');
  }

  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== CAPABILITY_KEYS.length ||
    keys.some((key) => typeof key !== 'string' || !CAPABILITY_KEY_SET.has(key))
  ) {
    throw new TypeError('Agent Package Capability must contain only exact projection fields');
  }

  const protocol = dataProperty(input, 'protocol');
  const release = dataProperty(input, 'release');
  const version = dataProperty(input, 'version');
  if (protocol !== CREATOR_AGENT_PACKAGE_CAPABILITY_PROTOCOL) {
    throw new TypeError('Agent Package Capability protocol is unsupported');
  }
  if (version !== CREATOR_AGENT_PACKAGE_CAPABILITY_VERSION) {
    throw new TypeError('Agent Package Capability version is unsupported');
  }

  return {
    version: CREATOR_AGENT_PACKAGE_CAPABILITY_VERSION,
    protocol: CREATOR_AGENT_PACKAGE_CAPABILITY_PROTOCOL,
    release: verifyCreatorAgentPackageRelease(release),
  };
}

function dataProperty(input: object, key: (typeof CAPABILITY_KEYS)[number]): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError('Agent Package Capability fields must be enumerable data properties');
  }
  return descriptor.value;
}
