import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

import type * as CreatorAgentProtocolModule from '@cb/creator-agent-protocol';
import {
  SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES,
  SNAPSHOT_MAX_EXPANDED_BYTES,
  SNAPSHOT_MAX_FILE_BYTES,
  SNAPSHOT_MAX_FILES,
  SNAPSHOT_MAX_MEDIA_TYPE_BYTES,
  SNAPSHOT_MAX_PATH_BYTES,
  SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL,
  SNAPSHOT_MANIFEST_OBJECT_FORMAT,
  SNAPSHOT_MANIFEST_OBJECT_MAGIC,
  SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES,
  SNAPSHOT_PROTOCOL,
  SnapshotFileSchema,
  SnapshotManifestEnvelopeSchema,
  SnapshotManifestSchema,
  assertPublicManualCapOutcomeSubset,
  canonicalizeJson,
  parseSnapshotManifestCipherObject,
  sha256Hex,
  snapshotManifestEnvelopeAadDigest,
  snapshotManifestObjectKey,
  type SnapshotFile,
  type SnapshotManifest,
} from '@cb/creator-agent-protocol';
import { describe, expect, it, vi } from 'vitest';

const rawParserProbe = vi.hoisted(() => ({ calls: 0, sawCanary: false }));
const manualOutcomeFixtureUrl = new URL(
  '../../../creator-agent-protocol/fixtures/public-manual-cap-outcomes.v1.json',
  import.meta.url,
);
const consumerTestFile =
  'packages/creator-agent-snapshot/src/__tests__/manifest-canonical-byte-maximum.test.ts';

vi.mock('@cb/creator-agent-protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof CreatorAgentProtocolModule>();
  return {
    ...actual,
    parseJsonNoDuplicateKeys(text: string): unknown {
      rawParserProbe.calls += 1;
      rawParserProbe.sawCanary ||= text.includes('cafebabe'.repeat(8));
      return actual.parseJsonNoDuplicateKeys(text);
    },
  };
});

import { isSnapshotError } from '../errors.js';
import { parseSnapshotManifest, validateSnapshotManifestFiles } from '../manifest.js';
import {
  ALPHA_SNAPSHOT_POLICY,
  SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES as SNAPSHOT_POLICY_RAW_DEFENSE_MAX_BYTES,
} from '../policy.js';

const QUOTE = '"';
const PATH_MARKERS = ['0', '1', '2', '3'] as const;
const MAX_MEDIA_TYPE = `text/${'a'.repeat(SNAPSHOT_MAX_MEDIA_TYPE_BYTES - 5)}`;
const SENSITIVE_CANARY = 'cafebabe'.repeat(8);
const MAX_SIZE_DIGIT_SUM = 12_010;
const MAX_PATH_JSON_CONTENT_BYTES = 2_046_001;

/*
 * Global-bound proof outline:
 * - More files always add a positive object and may use size=0, so the 2,000-file limit is maximal.
 * - A path has at most 512 raw UTF-8 bytes. Controls and backslash are forbidden; among remaining
 *   scalars only `"` expands under JSON.stringify. Therefore content is at most 1,024 bytes. The
 *   all-quote value is unique, so at most one path reaches 1,024 and every other unique path is at
 *   most 1,023. The recipe reaches exactly 1,024 + 1,999*1,023.
 * - mediaType is bounded to 128 ASCII bytes, SHA-256 is fixed at 64 unescaped hex bytes, and all
 *   remaining fields are literals or totals. Decimal size digits are optimized independently by
 *   the monotone marginal-cost function below under the exact 200 MiB sum.
 * The final equation combines those maxima with canonical fixed syntax; no whitespace is used.
 */

const PATH_POLICY = Object.freeze({
  encoding: 'utf-8' as const,
  normalization: 'NFC' as const,
  ordering: 'utf-8-byte-order' as const,
  collision: 'nfc-plus-unicode-lowercase' as const,
});

const ARCHIVE_POLICY = Object.freeze({
  format: 'pax' as const,
  tarImplementation: 'combo-ustar-pax/1' as const,
  directoryEntries: 'omitted' as const,
  zstdImplementation: 'node-zlib-zstd@1.5.7' as const,
  zstdLevel: 9 as const,
  zstdChecksum: true as const,
  zstdContentSize: true as const,
  zstdDictionaryId: false as const,
  zstdWorkers: 0 as const,
  uid: 0 as const,
  gid: 0 as const,
  uname: '' as const,
  gname: '' as const,
  mtimeUnixSeconds: 0 as const,
  fileMode: '0444' as const,
});

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function oneMarkerPaths(): string[] {
  return PATH_MARKERS.flatMap((marker) =>
    Array.from(
      { length: SNAPSHOT_MAX_PATH_BYTES },
      (_, index) =>
        QUOTE.repeat(index) + marker + QUOTE.repeat(SNAPSHOT_MAX_PATH_BYTES - index - 1),
    ),
  );
}

