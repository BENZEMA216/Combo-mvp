import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

type Probe = Readonly<{
  delta: -1 | 0 | 1;
  archive: Readonly<{ bytes: number; sha256: string; frames: number }>;
  manifest: Readonly<{ bytes: number; sha256: string }>;
  builder: 'accepted' | 'SNAPSHOT_COMPRESSED_TOO_LARGE';
  verifier: 'accepted' | 'SNAPSHOT_COMPRESSED_TOO_LARGE';
}>;

type ExactBoundaryFixture = Readonly<{
  protocol: 'combo.snapshot-compressed-exact-boundary/1';
  schemaVersion: 1;
  scope: 'real-canonical-tar-zstd-50-mib-boundary';
  evidenceClass: 'production-mechanism';
  authority: Readonly<{
    technicalPlanSection: '技术方案 §5.2 Alpha 输入边界';
    testPlanCase: 'SNP-008';
    decisionRegistryId: 'ADR-VNEXT-003';
  }>;
  generator: Readonly<{
    algorithm: 'shake256-low5-base32/1';
    seedPrefix: 'combo:snp-008:shake256-base32:v1';
    seedSeparator: 'single-nul-byte';
    fileIndexEncoding: 'two-digit-decimal';
    shakeOutput: 'one-shot-outputLength-equals-file-bytes';
    mapping: 'alphabet[rawByte & 31]';
    alphabet: 'abcdefghijklmnopqrstuvwxyz234567';
    pathTemplate: 'snp008/base32-{index}.txt';
    mediaType: 'text/plain; charset=utf-8';
    commonFiles: readonly unknown[];
  }>;
  canonicalArchivePolicy: Readonly<{
    tarImplementation: 'combo-ustar-pax/1';
    zstdImplementation: 'node-zlib-zstd@1.5.7';
    zstdLevel: 9;
    zstdChecksum: true;
    zstdContentSize: true;
    zstdDictionaryId: false;
    zstdWorkers: 0;
    zstdFrameCount: 1;
    nodeSyncWrapper: Readonly<{
      primaryOutputChunkBytes: 16_384;
      aliasEmptyFrameHex: '28b52ffd240001000099e9d851';
      aliasRetryOutputChunkBytes: 65_537;
      normalization: 'retry-only-when-primary-output-ends-with-empty-frame-and-retry-equals-primary-prefix';
    }>;
  }>;
  calibrationProvenance: Readonly<{
    mode: 'offline-finite-search';
    runtime: string;
    ciSearchForbidden: true;
    largeObjectsCommitted: false;
    discovery: string;
  }>;
  probes: readonly Probe[];
}>;

type WorkerResult = Readonly<{
  protocol: string;
  caseId: string;
  delta: number;
  archiveBytes: number;
  archiveDigest: string;
  manifestDigest: string;
  builder: string;
  verifier: string;
}>;

const execFileAsync = promisify(execFile);
const fixtureUrl = new URL(
  '../../../creator-agent-protocol/fixtures/snapshot-compressed-exact-boundary.v1.json',
  import.meta.url,
);
const fixtureIndexUrl = new URL(
  '../../../creator-agent-protocol/fixtures/index.json',
  import.meta.url,
);
const workerPath = fileURLToPath(
  new URL('./compressed-exact-boundary-worker.mjs', import.meta.url),
);

let fixture: ExactBoundaryFixture;
let fixtureDigest: string;

beforeAll(async () => {
  const bytes = await readFile(fixtureUrl);
  fixture = JSON.parse(bytes.toString('utf8')) as ExactBoundaryFixture;
  fixtureDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
});

