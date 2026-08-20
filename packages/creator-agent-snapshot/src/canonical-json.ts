import {
  canonicalizeJson as protocolCanonicalizeJson,
  type CanonicalJson,
} from '@cb/creator-agent-protocol';

import { fail } from './errors.js';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = CanonicalJson;

export function canonicalizeJson(value: JsonValue): string {
  try {
    return protocolCanonicalizeJson(value);
  } catch (error) {
    fail('CANONICAL_JSON_INVALID', error);
  }
}

export function canonicalJsonBytes(value: JsonValue): Buffer {
  return Buffer.from(canonicalizeJson(value), 'utf8');
}
