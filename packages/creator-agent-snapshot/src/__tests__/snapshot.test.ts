import { mkdtemp, mkdir, readFile, rm, chmod, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { SnapshotManifestSchema } from '@cb/creator-agent-protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ALPHA_SNAPSHOT_POLICY,
  assertCompressedArchiveLimits,
  buildSnapshotFromProject,
  canonicalizeJson,
  compressDeterministicTar,
  createDeterministicTar,
  createSnapshotManifest,
  decryptAndVerifySnapshot,
  encryptSnapshotArchive,
  isSnapshotError,
  parseSnapshotManifest,
  readStagedProject,
  sha256Hex,
  snapshotDigest,
  snapshotManifestBytes,
  stageProject,
  verifySnapshotArchive,
  type SnapshotManifestFile,
} from '../index.js';

const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'combo-snapshot-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function writeGoldenProject(root: string, reverse: boolean): Promise<void> {
  const entries: readonly [string, string][] = [
    ['FACTS.md', '# Facts\nThe marker is ALPHA-4731.\n'],
    ['nested/TABLE.csv', 'name,value\nalpha,17\nbeta,29\n'],
    ['policy.json', '{"language":"zh-CN","unknown":"say-so"}\n'],
  ];
  for (const [path, content] of reverse ? [...entries].reverse() : entries) {
    const fullPath = join(root, ...path.split('/'));
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
  }
}

function manifestFile(path: string, size = 0): SnapshotManifestFile {
  return {
    path,
    size,
    mediaType: 'text/plain; charset=utf-8',
    sha256: sha256Hex(Buffer.alloc(size > 0 && size <= 1024 ? size : 0)),
  };
}

