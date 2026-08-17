import { createHash, createHmac } from 'node:crypto';
import { containsLoneSurrogate } from './primitives.js';

export type CanonicalJson = null | boolean | number | string | CanonicalJson[] | CanonicalObject;
export type CanonicalObject = { [key: string]: CanonicalJson };
export const CANONICAL_JSON_IMPLEMENTATION = 'combo-rfc8785-jcs/1' as const;

export type ProtocolRawInputErrorCode =
  | 'BROKER_HANDSHAKE_INVALID'
  | 'BROKER_FRAME_INVALID'
  | 'SNAPSHOT_PREPARATION_MARKER_INVALID'
  | 'SNAPSHOT_COMMIT_MARKER_INVALID';

/** Public raw-byte/string ingress failure with no parser issue, input, or cause surface. */
export class ProtocolRawInputError extends Error {
  readonly code: ProtocolRawInputErrorCode;

  constructor(code: ProtocolRawInputErrorCode) {
    super(code);
    this.name = 'ProtocolRawInputError';
    this.code = code;
  }
}

/** RFC 8785 JCS：I-JSON 输入、ECMAScript 数字序列化、UTF-16 code-unit key 排序。 */
export function canonicalizeJson(value: unknown): string {
  assertCanonicalValue(value, '$');
  return serializeCanonical(value as CanonicalJson);
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalizeJson(value));
}

export function domainSeparatedHmacSha256(domain: string, key: Uint8Array, value: unknown): string {
  if (!/^[a-z0-9:.-]+$/u.test(domain)) {
    throw new TypeError('HMAC domain 必须是稳定 ASCII 标识');
  }
  const mac = createHmac('sha256', key)
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalizeJson(value), 'utf8')
    .digest('hex');
  return `hmac-sha256:${mac}`;
}

/** JSON.parse 前先扫描 object key，拒绝重复 key；随后仍由原生解析器判定完整语法。 */
export function parseJsonNoDuplicateKeys(text: string): unknown {
  const scanner = new JsonDuplicateKeyScanner(text);
  scanner.scanDocument();
  const parsed: unknown = JSON.parse(text);
  assertCanonicalValue(parsed, '$');
  return parsed;
}

function serializeCanonical(value: CanonicalJson): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key]!)}`).join(',')}}`;
}

function assertCanonicalValue(value: unknown, path: string): asserts value is CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && containsLoneSurrogate(value)) {
      throw new TypeError(`${path} 含未配对的 Unicode surrogate`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} 含非有限数字`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`${path}[${index}] 不能是 sparse array hole`);
      }
      const item: unknown = value[index];
      if (item === undefined) throw new TypeError(`${path}[${index}] 不能是 undefined`);
      assertCanonicalValue(item, `${path}[${index}]`);
    }
    return;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} 必须是普通 JSON object`);
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (containsLoneSurrogate(key)) throw new TypeError(`${path} 的 key 含未配对 surrogate`);
      if (nested === undefined) throw new TypeError(`${path}.${key} 不能是 undefined`);
      assertCanonicalValue(nested, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} 不是 JSON 值`);
}

class JsonDuplicateKeyScanner {
  private offset = 0;

  public constructor(private readonly input: string) {}

  public scanDocument(): void {
    this.skipWhitespace();
    this.scanValue();
    this.skipWhitespace();
    if (this.offset !== this.input.length) this.fail('根值后存在额外内容');
  }

  private scanValue(): void {
    const token = this.input[this.offset];
    if (token === '{') return this.scanObject();
    if (token === '[') return this.scanArray();
    if (token === '"') {
      this.scanString();
      return;
    }
    if (token === 't') return this.scanLiteral('true');
    if (token === 'f') return this.scanLiteral('false');
    if (token === 'n') return this.scanLiteral('null');
    this.scanNumber();
  }

  private scanObject(): void {
    this.expect('{');
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.input[this.offset] === '}') {
      this.offset += 1;
      return;
    }
    while (true) {
      if (this.input[this.offset] !== '"') this.fail('object key 必须是字符串');
      const key = this.scanString();
      if (keys.has(key)) this.fail('重复 JSON key');
      keys.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      this.scanValue();
      this.skipWhitespace();
      const separator = this.input[this.offset];
      if (separator === '}') {
        this.offset += 1;
        return;
      }
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private scanArray(): void {
    this.expect('[');
    this.skipWhitespace();
    if (this.input[this.offset] === ']') {
      this.offset += 1;
      return;
    }
    while (true) {
      this.scanValue();
      this.skipWhitespace();
      const separator = this.input[this.offset];
      if (separator === ']') {
        this.offset += 1;
        return;
      }
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private scanString(): string {
    const start = this.offset;
    this.expect('"');
    while (this.offset < this.input.length) {
      const token = this.input[this.offset]!;
      if (token === '"') {
        this.offset += 1;
        return JSON.parse(this.input.slice(start, this.offset)) as string;
      }
      if (token === '\\') {
        this.offset += 2;
      } else {
        if (token.charCodeAt(0) <= 0x1f) this.fail('字符串含未转义控制字符');
        this.offset += 1;
      }
    }
    this.fail('字符串未闭合');
  }

  private scanLiteral(literal: string): void {
    if (this.input.slice(this.offset, this.offset + literal.length) !== literal) {
      this.fail(`非法 token，期望 ${literal}`);
    }
    this.offset += literal.length;
  }

  private scanNumber(): void {
    const tail = this.input.slice(this.offset);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(tail);
    if (!match) this.fail('非法 JSON 值');
    this.offset += match[0].length;
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.input[this.offset] ?? '') && this.offset < this.input.length) {
      this.offset += 1;
    }
  }

  private expect(token: string): void {
    if (this.input[this.offset] !== token) this.fail(`期望 ${token}`);
    this.offset += 1;
  }

  private fail(message: string): never {
    throw new SyntaxError(`${message} (offset ${this.offset})`);
  }
}
