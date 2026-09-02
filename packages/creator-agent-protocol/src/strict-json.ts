import { isProxy } from 'node:util/types';

import { containsLoneSurrogate } from './primitives.js';

export type StrictJsonSnapshotOptions = Readonly<{
  maximumBytes: number;
  maximumNodes?: number;
  maximumDepth?: number;
  label: string;
}>;

/** Snapshot hostile unknown input without invoking accessors or Proxy traps. */
export function snapshotStrictJson(input: unknown, options: StrictJsonSnapshotOptions): unknown {
  const budget = { nodes: 0, bytes: 0 };
  return snapshot(input, 0, new Set<object>(), budget, {
    maximumNodes: options.maximumNodes ?? 2_048,
    maximumDepth: options.maximumDepth ?? 16,
    ...options,
  });
}

export function deepFreezeStrictJson<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreezeStrictJson(descriptor.value);
  }
  Object.freeze(value);
  return value;
}

function snapshot(
  input: unknown,
  depth: number,
  ancestors: Set<object>,
  budget: { nodes: number; bytes: number },
  options: Required<Omit<StrictJsonSnapshotOptions, 'label'>> &
    Pick<StrictJsonSnapshotOptions, 'label'>,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > options.maximumNodes || depth > options.maximumDepth) {
    throw new TypeError(`${options.label} exceeds the canonical complexity limit`);
  }
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input))
      throw new TypeError(`${options.label} contains a non-finite number`);
    return input;
  }
  if (typeof input === 'string') {
    addBytes(Buffer.byteLength(input, 'utf8'), budget, options);
    if (containsLoneSurrogate(input))
      throw new TypeError(`${options.label} contains malformed text`);
    return input;
  }
  if (typeof input !== 'object' || isProxy(input)) {
    throw new TypeError(`${options.label} must contain only plain JSON values`);
  }
  if (ancestors.has(input)) throw new TypeError(`${options.label} contains a cycle`);
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
      if (
        keys.length !== input.length ||
        keys.some((key, index) => typeof key !== 'string' || key !== String(index))
      ) {
        throw new TypeError(`${options.label} must contain only dense arrays`);
      }
      return keys.map((key) => {
        const descriptor = descriptors[key as string];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError(`${options.label} properties must be enumerable data properties`);
        }
        return snapshot(descriptor.value, depth + 1, ancestors, budget, options);
      });
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${options.label} must contain only plain JSON objects`);
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(input)) {
      if (
        typeof key !== 'string' ||
        key === '__proto__' ||
        key === 'prototype' ||
        key === 'constructor' ||
        containsLoneSurrogate(key)
      ) {
        throw new TypeError(`${options.label} contains an unsafe property`);
      }
      addBytes(Buffer.byteLength(key, 'utf8'), budget, options);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${options.label} properties must be enumerable data properties`);
      }
      output[key] = snapshot(descriptor.value, depth + 1, ancestors, budget, options);
    }
    return output;
  } finally {
    ancestors.delete(input);
  }
}

function addBytes(
  bytes: number,
  budget: { nodes: number; bytes: number },
  options: StrictJsonSnapshotOptions,
): void {
  if (bytes > options.maximumBytes - budget.bytes) {
    throw new TypeError(`${options.label} exceeds the canonical byte limit`);
  }
  budget.bytes += bytes;
}
