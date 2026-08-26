import { z } from 'zod';

export const HOST_RUNTIME_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

export const HostThreadIdSchema = z.string().regex(HOST_RUNTIME_ID_PATTERN).brand<'HostThreadId'>();
export type HostThreadId = z.infer<typeof HostThreadIdSchema>;

export const HostTurnIdSchema = z.string().regex(HOST_RUNTIME_ID_PATTERN).brand<'HostTurnId'>();
export type HostTurnId = z.infer<typeof HostTurnIdSchema>;

export const HostMessageIdSchema = z
  .string()
  .regex(HOST_RUNTIME_ID_PATTERN)
  .brand<'HostMessageId'>();
export type HostMessageId = z.infer<typeof HostMessageIdSchema>;

export const HostInterruptRequestIdSchema = z
  .string()
  .regex(HOST_RUNTIME_ID_PATTERN)
  .brand<'HostInterruptRequestId'>();
export type HostInterruptRequestId = z.infer<typeof HostInterruptRequestIdSchema>;

export const HostGenerationSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .brand<'HostGeneration'>();
export type HostGeneration = z.infer<typeof HostGenerationSchema>;

export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u)
  .brand<'Sha256Digest'>();
export type Sha256Digest = z.infer<typeof Sha256DigestSchema>;

export function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const COMMON_POSIX_ROOT_SEGMENTS = new Set([
  'applications',
  'bin',
  'boot',
  'dev',
  'etc',
  'home',
  'lib',
  'lib64',
  'library',
  'media',
  'mnt',
  'opt',
  'private',
  'proc',
  'root',
  'run',
  'sbin',
  'srv',
  'sys',
  'system',
  'tmp',
  'users',
  'usr',
  'var',
  'volumes',
  'workspace',
]);

/**
 * Detects machine-local references in free text while preserving ordinary
 * Project-relative references such as `docs/release.md` and Chinese phrases
 * such as `输入/输出`.
 */
export function containsNonPortableAgentReference(value: string): boolean {
  if (
    value.includes('\\') ||
    /~[A-Za-z0-9._-]*\/|[A-Za-z]:\/|\b[A-Za-z][A-Za-z0-9+.-]*:\/{1,2}/u.test(value) ||
    /\b[A-Za-z]:[A-Za-z0-9._-]+\//u.test(value) ||
    /(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|%[A-Za-z_][A-Za-z0-9_]*%)\//u.test(
      value,
    ) ||
    /\$env:[A-Za-z_][A-Za-z0-9_]*\//iu.test(value) ||
    /\bwww\.[A-Za-z0-9.-]+|\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}\.)+)[A-Za-z]{2,63}(?::\d{1,5})?\//iu.test(
      value,
    ) ||
    /\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+:\d{1,5}\//u.test(value) ||
    /\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+/u.test(value) ||
    /\blocalhost(?::\d{1,5})?(?:\/|\b)|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/|\b)|\[[0-9A-Fa-f:]+\](?::\d{1,5})?(?:\/|\b)/iu.test(
      value,
    ) ||
    /\b(?:task|session|thread)[-_ ]?id\s*[:=]/iu.test(value)
  ) {
    return true;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '/') continue;
    if (index === 0) return true;
    const previous = value[index - 1]!;
    if (/[\s\p{P}\p{S}]/u.test(previous)) return true;

    const segmentMatch = /^[A-Za-z0-9._-]+/u.exec(value.slice(index + 1));
    const segment = segmentMatch?.[0].toLowerCase();
    if (
      segment !== undefined &&
      COMMON_POSIX_ROOT_SEGMENTS.has(segment) &&
      !/[A-Za-z0-9._-]/u.test(previous)
    ) {
      return true;
    }
  }
  return false;
}