describe.sequential('SNP-008 real canonical 50 MiB compressed boundary', () => {
  it('binds a compact production-mechanism recipe without committed large objects or CI search', async () => {
    expect(Object.keys(fixture).sort()).toEqual([
      'authority',
      'calibrationProvenance',
      'canonicalArchivePolicy',
      'evidenceClass',
      'generator',
      'probes',
      'protocol',
      'schemaVersion',
      'scope',
    ]);
    expect(fixture).toMatchObject({
      protocol: 'combo.snapshot-compressed-exact-boundary/1',
      schemaVersion: 1,
      scope: 'real-canonical-tar-zstd-50-mib-boundary',
      evidenceClass: 'production-mechanism',
      authority: {
        technicalPlanSection: '技术方案 §5.2 Alpha 输入边界',
        testPlanCase: 'SNP-008',
        decisionRegistryId: 'ADR-VNEXT-003',
      },
      generator: {
        algorithm: 'shake256-low5-base32/1',
        seedPrefix: 'combo:snp-008:shake256-base32:v1',
        seedSeparator: 'single-nul-byte',
        fileIndexEncoding: 'two-digit-decimal',
        shakeOutput: 'one-shot-outputLength-equals-file-bytes',
        mapping: 'alphabet[rawByte & 31]',
        alphabet: 'abcdefghijklmnopqrstuvwxyz234567',
        pathTemplate: 'snp008/base32-{index}.txt',
        mediaType: 'text/plain; charset=utf-8',
      },
      canonicalArchivePolicy: {
        tarImplementation: 'combo-ustar-pax/1',
        zstdImplementation: 'node-zlib-zstd@1.5.7',
        zstdLevel: 9,
        zstdChecksum: true,
        zstdContentSize: true,
        zstdDictionaryId: false,
        zstdWorkers: 0,
        zstdFrameCount: 1,
        nodeSyncWrapper: {
          primaryOutputChunkBytes: 16_384,
          aliasEmptyFrameHex: '28b52ffd240001000099e9d851',
          aliasRetryOutputChunkBytes: 65_537,
          normalization:
            'retry-only-when-primary-output-ends-with-empty-frame-and-retry-equals-primary-prefix',
        },
      },
      calibrationProvenance: {
        mode: 'offline-finite-search',
        runtime: 'Darwin-arm64 Node-v25.6.1 zstd-1.5.7',
        ciSearchForbidden: true,
        largeObjectsCommitted: false,
        discovery:
          "The exact vector's primary frame is 52428800 bytes; Node's default sync output wrapper appended one 13-byte empty frame before conditional normalization.",
      },
    });
    expect(fixture.probes.map(({ delta, archive }) => [delta, archive.bytes])).toEqual([
      [-1, 52_428_799],
      [0, 52_428_800],
      [1, 52_428_801],
    ]);
    expect(fixture.probes.every(({ archive }) => archive.frames === 1)).toBe(true);

    const index = JSON.parse(await readFile(fixtureIndexUrl, 'utf8')) as {
      fixtures: Array<{ path: string; bytes: number; digest: string }>;
    };
    expect(
      index.fixtures.find(({ path }) => path === 'snapshot-compressed-exact-boundary.v1.json'),
    ).toEqual({
      path: 'snapshot-compressed-exact-boundary.v1.json',
      bytes: (await readFile(fixtureUrl)).byteLength,
      digest: fixtureDigest,
    });
  });

  it.each([-1, 0, 1] as const)(
    'rebuilds delta %i through real builder and verifier roots',
    async (delta) => {
      const probe = fixture.probes.find((candidate) => candidate.delta === delta);
      if (probe === undefined) throw new Error(`MISSING_SNP_008_PROBE_${delta}`);
      const workerTempRoot = await mkdtemp(join(tmpdir(), `combo-snp008-parent-${delta}-`));
      try {
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          ['--expose-gc', workerPath, String(delta)],
          {
            cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
            env: {
              PATH: process.env.PATH,
              TMPDIR: workerTempRoot,
            },
            timeout: 120_000,
            maxBuffer: 64 * 1024,
          },
        );
        expect(stderr).toBe('');
        const result = JSON.parse(stdout) as WorkerResult;
        expect(result).toEqual({
          protocol: fixture.protocol,
          caseId: 'SNP-008',
          delta,
          archiveBytes: probe.archive.bytes,
          archiveDigest: probe.archive.sha256,
          manifestDigest: probe.manifest.sha256,
          builder: probe.builder,
          verifier: probe.verifier,
        });
      } finally {
        await rm(workerTempRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
