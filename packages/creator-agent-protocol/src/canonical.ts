import { createHash } from 'node:crypto';

import { Sha256DigestSchema, containsLoneSurrogate, type Sha256Digest } from './primitives.js';

export type CanonicalJson = null | boolean | number | string | CanonicalJson[] | CanonicalObject;
export type CanonicalObject = { [key: string]: CanonicalJson };

const CANONICAL_JSON_IMPLEMENTATION = 'combo-rfc8785-jcs/1' as const;

/**
 * Serializes one in-memory JSON value using RFC 8785 ordering and ECMAScript number encoding.
 * Values that JSON.stringify would silently erase or invoke are rejected instead.
 */
export function canonicalizeJson(value: unknown): string {
  return serialize(value, '$', new Set<object>());
}

export function canonicalFingerprint(domain: string, value: unknown): Sha256Digest {
  if (!/^[a-z0-9:./-]{1,128}$/u.test(domain)) {
    throw new TypeError('canonical fingerprint domain must be stable lowercase ASCII');
  }
  const bytes = canonicalizeJson({ domain, implementation: CANONICAL_JSON_IMPLEMENTATION, value });
  const digest = createHash('sha256').update(bytes, 'utf8').digest('hex');
  return Sha256DigestSchema.parse(`sha256:${digest}`);
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (containsLoneSurrogate(value)) throw new TypeError(`${path} contains a lone surrogate`);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError(`${path} is not a JSON value`);
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, path, ancestors)
      : serializeObject(value, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(value: unknown[], path: string, ancestors: Set<object>): string {
  const ownKeys = Reflect.ownKeys(value).filter((key) => key !== 'length');
  if (
    ownKeys.length !== value.length ||
    ownKeys.some((key, index) => typeof key !== 'string' || key !== String(index))
  ) {
    throw new TypeError(`${path} must be a dense JSON array without extra properties`);
  }

  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${path}[${index}] must be an enumerable data property`);
    }
    items.push(serialize(descriptor.value, `${path}[${index}]`, ancestors));
  }
  return `[${items.join(',')}]`;
}

function serializeObject(value: object, path: string, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain JSON object`);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError(`${path} contains a symbol key`);
  }
  const keys = ownKeys as string[];
  for (const key of keys) {
    if (containsLoneSurrogate(key)) throw new TypeError(`${path} contains a malformed key`);
  }
  keys.sort();

  const fields: string[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${path}.${key} must be an enumerable data property`);
    }
    fields.push(
      `${JSON.stringify(key)}:${serialize(descriptor.value, `${path}.${key}`, ancestors)}`,
    );
  }
  return `{${fields.join(',')}}`;
}
