import { posix } from 'node:path';

import { fail } from './errors.js';
import { ALPHA_SNAPSHOT_POLICY } from './policy.js';

const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:|\\\\)/u;

const blockedSegments = new Set([
  '.git',
  '.gitmodules',
  '.ssh',
  '.codex',
  '.aws',
  'node_modules',
  '__macosx',
]);

function hasBlockedSegment(path: string): boolean {
  return path.split('/').some((segment) => {
    const lowered = segment.toLowerCase();
    return (
      blockedSegments.has(lowered) ||
      lowered === '.ds_store' ||
      lowered.startsWith('.env') ||
      lowered === 'thumbs.db'
    );
  });
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function utf8ByteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function canonicalizeSnapshotPath(input: string): string {
  if (
    input.length === 0 ||
    input.includes('\\') ||
    input.startsWith('/') ||
    WINDOWS_ABSOLUTE.test(input) ||
    hasControlCharacter(input)
  ) {
    fail('SNAPSHOT_INVALID_PATH');
  }

  const sourceSegments = input.split('/');
  if (
    sourceSegments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail('SNAPSHOT_INVALID_PATH');
  }

  const normalized = sourceSegments.map((segment) => segment.normalize('NFC')).join('/');
  if (posix.isAbsolute(normalized) || normalized === '.' || normalized.startsWith('../')) {
    fail('SNAPSHOT_INVALID_PATH');
  }
  if (Buffer.byteLength(normalized, 'utf8') > ALPHA_SNAPSHOT_POLICY.maxPathUtf8Bytes) {
    fail('SNAPSHOT_PATH_TOO_LONG');
  }
  if (hasBlockedSegment(normalized)) fail('SNAPSHOT_PATH_BLOCKED');
  return normalized;
}

export class SnapshotPathRegistry {
  readonly #canonicalToSource = new Map<string, string>();
  readonly #caseFoldToCanonical = new Map<string, string>();

  add(sourcePath: string): string {
    const canonical = canonicalizeSnapshotPath(sourcePath);
    const previousSource = this.#canonicalToSource.get(canonical);
    if (previousSource !== undefined) {
      if (previousSource === sourcePath) fail('SNAPSHOT_DUPLICATE_PATH');
      fail('SNAPSHOT_UNICODE_COLLISION');
    }

    // 当前 Alpha 冻结为 NFC + Unicode lowercase。该策略会保守拒绝常见 APFS 大小写冲突。
    const caseFold = canonical.toLowerCase();
    const previousCanonical = this.#caseFoldToCanonical.get(caseFold);
    if (previousCanonical !== undefined && previousCanonical !== canonical) {
      fail('SNAPSHOT_CASE_COLLISION');
    }

    this.#canonicalToSource.set(canonical, sourcePath);
    this.#caseFoldToCanonical.set(caseFold, canonical);
    return canonical;
  }
}