describe('deterministic Snapshot', () => {
  it('parses the authoritative protocol fixture through canonical wire bytes', async () => {
    const fixtureText = await readFile(
      new URL(
        '../../../creator-agent-protocol/fixtures/snapshot-manifest.v1.json',
        import.meta.url,
      ),
      'utf8',
    );
    const fixture = JSON.parse(fixtureText) as Parameters<typeof canonicalizeJson>[0];
    const canonicalBytes = Buffer.from(canonicalizeJson(fixture), 'utf8');
    const parsed = parseSnapshotManifest(canonicalBytes);

    expect(parsed.archive).toMatchObject({
      tarImplementation: 'combo-ustar-pax/1',
      directoryEntries: 'omitted',
      zstdImplementation: 'node-zlib-zstd@1.5.7',
      zstdContentSize: true,
      zstdDictionaryId: false,
      zstdWorkers: 0,
    });
    expect(parsed.pathPolicy.collision).toBe('nfc-plus-unicode-lowercase');
    expect(snapshotManifestBytes(parsed).equals(canonicalBytes)).toBe(true);
    expect(snapshotDigest(parsed)).toBe(sha256Hex(canonicalBytes));
  });

  it('matches the golden vector in an independent Node process', () => {
    const result = spawnSync(process.execPath, ['src/__tests__/cross-process-golden.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'Pacific/Kiritimati', USER: 'synthetic-builder' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      zstd: '1.5.7',
      snapshotDigest: '55d039fcf97ed1faf03b9fc4a1d15c9e6af32a0dd0f2235f07c83d14c69318c1',
      tarDigest: '44198b3a6cefe1e5105cec65e8930e52b525ff7e142a4afbab75cb3c9222f7d9',
      archiveDigest: '308a88492d7dc342c973a84f508c154b95ab542ae8ae3844ef180e8cef823abb',
    });
  });

  it('matches the frozen combo-ustar-pax/1 + zstd-1.5.7 golden vector', () => {
    const tar = createDeterministicTar([
      { path: 'FACTS.md', bytes: Buffer.from('# Facts\nMarker ALPHA-4731.\n') },
      {
        path: 'nested/TABLE.csv',
        bytes: Buffer.from('name,value\nalpha,17\nbeta,29\n'),
      },
    ]);
    const archive = compressDeterministicTar(tar);
    expect(sha256Hex(tar)).toBe('44198b3a6cefe1e5105cec65e8930e52b525ff7e142a4afbab75cb3c9222f7d9');
    expect(sha256Hex(archive)).toBe(
      '308a88492d7dc342c973a84f508c154b95ab542ae8ae3844ef180e8cef823abb',
    );
  });

  it('ignores source creation order, mtime and ordinary readable mode metadata', async () => {
    const firstRoot = await temporaryProject();
    const secondRoot = await temporaryProject();
    await writeGoldenProject(firstRoot, false);
    await writeGoldenProject(secondRoot, true);

    const oldTime = new Date('2001-01-01T00:00:00.000Z');
    const newTime = new Date('2031-12-31T23:59:59.000Z');
    await utimes(join(firstRoot, 'FACTS.md'), oldTime, oldTime);
    await utimes(join(secondRoot, 'FACTS.md'), newTime, newTime);
    await chmod(join(firstRoot, 'FACTS.md'), 0o600);
    await chmod(join(secondRoot, 'FACTS.md'), 0o644);

    const first = await buildSnapshotFromProject(firstRoot);
    const second = await buildSnapshotFromProject(secondRoot);

    expect(first.manifestBytes.equals(second.manifestBytes)).toBe(true);
    expect(first.archiveBytes.equals(second.archiveBytes)).toBe(true);
    expect(first.snapshotDigest).toBe(second.snapshotDigest);
    expect(first.archiveDigest).toBe(second.archiveDigest);
    expect(first.fileCount).toBe(3);
  });

  it('omits empty directory entries from the frozen archive identity', async () => {
    const firstRoot = await temporaryProject();
    const secondRoot = await temporaryProject();
    await writeFile(join(firstRoot, 'FACTS.md'), 'same bytes\n', 'utf8');
    await writeFile(join(secondRoot, 'FACTS.md'), 'same bytes\n', 'utf8');
    await mkdir(join(secondRoot, 'empty', 'nested'), { recursive: true });

    const first = await buildSnapshotFromProject(firstRoot);
    const second = await buildSnapshotFromProject(secondRoot);
    expect(second.manifest.archive.directoryEntries).toBe('omitted');
    expect(second.manifestBytes.equals(first.manifestBytes)).toBe(true);
    expect(second.archiveBytes.equals(first.archiveBytes)).toBe(true);
  });

  it('changes both content identities for a one-byte file mutation', async () => {
    const root = await temporaryProject();
    await writeGoldenProject(root, false);
    const first = await buildSnapshotFromProject(root);
    await writeFile(join(root, 'FACTS.md'), '# Facts\nThe marker is ALPHA-4732.\n', 'utf8');
    const second = await buildSnapshotFromProject(root);
    expect(second.snapshotDigest).not.toBe(first.snapshotDigest);
    expect(second.archiveDigest).not.toBe(first.archiveDigest);
  });

  it('verifies manifest, archive and every file digest', async () => {
    const root = await temporaryProject();
    await writeGoldenProject(root, false);
    const built = await buildSnapshotFromProject(root);
    expect(SnapshotManifestSchema.parse(JSON.parse(built.manifestBytes.toString('utf8')))).toEqual(
      built.manifest,
    );
    expect(
      verifySnapshotArchive({
        manifestBytes: built.manifestBytes,
        archiveBytes: built.archiveBytes,
        expectedSnapshotDigest: built.snapshotDigest,
        expectedArchiveDigest: built.archiveDigest,
      }),
    ).toMatchObject({
      snapshotDigest: built.snapshotDigest,
      archiveDigest: built.archiveDigest,
      fileCount: 3,
    });

    const tampered = Buffer.from(built.archiveBytes);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() =>
      verifySnapshotArchive({
        manifestBytes: built.manifestBytes,
        archiveBytes: tampered,
        expectedSnapshotDigest: built.snapshotDigest,
        expectedArchiveDigest: built.archiveDigest,
      }),
    ).toThrowError();
  });

  it('authenticates encrypted bytes before the archive verifier receives plaintext', async () => {
    const root = await temporaryProject();
    await writeGoldenProject(root, false);
    const built = await buildSnapshotFromProject(root);
    const context = {
      schemaVersion: 1 as const,
      creatorId: 'creator-a',
      snapshotDigest: built.snapshotDigest,
      archiveDigest: built.archiveDigest,
    };
    const key = Buffer.from('44'.repeat(32), 'hex');
    const encrypted = encryptSnapshotArchive(
      built.archiveBytes,
      context,
      key,
      Buffer.from('55'.repeat(12), 'hex'),
    );
    expect(
      decryptAndVerifySnapshot({
        manifestBytes: built.manifestBytes,
        encryptedObjectBytes: encrypted.objectBytes,
        encryptionContext: context,
        dataEncryptionKey: key,
        expectedCipherDigest: encrypted.cipherDigest,
      }),
    ).toMatchObject({ snapshotDigest: built.snapshotDigest, archiveDigest: built.archiveDigest });

    const changed = Buffer.from(encrypted.objectBytes);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    expect(() =>
      decryptAndVerifySnapshot({
        manifestBytes: built.manifestBytes,
        encryptedObjectBytes: changed,
        encryptionContext: context,
        dataEncryptionKey: key,
        expectedCipherDigest: sha256Hex(changed),
      }),
    ).toThrowError();
  });

  it('uses staging bytes after staging and never rereads the live Project', async () => {
    const root = await temporaryProject();
    await writeFile(join(root, 'FACTS.md'), 'before staging\n', 'utf8');
    const staged = await stageProject(root);
    try {
      await writeFile(join(root, 'FACTS.md'), 'after staging\n', 'utf8');
      const files = await readStagedProject(staged);
      expect(files).toHaveLength(1);
      expect(files[0]!.bytes.toString('utf8')).toBe('before staging\n');
      expect(await readFile(join(root, 'FACTS.md'), 'utf8')).toBe('after staging\n');
    } finally {
      await staged.cleanup();
    }
  });

  it('rejects staged bytes whose canonical read-only mode was changed', async () => {
    const root = await temporaryProject();
    await writeFile(join(root, 'FACTS.md'), 'staged bytes\n', 'utf8');
    const staged = await stageProject(root);
    try {
      await chmod(join(staged.root, 'FACTS.md'), 0o644);
      await expect(readStagedProject(staged)).rejects.toMatchObject({
        code: 'SNAPSHOT_SOURCE_CHANGED',
      });
    } finally {
      await staged.cleanup();
    }
  });

  it('accepts a 512-byte canonical path and deterministic PAX archive', async () => {
    const root = await temporaryProject();
    const path = `${'a'.repeat(250)}/${'b'.repeat(250)}/${'c'.repeat(10)}`;
    expect(Buffer.byteLength(path, 'utf8')).toBe(512);
    const fullPath = join(root, ...path.split('/'));
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, 'long path\n', 'utf8');
    const built = await buildSnapshotFromProject(root);
    expect(built.manifest.files[0]!.path).toBe(path);
    expect(() =>
      verifySnapshotArchive({
        manifestBytes: built.manifestBytes,
        archiveBytes: built.archiveBytes,
        expectedSnapshotDigest: built.snapshotDigest,
        expectedArchiveDigest: built.archiveDigest,
      }),
    ).not.toThrow();
  });
});

