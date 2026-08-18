import { describe, expect, it } from 'vitest';

// VNext registry case: SCH-005 (raw UTF-8/duplicate/syntax errors are sanitized).

import {
  RUNTIME_HTTP_BODY_LIMIT_BYTES,
  VnextJsonBodyError,
  isAllowedVnextContentEncoding,
  isAllowedVnextJsonContentType,
  parseVnextJsonBodyBytes,
} from './vnext-json-body.js';

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('VNext raw JSON body parser', () => {
  it.each([
    'application/json',
    'Application/JSON',
    ' application/json ',
    'application/json;charset=utf-8',
    'application/json ; charset = UTF-8',
    'application/json; charset="utf-8"',
    'APPLICATION/JSON;CHARSET="UTF-8"',
    'application/json\t;\tcharset\t=\tutf-8',
  ])('accepts only the frozen JSON media type form: %j', (value) => {
    expect(isAllowedVnextJsonContentType(value)).toBe(true);
  });

  it.each([
    'application/json;',
    'application/json; charset=utf-16',
    'application/json; charset=utf-8; charset=utf-8',
    'application/json; charset=utf-8; charset=utf-16',
    'application/json; profile=vnext',
    'text/plain',
    'application/merge-patch+json',
    'application/*+json',
    '',
  ])('rejects every non-frozen JSON media type form: %j', (value) => {
    expect(isAllowedVnextJsonContentType(value)).toBe(false);
  });

  it('allows only missing or identity Content-Encoding', () => {
    for (const accepted of [undefined, 'identity', 'IDENTITY', ' identity ']) {
      expect(isAllowedVnextContentEncoding(accepted), String(accepted)).toBe(true);
    }
    for (const rejected of ['', 'gzip', 'br', 'identity, gzip', ['identity']]) {
      expect(isAllowedVnextContentEncoding(rejected), String(rejected)).toBe(false);
    }
  });

  it('accepts valid JSON at the inherited Runtime byte ceiling and rejects plus one', () => {
    const exact = Buffer.concat([
      Buffer.from('{}', 'utf8'),
      Buffer.alloc(RUNTIME_HTTP_BODY_LIMIT_BYTES - 2, 0x20),
    ]);
    expect(exact.byteLength).toBe(RUNTIME_HTTP_BODY_LIMIT_BYTES);
    expect(parseVnextJsonBodyBytes(exact)).toEqual({});
    expect(() => parseVnextJsonBodyBytes(Buffer.concat([exact, Buffer.from(' ', 'utf8')]))).toThrow(
      VnextJsonBodyError,
    );
  });

  it.each([
    ['root duplicate', Buffer.from('{"RAW_ROOT_CANARY":1,"RAW_ROOT_CANARY":2}', 'utf8')],
    [
      'nested duplicate',
      Buffer.from('{"outer":{"RAW_NESTED_CANARY":1,"RAW_NESTED_CANARY":2}}', 'utf8'),
    ],
    ['syntax', Buffer.from('{"RAW_SYNTAX_CANARY":', 'utf8')],
    ['malformed UTF-8', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d])],
  ] as const)('returns one stable sanitized error for %s', (_name, bytes) => {
    const error = caught(() => parseVnextJsonBodyBytes(bytes));
    expect(error).toMatchObject({
      name: 'VnextJsonBodyError',
      message: 'VNEXT_JSON_BODY_INVALID',
      code: 'VNEXT_JSON_BODY_INVALID',
      statusCode: 400,
    });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('issues');
    expect(error).not.toHaveProperty('input');
    expect(JSON.stringify(error)).not.toContain('CANARY');
  });
});