function maximumPaths(includeUniqueAllQuotePath: boolean): string[] {
  const variants = oneMarkerPaths();
  const paths = includeUniqueAllQuotePath
    ? [QUOTE.repeat(SNAPSHOT_MAX_PATH_BYTES), ...variants.slice(0, SNAPSHOT_MAX_FILES - 1)]
    : variants.slice(0, SNAPSHOT_MAX_FILES);
  return paths.sort(utf8Compare);
}

function maximumSizeAt(index: number): number {
  if (index === 0) return 1_715_200;
  if (index < 10) return 1_000_000;
  return 100_000;
}

function maximumManifest(includeUniqueAllQuotePath: boolean): SnapshotManifest {
  const files = maximumPaths(includeUniqueAllQuotePath).map(
    (path, index): SnapshotFile => ({
      path,
      size: maximumSizeAt(index),
      mediaType: MAX_MEDIA_TYPE,
      sha256: SENSITIVE_CANARY,
    }),
  );
  return SnapshotManifestSchema.parse({
    protocol: SNAPSHOT_PROTOCOL,
    schemaVersion: 1,
    pathPolicy: PATH_POLICY,
    archive: ARCHIVE_POLICY,
    files,
    totals: { fileCount: SNAPSHOT_MAX_FILES, expandedBytes: SNAPSHOT_MAX_EXPANDED_BYTES },
  });
}

function jsonStringContentBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;
}

/** Maximum total decimal digits for `count` bounded non-negative integers under one sum budget. */
function maximumDecimalDigitSum(count: number, budget: number, maximumValue: number): number {
  let digits = count; // zero is the cheapest one-digit value
  let spent = 0;
  let eligible = count;
  let previousMinimum = 0;
  for (const nextMinimum of [10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000]) {
    if (nextMinimum > maximumValue || eligible === 0) break;
    const marginalCost = nextMinimum - previousMinimum;
    const promoted = Math.min(eligible, Math.floor((budget - spent) / marginalCost));
    digits += promoted;
    spent += promoted * marginalCost;
    eligible = promoted;
    previousMinimum = nextMinimum;
  }
  return digits;
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('EXPECTED_SNAPSHOT_MANIFEST_BOUNDARY_REJECTION');
}

function manifestCipherObjectAt(plaintextBytes: number) {
  const creatorId = '0198f00d-1111-7111-8111-111111111111';
  const snapshotDigest = 'a'.repeat(64);
  const nonce = Buffer.alloc(12, 0x11);
  const authTag = Buffer.alloc(16, 0x22);
  const object = Buffer.concat([
    Buffer.from(SNAPSHOT_MANIFEST_OBJECT_MAGIC, 'ascii'),
    nonce,
    Buffer.alloc(plaintextBytes, 0x5a),
    authTag,
  ]);
  const aad = {
    protocol: SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL,
    schemaVersion: 1 as const,
    cipherObjectFormat: SNAPSHOT_MANIFEST_OBJECT_FORMAT,
    creatorId,
    snapshotDigest,
    objectKey: snapshotManifestObjectKey(creatorId, snapshotDigest),
    plaintextBytes,
    keyId: 'kms://snapshot-manifest-raw-defense-v1',
  };
  const envelope = {
    protocol: SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL,
    schemaVersion: 1 as const,
    cipherObjectFormat: SNAPSHOT_MANIFEST_OBJECT_FORMAT,
    algorithm: 'aes-256-gcm/v1' as const,
    keyWrapAlgorithm: 'rfc3394-aes-256-kw/v1' as const,
    aad,
    aadDigest:
      plaintextBytes <= SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES
        ? snapshotManifestEnvelopeAadDigest(aad)
        : '0'.repeat(64),
    nonce: nonce.toString('base64url'),
    authTag: authTag.toString('base64url'),
    wrappedDek: Buffer.alloc(40, 0x33).toString('base64url'),
    cipherDigest: sha256Hex(object),
    cipherBytes: object.byteLength,
  };
  return { envelope, object };
}

