import { constants } from 'node:fs';
import {
  link,
  mkdtemp,
  mkdir,
  open,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSnapshotFromProject,
  compressDeterministicTar,
  createDeterministicTar,
  createSnapshotManifest,
  decompressZstdWithLimit,
  isSnapshotError,
  sha256Hex,
  SnapshotPathRegistry,
  snapshotDigest,
  snapshotManifestBytes,
  parseSnapshotManifest,
  stageProject,
  verifySnapshotArchive,
  type CreatorSnapshotErrorCode,
} from '../index.js';

const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'combo-hostile-snapshot-'));
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

async function expectReject(
  action: () => Promise<unknown> | unknown,
  code: CreatorSnapshotErrorCode,
): Promise<void> {
  try {
    await action();
    expect.fail(`expected ${code}`);
  } catch (error) {
    expect(isSnapshotError(error, code)).toBe(true);
  }
}

describe('hostile filesystem corpus', () => {
  it('rejects symlinks before reading their targets', async () => {
    const root = await temporaryProject();
    const outside = await temporaryProject();
    await writeFile(join(outside, 'canary.txt'), 'HOST_CANARY\n', 'utf8');
    await symlink(join(outside, 'canary.txt'), join(root, 'escape.txt'));
    await expectReject(() => buildSnapshotFromProject(root), 'SNAPSHOT_SYMLINK_FORBIDDEN');
  });

  it('rejects a Project root that is itself a symlink', async () => {
    const parent = await temporaryProject();
    const target = await temporaryProject();
    await writeFile(join(target, 'canary.txt'), 'HOST_CANARY\n', 'utf8');
    const rootLink = join(parent, 'project-link');
    await symlink(target, rootLink);
    await expectReject(() => buildSnapshotFromProject(rootLink), 'SNAPSHOT_SYMLINK_FORBIDDEN');
  });

  it('rejects hardlinks and sparse files', async () => {
    const hardlinkRoot = await temporaryProject();
    await writeFile(join(hardlinkRoot, 'a.txt'), 'same inode\n', 'utf8');
    await link(join(hardlinkRoot, 'a.txt'), join(hardlinkRoot, 'b.txt'));
    await expectReject(() => buildSnapshotFromProject(hardlinkRoot), 'SNAPSHOT_HARDLINK_FORBIDDEN');

    const sparseRoot = await temporaryProject();
    const sparse = await open(
      join(sparseRoot, 'sparse.txt'),
      constants.O_CREAT | constants.O_WRONLY,
      0o600,
    );
    await sparse.truncate(1024 * 1024);
    await sparse.close();
    await expectReject(
      () => buildSnapshotFromProject(sparseRoot),
      'SNAPSHOT_SPARSE_FILE_FORBIDDEN',
    );
  });

  it('rejects real FIFOs and Unix sockets as special files', async () => {
    const fifoRoot = await temporaryProject();
    // Node has no mkfifo API. The fixture uses the platform utility only to create a real inode.
    const { spawnSync } = await import('node:child_process');
    expect(spawnSync('/usr/bin/mkfifo', [join(fifoRoot, 'pipe')]).status).toBe(0);
    await expectReject(() => buildSnapshotFromProject(fifoRoot), 'SNAPSHOT_SPECIAL_FILE_FORBIDDEN');

    const socketRoot = await temporaryProject();
    const socketPath = join(socketRoot, 'service.sock');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expectReject(
        () => buildSnapshotFromProject(socketRoot),
        'SNAPSHOT_SPECIAL_FILE_FORBIDDEN',
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it.each([
    ['.env', 'SECRET=value\n'],
    ['.git/config', '[core]\n'],
    ['node_modules/pkg/index.js', 'module.exports = 1;\n'],
    ['.codex/auth.json', '{}\n'],
    ['.GITMODULES', '[submodule "synthetic"]\n'],
  ])('rejects blocked path %s', async (relativePath, contents) => {
    const root = await temporaryProject();
    const target = join(root, ...relativePath.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents, 'utf8');
    await expectReject(() => buildSnapshotFromProject(root), 'SNAPSHOT_PATH_BLOCKED');
  });

  it.each([
    ['private.pem', '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n'],
    ['github.txt', `ghp_${'A'.repeat(40)}\n`],
    ['jwt.txt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.signaturevalue\n'],
  ])(
    'rejects synthetic high-confidence secret in %s without echoing content',
    async (name, contents) => {
      const root = await temporaryProject();
      await writeFile(join(root, name), contents, 'utf8');
      try {
        await buildSnapshotFromProject(root);
        expect.fail('expected secret rejection');
      } catch (error) {
        expect(isSnapshotError(error, 'SNAPSHOT_SECRET_DETECTED')).toBe(true);
        expect(String(error)).not.toContain(contents.trim());
        expect(String(error)).not.toContain(root);
        expect(String(JSON.stringify((error as Error & { cause?: unknown }).cause))).not.toContain(
          root,
        );
      }
    },
  );

  it('accepts ordinary prose without a high-confidence credential shape', async () => {
    const root = await temporaryProject();
    await writeFile(
      join(root, 'notes.md'),
      'A token is a unit of model input. The synthetic label sk-short is not a credential.\n',
      'utf8',
    );
    await expect(buildSnapshotFromProject(root)).resolves.toMatchObject({ fileCount: 1 });
  });

  it.each([
    ['nul.txt', Buffer.from([0x61, 0, 0x62]), 'SNAPSHOT_NUL_FORBIDDEN'],
    ['binary.bin', Buffer.from([1, 2, 3, 4, 5, 0x41]), 'SNAPSHOT_BINARY_FILE'],
    ['c1.txt', Buffer.from('safe\u0085text', 'utf8'), 'SNAPSHOT_BINARY_FILE'],
    ['invalid.bin', Buffer.from([0xff, 0xfe, 0xfd]), 'SNAPSHOT_UTF8_REQUIRED'],
    [
      'lfs.txt',
      Buffer.from(
        'version https://git-lfs.github.com/spec/v1\noid sha256:0000000000000000000000000000000000000000000000000000000000000000\nsize 1\n',
      ),
      'SNAPSHOT_LFS_POINTER_FORBIDDEN',
    ],
  ] as const)('rejects hostile content %s', async (name, bytes, code) => {
    const root = await temporaryProject();
    await writeFile(join(root, name), bytes);
    await expectReject(() => buildSnapshotFromProject(root), code);
  });

  it('rejects a filesystem filename containing malformed UTF-8 at the OS or staging boundary', async () => {
    const root = await temporaryProject();
    const invalidPath = Buffer.concat([
      Buffer.from(`${root}/invalid-`, 'utf8'),
      Buffer.from([0xff]),
      Buffer.from('.txt', 'utf8'),
    ]);
    try {
      await writeFile(invalidPath, 'synthetic\n', 'utf8');
    } catch (error) {
      // macOS rejects the invalid byte sequence in the VFS boundary. Linux permits the
      // fixture and exercises the fatal TextDecoder path below.
      expect((error as NodeJS.ErrnoException).code).toBe('EILSEQ');
      return;
    }
    await expectReject(() => buildSnapshotFromProject(root), 'SNAPSHOT_UTF8_REQUIRED');
  });

  it('rejects NFC/NFD and case-fold path collisions', async () => {
    const unicodePaths = new SnapshotPathRegistry();
    unicodePaths.add('Cafe\u0301.txt');
    await expectReject(() => unicodePaths.add('Caf\u00e9.txt'), 'SNAPSHOT_UNICODE_COLLISION');
    await expectReject(
      () => createSnapshotManifest([manifestFile('README.md'), manifestFile('readme.md')]),
      'SNAPSHOT_CASE_COLLISION',
    );
  });

  it('detects inode replacement and append during staging', async () => {
    const replacementRoot = await temporaryProject();
    await writeFile(join(replacementRoot, 'facts.txt'), 'initial\n', 'utf8');
    await expectReject(
      () =>
        stageProject(replacementRoot, {
          onBoundary: async ({ phase, relativePath }) => {
            if (phase === 'after-file-stat' && relativePath === 'facts.txt') {
              await writeFile(join(replacementRoot, 'replacement'), 'changed\n', 'utf8');
              await rename(
                join(replacementRoot, 'replacement'),
                join(replacementRoot, 'facts.txt'),
              );
            }
          },
        }),
      'SNAPSHOT_SOURCE_CHANGED',
    );

    const appendRoot = await temporaryProject();
    await writeFile(join(appendRoot, 'facts.txt'), 'initial\n', 'utf8');
    await expectReject(
      () =>
        stageProject(appendRoot, {
          onBoundary: async ({ phase, relativePath }) => {
            if (phase === 'after-file-read' && relativePath === 'facts.txt') {
              await writeFile(join(appendRoot, 'facts.txt'), 'initial\nappended\n', 'utf8');
            }
          },
        }),
      'SNAPSHOT_SOURCE_CHANGED',
    );
  });

  it('detects truncate and a directory entry appearing after enumeration', async () => {
    const truncateRoot = await temporaryProject();
    await writeFile(join(truncateRoot, 'facts.txt'), 'long enough content\n', 'utf8');
    await expectReject(
      () =>
        stageProject(truncateRoot, {
          onBoundary: async ({ phase, relativePath }) => {
            if (phase === 'after-file-stat' && relativePath === 'facts.txt') {
              await truncate(join(truncateRoot, 'facts.txt'), 1);
            }
          },
        }),
      'SNAPSHOT_SOURCE_CHANGED',
    );

    const directoryRoot = await temporaryProject();
    await writeFile(join(directoryRoot, 'facts.txt'), 'stable\n', 'utf8');
    await expectReject(
      () =>
        stageProject(directoryRoot, {
          onBoundary: async ({ phase, relativePath }) => {
            if (phase === 'after-directory-enumeration' && relativePath === '') {
              await writeFile(join(directoryRoot, 'late.txt'), 'late\n', 'utf8');
            }
          },
        }),
      'SNAPSHOT_SOURCE_CHANGED',
    );
  });

  it('detects a same-size mutation between read chunks', async () => {
    const root = await temporaryProject();
    const target = join(root, 'large.txt');
    await writeFile(target, Buffer.alloc(160 * 1024, 0x61));
    let mutated = false;
    await expectReject(
      () =>
        stageProject(root, {
          onBoundary: async ({ phase, relativePath }) => {
            if (!mutated && phase === 'after-file-read-chunk' && relativePath === 'large.txt') {
              mutated = true;
              const bytes = Buffer.alloc(160 * 1024, 0x61);
              bytes.fill(0x62, 64 * 1024, 128 * 1024);
              await writeFile(target, bytes);
            }
          },
        }),
      'SNAPSHOT_SOURCE_CHANGED',
    );
  });

  it('rejects a root directory swapped to a symlink before any child read', async () => {
    const parent = await temporaryProject();
    const root = join(parent, 'project');
    const movedRoot = join(parent, 'project-old');
    const outside = await temporaryProject();
    await mkdir(root);
    await writeFile(join(root, 'facts.txt'), 'safe project bytes\n', 'utf8');
    await writeFile(join(outside, 'facts.txt'), 'HOST_CANARY_OUTSIDE\n', 'utf8');
    await expectReject(
      () =>
        stageProject(root, {
          onBoundary: async ({ phase, relativePath }) => {
            if (phase === 'after-directory-enumeration' && relativePath === '') {
              await rename(root, movedRoot);
              await symlink(outside, root);
            }
          },
        }),
      'SNAPSHOT_SOURCE_CHANGED',
    );
  });

  it('rejects a root symlink swap after admission but before the first root stat', async () => {
    const parent = await temporaryProject();
    const root = join(parent, 'project');
    const movedRoot = join(parent, 'project-old');
    const outside = await temporaryProject();
    await mkdir(root);
    await writeFile(join(root, 'facts.txt'), 'safe project bytes\n', 'utf8');
    await writeFile(join(outside, 'facts.txt'), 'HOST_CANARY_OUTSIDE\n', 'utf8');
    await expectReject(
      () =>
        stageProject(root, {
          onBoundary: async ({ phase }) => {
            if (phase === 'before-root-copy') {
              await rename(root, movedRoot);
              await symlink(outside, root);
            }
          },
        }),
      'SNAPSHOT_SOURCE_CHANGED',
    );
  });

  it('rejects a root directory swapped to another directory with the same filename', async () => {
    const parent = await temporaryProject();
    const root = join(parent, 'project');
    const movedRoot = join(parent, 'project-old');
    const replacement = join(parent, 'replacement');
    await mkdir(root);
    await mkdir(replacement);
    await writeFile(join(root, 'facts.txt'), 'safe project bytes\n', 'utf8');
    await writeFile(join(replacement, 'facts.txt'), 'replacement bytes\n', 'utf8');
    await expectReject(
      () =>
        stageProject(root, {
          onBoundary: async ({ phase, relativePath }) => {
            if (phase === 'after-directory-enumeration' && relativePath === '') {
              await rename(root, movedRoot);
              await rename(replacement, root);
            }
          },
        }),
      'SNAPSHOT_SOURCE_CHANGED',
    );
  });
});

describe('malicious archive corpus', () => {
  it('rejects non-canonical and duplicate-key manifest bytes before archive verification', async () => {
    const manifest = createSnapshotManifest([manifestFile('safe.txt')]);
    const canonical = snapshotManifestBytes(manifest).toString('utf8');
    const nonCanonical = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    const duplicate = Buffer.from(
      canonical.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      'utf8',
    );

    await expectReject(() => parseSnapshotManifest(nonCanonical), 'SNAPSHOT_ARCHIVE_INVALID');
    await expectReject(() => parseSnapshotManifest(duplicate), 'SNAPSHOT_ARCHIVE_INVALID');
  });

  it('reapplies content policy in the verifier instead of trusting the client manifest', async () => {
    const bytes = Buffer.from(`ghp_${'A'.repeat(40)}\n`, 'utf8');
    const manifest = createSnapshotManifest([
      {
        path: 'client-claimed-safe.txt',
        size: bytes.byteLength,
        mediaType: 'text/plain; charset=utf-8',
        sha256: sha256Hex(bytes),
      },
    ]);
    const manifestBytes = snapshotManifestBytes(manifest);
    const archiveBytes = compressDeterministicTar(
      createDeterministicTar([{ path: 'client-claimed-safe.txt', bytes }]),
    );
    await expectReject(
      () =>
        verifySnapshotArchive({
          manifestBytes,
          archiveBytes,
          expectedSnapshotDigest: snapshotDigest(manifest),
          expectedArchiveDigest: sha256Hex(archiveBytes),
        }),
      'SNAPSHOT_SECRET_DETECTED',
    );
  });

  it.each([
    ['../escape.txt', 'SNAPSHOT_INVALID_PATH'],
    ['/absolute.txt', 'SNAPSHOT_INVALID_PATH'],
    ['nested\\windows.txt', 'SNAPSHOT_INVALID_PATH'],
    ['a\u0000b.txt', 'SNAPSHOT_INVALID_PATH'],
    ['a\u0085b.txt', 'SNAPSHOT_INVALID_PATH'],
  ] as const)('rejects archive path %j', async (path, code) => {
    await expectReject(() => createDeterministicTar([{ path, bytes: Buffer.from('x') }]), code);
  });

  it.each(['../escape.txt', '/absolute.txt', 'nested\\windows.txt', 'a\u0085b.txt'])(
    'rejects a hand-crafted tar path %j in the verifier',
    async (path) => {
      const tar = createDeterministicTar([{ path: 'safe.txt', bytes: Buffer.from('safe\n') }]);
      const header = tar.subarray(0, 512);
      header.fill(0, 0, 100);
      Buffer.from(path, 'utf8').copy(header, 0);
      rewriteTarChecksum(header);
      const { parseDeterministicTar } = await import('../index.js');
      await expectReject(() => parseDeterministicTar(tar), 'SNAPSHOT_INVALID_PATH');
    },
  );

  it.each([
    ['1', 'SNAPSHOT_HARDLINK_FORBIDDEN'],
    ['2', 'SNAPSHOT_SYMLINK_FORBIDDEN'],
    ['3', 'SNAPSHOT_SPECIAL_FILE_FORBIDDEN'],
    ['4', 'SNAPSHOT_SPECIAL_FILE_FORBIDDEN'],
    ['5', 'SNAPSHOT_SPECIAL_FILE_FORBIDDEN'],
    ['6', 'SNAPSHOT_SPECIAL_FILE_FORBIDDEN'],
  ] as const)('rejects tar type %s', async (type, expectedCode) => {
    const tar = createDeterministicTar([{ path: 'safe.txt', bytes: Buffer.from('safe\n') }]);
    const modified = Buffer.from(tar);
    modified[156] = type.charCodeAt(0);
    rewriteTarChecksum(modified.subarray(0, 512));
    const archive = compressDeterministicTar(modified);
    try {
      const { decompressAndParseDeterministicArchive } = await import('../index.js');
      decompressAndParseDeterministicArchive(archive);
      expect.fail(`expected ${expectedCode}`);
    } catch (error) {
      const acceptedCodes: CreatorSnapshotErrorCode[] = [
        expectedCode,
        'SNAPSHOT_SPECIAL_FILE_FORBIDDEN',
      ];
      expect(acceptedCodes.some((code) => isSnapshotError(error, code))).toBe(true);
    }
  });

  it('rejects duplicate paths, trailing data and malformed checksum', async () => {
    await expectReject(
      () =>
        createDeterministicTar([
          { path: 'same.txt', bytes: Buffer.from('one') },
          { path: 'same.txt', bytes: Buffer.from('two') },
        ]),
      'SNAPSHOT_DUPLICATE_PATH',
    );

    const tar = createDeterministicTar([{ path: 'safe.txt', bytes: Buffer.from('safe\n') }]);
    const trailing = Buffer.concat([tar, Buffer.alloc(512)]);
    const malformed = Buffer.from(tar);
    malformed[0] = malformed[0]! ^ 1;
    const { parseDeterministicTar } = await import('../index.js');
    await expectReject(() => parseDeterministicTar(trailing), 'SNAPSHOT_ARCHIVE_INVALID');
    await expectReject(() => parseDeterministicTar(malformed), 'SNAPSHOT_ARCHIVE_INVALID');

    const duplicateTar = createDeterministicTar([
      { path: 'first.txt', bytes: Buffer.from('a') },
      { path: 'second.txt', bytes: Buffer.from('b') },
    ]);
    const secondHeader = duplicateTar.subarray(1_024, 1_536);
    secondHeader.fill(0, 0, 100);
    Buffer.from('first.txt', 'utf8').copy(secondHeader, 0);
    rewriteTarChecksum(secondHeader);
    await expectReject(() => parseDeterministicTar(duplicateTar), 'SNAPSHOT_DUPLICATE_PATH');
  });

  it('rejects non-canonical tar header padding even with a valid checksum', async () => {
    const tar = createDeterministicTar([{ path: 'safe.txt', bytes: Buffer.from('safe\n') }]);
    tar[90] = 0x58;
    rewriteTarChecksum(tar.subarray(0, 512));
    const { parseDeterministicTar } = await import('../index.js');
    await expectReject(() => parseDeterministicTar(tar), 'SNAPSHOT_ARCHIVE_INVALID');
  });

  it('rejects a PAX path over 512 UTF-8 bytes', async () => {
    const path512 = `${'a'.repeat(250)}/${'b'.repeat(250)}/${'c'.repeat(10)}`;
    const tar = createDeterministicTar([{ path: path512, bytes: Buffer.from('safe\n') }]);
    const header = tar.subarray(0, 512);
    const originalSize = Number.parseInt(header.subarray(124, 135).toString('ascii'), 8);
    const originalRecord = tar.subarray(512, 512 + originalSize).toString('utf8');
    const pathStart = originalRecord.indexOf(' path=') + 6;
    const changedRecord = paxRecord(`${originalRecord.slice(pathStart, -1)}d`);
    tar.fill(0, 512, 1_024);
    changedRecord.copy(tar, 512);
    writeTarOctal(header, 124, 12, changedRecord.byteLength);
    rewriteTarChecksum(header);
    const { parseDeterministicTar } = await import('../index.js');
    await expectReject(() => parseDeterministicTar(tar), 'SNAPSHOT_PATH_TOO_LONG');
  });

  it('bounds zstd expansion before tar parsing', async () => {
    const compressed = compressDeterministicTar(Buffer.alloc(2 * 1024 * 1024));
    await expectReject(
      () => decompressZstdWithLimit(compressed, 1024 * 1024),
      'SNAPSHOT_ARCHIVE_INVALID',
    );
  });
});

function manifestFile(path: string) {
  return {
    path,
    size: 1,
    mediaType: 'text/plain; charset=utf-8',
    sha256: sha256Hex(Buffer.from('x')),
  };
}

function rewriteTarChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.fill(0, offset, offset + length);
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function paxRecord(path: string): Buffer {
  const body = ` path=${path}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (true) {
    const candidate = Buffer.from(`${length}${body}`, 'utf8');
    if (candidate.byteLength === length) return candidate;
    length = candidate.byteLength;
  }
}
