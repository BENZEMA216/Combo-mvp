import { describe, expect, it } from 'vitest';

import { canonicalizeJson, isSnapshotError } from '../index.js';

const holeyArray = new Array<unknown>(2);
holeyArray[1] = 1;

describe('RFC 8785 compatible canonical JSON', () => {
  it('sorts object keys recursively and preserves array order', () => {
    expect(
      canonicalizeJson({
        z: 1,
        a: { y: true, x: null },
        list: [3, 2, 1],
      }),
    ).toBe('{"a":{"x":null,"y":true},"list":[3,2,1],"z":1}');
  });

  it('uses ECMAScript number serialization required by JCS', () => {
    expect(canonicalizeJson({ minusZero: -0, tiny: 1e-7, large: 1e30, decimal: 4.5 })).toBe(
      '{"decimal":4.5,"large":1e+30,"minusZero":0,"tiny":1e-7}',
    );
  });

  it('sorts non-ASCII keys by UTF-16 code units', () => {
    expect(canonicalizeJson({ '€': 1, '\r': 2, ö: 3, '1': 4, '😀': 5 })).toBe(
      '{"\\r":2,"1":4,"ö":3,"€":1,"😀":5}',
    );
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined,
    BigInt(1),
    new Date(0),
    holeyArray,
    '\ud800',
    '\udc00',
  ])('rejects non-I-JSON input %#', (value) => {
    try {
      canonicalizeJson(value as never);
      expect.fail('expected canonicalization to fail');
    } catch (error) {
      expect(isSnapshotError(error, 'CANONICAL_JSON_INVALID')).toBe(true);
    }
  });

  it('rejects cycles', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic as never)).toThrowError();
  });
});
