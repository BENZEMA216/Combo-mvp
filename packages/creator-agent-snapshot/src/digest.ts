import { sha256Hex as protocolSha256Hex } from '@cb/creator-agent-protocol';
import { timingSafeEqual } from 'node:crypto';

import { fail } from './errors.js';

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export function sha256Hex(bytes: Uint8Array): string {
  return protocolSha256Hex(bytes);
}

export function assertSha256Hex(value: string): void {
  if (!SHA256_HEX_PATTERN.test(value)) fail('SNAPSHOT_DIGEST_MISMATCH');
}

export function equalHexDigest(left: string, right: string): boolean {
  if (!SHA256_HEX_PATTERN.test(left) || !SHA256_HEX_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
