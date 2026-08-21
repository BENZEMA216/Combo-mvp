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