describe('SCH-004 reachable Snapshot manifest canonical byte maximum', () => {
  it('shares the media semantic cap and keeps the 4 MiB raw defense cap separate', () => {
    expect(ALPHA_SNAPSHOT_POLICY.maxMediaTypeBytes).toBe(SNAPSHOT_MAX_MEDIA_TYPE_BYTES);
    expect(SNAPSHOT_POLICY_RAW_DEFENSE_MAX_BYTES).toBe(SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES);
    expect(SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES).toBeLessThan(
      SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES,
    );

    const baseFile: SnapshotFile = {
      path: 'manifest-media-boundary.txt',
      size: 0,
      mediaType: `text/${'a'.repeat(SNAPSHOT_MAX_MEDIA_TYPE_BYTES - 5)}`,
      sha256: SENSITIVE_CANARY,
    };
    expect(
      SnapshotFileSchema.safeParse({
        ...baseFile,
        mediaType: `text/${'a'.repeat(SNAPSHOT_MAX_MEDIA_TYPE_BYTES - 6)}`,
      }).success,
    ).toBe(true);
    expect(SnapshotFileSchema.safeParse(baseFile).success).toBe(true);
    const oversized = {
      ...baseFile,
      mediaType: `text/${'a'.repeat(SNAPSHOT_MAX_MEDIA_TYPE_BYTES - 4)}`,
    };
    expect(SnapshotFileSchema.safeParse(oversized).success).toBe(false);
    expect(validateSnapshotManifestFiles([baseFile])).toEqual({ fileCount: 1, expandedBytes: 0 });
    expect(isSnapshotError(caught(() => validateSnapshotManifestFiles([oversized])))).toBe(true);
  });

  it('keeps the separate 4 MiB encrypted-object defense cap reachable and exact', async () => {
    const actualOutcomes: Array<{ probeId: string; delta: -1 | 0 | 1; accepted: boolean }> = [];
    for (const offset of [-1, 0] as const) {
      const candidate = manifestCipherObjectAt(SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES + offset);
      expect(SnapshotManifestEnvelopeSchema.safeParse(candidate.envelope).success).toBe(true);
      let accepted = true;
      try {
        parseSnapshotManifestCipherObject(candidate.envelope, candidate.object);
      } catch {
        accepted = false;
      }
      expect(accepted).toBe(true);
      actualOutcomes.push({
        probeId: 'manual-cap:snapshot-manifest-raw-defense:n-minus-one-n-plus-one',
        delta: offset,
        accepted,
      });
    }
    const oversized = manifestCipherObjectAt(SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES + 1);
    const result = SnapshotManifestEnvelopeSchema.safeParse(oversized.envelope);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('EXPECTED_MANIFEST_RAW_DEFENSE_REJECTION');
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'too_big',
          maximum: SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES,
          path: ['aad', 'plaintextBytes'],
        }),
        expect.objectContaining({
          code: 'too_big',
          maximum: SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES + 36,
          path: ['cipherBytes'],
        }),
      ]),
    );
    let oversizedAccepted = true;
    try {
      parseSnapshotManifestCipherObject(oversized.envelope, oversized.object);
    } catch {
      oversizedAccepted = false;
    }
    expect(oversizedAccepted).toBe(false);
    actualOutcomes.push({
      probeId: 'manual-cap:snapshot-manifest-raw-defense:n-minus-one-n-plus-one',
      delta: 1,
      accepted: oversizedAccepted,
    });
    assertPublicManualCapOutcomeSubset(
      JSON.parse(await readFile(manualOutcomeFixtureUrl, 'utf8')),
      consumerTestFile,
      actualOutcomes,
    );
  });

  it('proves the all-field recipe reaches the global upper bound', () => {
    const manifest = maximumManifest(true);
    const canonical = canonicalizeJson(manifest);
    const paths = manifest.files.map(({ path }) => path);
    const pathContentBytes = paths.map(jsonStringContentBytes);
    const sizes = manifest.files.map(({ size }) => size);

    expect(manifest.files).toHaveLength(SNAPSHOT_MAX_FILES);
    expect(new Set(paths).size).toBe(SNAPSHOT_MAX_FILES);
    expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(SNAPSHOT_MAX_FILES);
    expect(
      paths.every((path, index) => index === 0 || utf8Compare(paths[index - 1]!, path) < 0),
    ).toBe(true);
    expect(paths.every((path) => Buffer.byteLength(path, 'utf8') === SNAPSHOT_MAX_PATH_BYTES)).toBe(
      true,
    );
    expect(pathContentBytes.filter((bytes) => bytes === SNAPSHOT_MAX_PATH_BYTES * 2)).toHaveLength(
      1,
    );
    expect(
      pathContentBytes.filter((bytes) => bytes === SNAPSHOT_MAX_PATH_BYTES * 2 - 1),
    ).toHaveLength(SNAPSHOT_MAX_FILES - 1);
    expect(pathContentBytes.reduce((total, bytes) => total + bytes, 0)).toBe(
      MAX_PATH_JSON_CONTENT_BYTES,
    );
    expect(Buffer.byteLength(MAX_MEDIA_TYPE, 'utf8')).toBe(SNAPSHOT_MAX_MEDIA_TYPE_BYTES);
    expect(sizes.every((size) => size <= SNAPSHOT_MAX_FILE_BYTES)).toBe(true);
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(SNAPSHOT_MAX_EXPANDED_BYTES);
    expect(sizes.reduce((total, size) => total + String(size).length, 0)).toBe(MAX_SIZE_DIGIT_SUM);
    expect(
      maximumDecimalDigitSum(
        SNAPSHOT_MAX_FILES,
        SNAPSHOT_MAX_EXPANDED_BYTES,
        SNAPSHOT_MAX_FILE_BYTES,
      ),
    ).toBe(MAX_SIZE_DIGIT_SUM);

    const skeletonBytes = Buffer.byteLength(canonicalizeJson({ ...manifest, files: [] }), 'utf8');
    const baselineFileBytes = Buffer.byteLength(
      canonicalizeJson({
        path: `0${QUOTE.repeat(SNAPSHOT_MAX_PATH_BYTES - 1)}`,
        size: 100_000,
        mediaType: MAX_MEDIA_TYPE,
        sha256: SENSITIVE_CANARY,
      }),
      'utf8',
    );
    const uniqueAllQuoteBonus = 1;
    const sizeDigitBonus = MAX_SIZE_DIGIT_SUM - SNAPSHOT_MAX_FILES * 6;
    const arrayCommas = SNAPSHOT_MAX_FILES - 1;
    expect(skeletonBytes).toBe(565);
    expect(baselineFileBytes).toBe(1_267);
    expect(
      skeletonBytes +
        SNAPSHOT_MAX_FILES * baselineFileBytes +
        uniqueAllQuoteBonus +
        sizeDigitBonus +
        arrayCommas,
    ).toBe(SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES);
    expect(Buffer.byteLength(canonical, 'utf8')).toBe(SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES);
  });

  it('accepts reachable N-1/N and rejects exact N+1 before raw JSON parsing', async () => {
    const nMinusOne = Buffer.from(canonicalizeJson(maximumManifest(false)), 'utf8');
    const n = Buffer.from(canonicalizeJson(maximumManifest(true)), 'utf8');
    const nPlusOne = Buffer.concat([n, Buffer.from('!', 'ascii')]);

    expect(nMinusOne.byteLength).toBe(SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES - 1);
    expect(n.byteLength).toBe(SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES);
    expect(nPlusOne.byteLength).toBe(SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES + 1);

    rawParserProbe.calls = 0;
    rawParserProbe.sawCanary = false;
    let nMinusOneAccepted = true;
    let nMinusOneManifest: SnapshotManifest | undefined;
    try {
      nMinusOneManifest = parseSnapshotManifest(nMinusOne);
    } catch {
      nMinusOneAccepted = false;
    }
    expect(nMinusOneAccepted).toBe(true);
    expect(nMinusOneManifest?.files).toHaveLength(SNAPSHOT_MAX_FILES);
    expect(rawParserProbe).toEqual({ calls: 1, sawCanary: true });

    rawParserProbe.calls = 0;
    rawParserProbe.sawCanary = false;
    let nAccepted = true;
    let nManifest: SnapshotManifest | undefined;
    try {
      nManifest = parseSnapshotManifest(n);
    } catch {
      nAccepted = false;
    }
    expect(nAccepted).toBe(true);
    expect(nManifest?.files).toHaveLength(SNAPSHOT_MAX_FILES);
    expect(rawParserProbe).toEqual({ calls: 1, sawCanary: true });

    rawParserProbe.calls = 0;
    rawParserProbe.sawCanary = false;
    const error = caught(() => parseSnapshotManifest(nPlusOne));
    const nPlusOneAccepted = error === undefined;
    expect(nPlusOneAccepted).toBe(false);
    expect(isSnapshotError(error, 'SNAPSHOT_ARCHIVE_INVALID')).toBe(true);
    expect(rawParserProbe).toEqual({ calls: 0, sawCanary: false });
    expect(JSON.stringify(error)).not.toContain(SENSITIVE_CANARY);
    expect((error as Error).cause).toBeUndefined();
    assertPublicManualCapOutcomeSubset(
      JSON.parse(await readFile(manualOutcomeFixtureUrl, 'utf8')),
      consumerTestFile,
      [
        {
          probeId: 'manual-cap:snapshot-manifest-canonical:n-minus-one-n-plus-one',
          delta: -1,
          accepted: nMinusOneAccepted,
        },
        {
          probeId: 'manual-cap:snapshot-manifest-canonical:n-minus-one-n-plus-one',
          delta: 0,
          accepted: nAccepted,
        },
        {
          probeId: 'manual-cap:snapshot-manifest-canonical:n-minus-one-n-plus-one',
          delta: 1,
          accepted: nPlusOneAccepted,
        },
      ],
    );
  });
});