describe('Snapshot policy boundaries', () => {
  it('accepts 2,000 files and rejects 2,001 files', () => {
    const accepted = Array.from({ length: 2_000 }, (_, index) =>
      manifestFile(`files/${index.toString().padStart(4, '0')}.txt`),
    );
    expect(createSnapshotManifest(accepted).totals.fileCount).toBe(2_000);
    expect(() =>
      createSnapshotManifest([...accepted, manifestFile('files/extra.txt')]),
    ).toThrowError();
  });

  it('enforces exact single-file, expanded, compressed and path limits', () => {
    expect(() =>
      createSnapshotManifest([manifestFile('max.txt', ALPHA_SNAPSHOT_POLICY.maxFileBytes)]),
    ).not.toThrow();
    expectSnapshotCode(
      () =>
        createSnapshotManifest([
          manifestFile('too-large.txt', ALPHA_SNAPSHOT_POLICY.maxFileBytes + 1),
        ]),
      'SNAPSHOT_FILE_TOO_LARGE',
    );

    const exactlyExpanded = Array.from({ length: 20 }, (_, index) =>
      manifestFile(
        `expanded/${index.toString().padStart(2, '0')}.txt`,
        ALPHA_SNAPSHOT_POLICY.maxFileBytes,
      ),
    );
    expect(createSnapshotManifest(exactlyExpanded).totals.expandedBytes).toBe(
      ALPHA_SNAPSHOT_POLICY.maxExpandedBytes,
    );
    expectSnapshotCode(
      () => createSnapshotManifest([...exactlyExpanded, manifestFile('expanded/overflow.txt', 1)]),
      'SNAPSHOT_EXPANDED_TOO_LARGE',
    );

    expect(() =>
      assertCompressedArchiveLimits(
        ALPHA_SNAPSHOT_POLICY.maxCompressedBytes,
        ALPHA_SNAPSHOT_POLICY.maxCompressedBytes,
      ),
    ).not.toThrow();
    expectSnapshotCode(
      () =>
        assertCompressedArchiveLimits(
          ALPHA_SNAPSHOT_POLICY.maxCompressedBytes + 1,
          ALPHA_SNAPSHOT_POLICY.maxCompressedBytes,
        ),
      'SNAPSHOT_COMPRESSED_TOO_LARGE',
    );

    const path512 = `${'a'.repeat(250)}/${'b'.repeat(250)}/${'c'.repeat(10)}`;
    expect(() => createSnapshotManifest([manifestFile(path512)])).not.toThrow();
    expectSnapshotCode(
      () => createSnapshotManifest([manifestFile(`${path512}d`)]),
      'SNAPSHOT_PATH_TOO_LONG',
    );
  });

  it('rejects empty snapshots and abnormal compression ratios above 100:1', () => {
    expectSnapshotCode(() => createSnapshotManifest([]), 'SNAPSHOT_EMPTY');
    expect(() => assertCompressedArchiveLimits(100, 10_000)).not.toThrow();
    expectSnapshotCode(
      () => assertCompressedArchiveLimits(100, 10_001),
      'SNAPSHOT_COMPRESSION_RATIO_EXCEEDED',
    );
  });
});

function expectSnapshotCode(
  action: () => unknown,
  code: Parameters<typeof isSnapshotError>[1],
): void {
  try {
    action();
    expect.fail(`expected ${code}`);
  } catch (error) {
    expect(isSnapshotError(error, code)).toBe(true);
  }
}
