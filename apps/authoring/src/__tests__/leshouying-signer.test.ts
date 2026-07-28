import { describe, expect, it } from 'vitest';
import {
  canonicalizePaymentParameters,
  signPaymentParameters,
  verifyPaymentSignature,
} from '../platform/infra/leshouying/index.js';

const KEY = 'TEST_ONLY_KEY_123';

describe('Leshouying signer golden vectors', () => {
  it.each([
    {
      name: 'excludes null and sign while preserving empty strings',
      input: {
        mch_no: 'MCH_TEST_001',
        inst_no: 'INST_TEST',
        total_amount: '100',
        empty: '',
        ignored: null,
        sign: 'ffffffffffffffffffffffffffffffff',
      },
      canonical: 'empty=&inst_no=INST_TEST&mch_no=MCH_TEST_001&total_amount=100',
      digest: '182a863b3fdb32adb2991e78f67ab151',
    },
    {
      name: 'uses ASCII case-sensitive key ordering',
      input: { b: 'last', a_: 'underscore', a: 'lower', A: 'upper' },
      canonical: 'A=upper&a=lower&a_=underscore&b=last',
      digest: 'e3e0d39008adae0e930fcd521622a6cd',
    },
    {
      name: 'uses UTF-8 without URL encoding or trimming values',
      input: { memo: 'a=b&c', empty: '', body: '充值' },
      canonical: 'body=充值&empty=&memo=a=b&c',
      digest: '87144475138103c4b423d200d37455d6',
    },
    {
      name: 're-signs a callback payload',
      input: { return_code: 'SUCCESS', inst_no: 'INST_TEST', total_amount: '100' },
      canonical: 'inst_no=INST_TEST&return_code=SUCCESS&total_amount=100',
      digest: '1904c073a19b742bd01b4b1feb74eb9d',
    },
  ])('$name', ({ input, canonical, digest }) => {
    const parameters = input as unknown as Record<string, string | number | boolean | null>;
    expect(canonicalizePaymentParameters(parameters)).toBe(canonical);
    expect(signPaymentParameters(parameters, KEY)).toBe(digest);
    expect(verifyPaymentSignature({ ...parameters, sign: digest }, KEY)).toBe(true);
  });

  it('rejects an uppercase or tampered digest and non-ASCII parameter names', () => {
    const input = { inst_no: 'INST_TEST', total_amount: '100' };
    const digest = signPaymentParameters(input, KEY);
    expect(verifyPaymentSignature({ ...input, sign: digest.toUpperCase() }, KEY)).toBe(false);
    expect(verifyPaymentSignature({ ...input, total_amount: '101', sign: digest }, KEY)).toBe(
      false,
    );
    expect(() => canonicalizePaymentParameters({ 金额: '100' })).toThrow();
  });
});
