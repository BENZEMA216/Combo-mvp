import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  domainSeparatedHmacSha256,
  parseJsonNoDuplicateKeys,
  sha256Hex,
} from '../canonical.js';
import { readFixture } from './fixture-helpers.js';

interface CanonicalFixture {
  vectors: { name: string; input: unknown; canonical: string; sha256: string }[];
}

describe('RFC 8785 canonical JSON 与敏感摘要', () => {
  it('golden vectors 逐字 canonicalize 并得到冻结 SHA-256', async () => {
    const fixture = (await readFixture('canonical-vectors.v1.json')) as CanonicalFixture;
    for (const vector of fixture.vectors) {
      expect(canonicalizeJson(vector.input), vector.name).toBe(vector.canonical);
      expect(sha256Hex(vector.canonical), vector.name).toBe(vector.sha256);
    }
  });

  it('key order 与原始 whitespace 不影响 canonical bytes', () => {
    const left = parseJsonNoDuplicateKeys('{ "z": 1, "a": {"b": true, "a": null} }');
    const right = parseJsonNoDuplicateKeys('{"a":{"a":null,"b":true},"z":1}');
    expect(canonicalizeJson(left)).toBe(canonicalizeJson(right));
  });

  it('拒绝重复 key、未配对 surrogate、非 JSON 值和非有限数', () => {
    expect(() => parseJsonNoDuplicateKeys('{"a":1,"a":2}')).toThrow(/重复 JSON key/u);
    expect(() => canonicalizeJson('\ud800')).toThrow(/surrogate/u);
    expect(() => canonicalizeJson({ value: undefined })).toThrow(/undefined/u);
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrow(/非有限/u);
  });

  it('domain、tenant key 和 payload 共同隔离 HMAC digest', () => {
    const payload = { text: '低熵内容' };
    const tenantA = Buffer.alloc(32, 0x11);
    const tenantB = Buffer.alloc(32, 0x22);
    const requestA = domainSeparatedHmacSha256('combo:vnext:request:v1', tenantA, payload);
    expect(requestA).toBe(domainSeparatedHmacSha256('combo:vnext:request:v1', tenantA, payload));
    expect(requestA).not.toBe(domainSeparatedHmacSha256('combo:vnext:result:v1', tenantA, payload));
    expect(requestA).not.toBe(
      domainSeparatedHmacSha256('combo:vnext:request:v1', tenantB, payload),
    );
  });
});
