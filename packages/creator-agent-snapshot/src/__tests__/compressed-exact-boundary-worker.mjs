import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { constants as zlibConstants, zstdDecompressSync } from 'node:zlib';

import {
  MAX_DECOMPRESSED_TAR_BYTES,
  REQUIRED_ZSTD_VERSION,
  ZSTD_SYNC_ALIAS_RETRY_OUTPUT_CHUNK_BYTES,
  buildSnapshotFromProject,
  compressDeterministicTar,
  createDeterministicTar,
  createSnapshotManifest,
  inspectTextContent,
  isSnapshotError,
  parseDeterministicTar,
  snapshotManifestBytes,
  verifySnapshotArchive,
} from '../../dist/index.js';

const fixtureUrl = new URL(
  '../../../creator-agent-protocol/fixtures/snapshot-compressed-exact-boundary.v1.json',
  import.meta.url,
);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const delta = Number.parseInt(process.argv[2] ?? '', 10);
const probe = fixture.probes.find((candidate) => candidate.delta === delta);

assert.equal(fixture.protocol, 'combo.snapshot-compressed-exact-boundary/1');
assert.equal(process.versions.zstd, REQUIRED_ZSTD_VERSION);
assert.equal(
  zlibConstants.Z_DEFAULT_CHUNK,
  fixture.canonicalArchivePolicy.nodeSyncWrapper.primaryOutputChunkBytes,
);
assert.equal(
  ZSTD_SYNC_ALIAS_RETRY_OUTPUT_CHUNK_BYTES,
  fixture.canonicalArchivePolicy.nodeSyncWrapper.aliasRetryOutputChunkBytes,
);
assert.ok(probe, `unknown SNP-008 delta ${delta}`);

const alphabet = Buffer.from(fixture.generator.alphabet, 'ascii');
const seedSeparator = String.fromCharCode(0);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function generatedFile(index, bytes) {
  const output = createHash('shake256', { outputLength: bytes })
    .update(`${fixture.generator.seedPrefix}${seedSeparator}${index}`)
    .digest();
  for (let offset = 0; offset < output.byteLength; offset += 1) {
    output[offset] = alphabet[output[offset] & 31];
  }
  return {
    path: fixture.generator.pathTemplate.replace('{index}', index),
    bytes: output,
  };
}

function assertSingleFrame(archiveBytes, tarBytes) {
  assert.equal(archiveBytes.readUInt32LE(0), 0xfd2fb528, 'zstd magic');
  assert.equal(archiveBytes[4], 0x84, 'pinned frame descriptor');
  assert.equal(archiveBytes[5], 0x60, 'pinned window descriptor');
  assert.equal(archiveBytes.readUInt32LE(6), tarBytes, 'zstd content size');

  let offset = 10;
  let blocks = 0;
  while (true) {
    assert.ok(offset + 3 <= archiveBytes.byteLength, 'truncated zstd block header');
    const header =
      archiveBytes[offset] | (archiveBytes[offset + 1] << 8) | (archiveBytes[offset + 2] << 16);
    offset += 3;
    const last = (header & 1) === 1;
    const type = (header >> 1) & 3;
    const logicalSize = header >>> 3;
    assert.notEqual(type, 3, 'reserved zstd block type');
    const storedSize = type === 1 ? 1 : logicalSize;
    assert.ok(offset + storedSize <= archiveBytes.byteLength, 'truncated zstd block');
    offset += storedSize;
    blocks += 1;
    if (last) break;
  }
  assert.equal(offset + 4, archiveBytes.byteLength, 'archive must contain exactly one frame');
  return blocks;
}

function expectSnapshotCode(action, code) {
  let caught;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(isSnapshotError(caught, code), `expected ${code}`);
}

async function expectSnapshotCodeAsync(action, code) {
  let caught;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(isSnapshotError(caught, code), `expected ${code}`);
}

let files = fixture.generator.commonFiles.map((file) => {
  const generated = generatedFile(file.index, file.bytes);
  assert.equal(sha256(generated.bytes), file.sha256, `file ${file.index}`);
  return generated;
});
const tail = generatedFile(probe.tailFile.index, probe.tailFile.bytes);
for (const patch of probe.tailFile.patches) {
  assert.equal(String.fromCharCode(tail.bytes[patch.offset]), patch.from, 'patch preimage');
  tail.bytes[patch.offset] = patch.to.charCodeAt(0);
}
assert.equal(sha256(tail.bytes), probe.tailFile.sha256, 'tail file');
files.push(tail);

for (const file of files) {
  assert.equal(inspectTextContent(file.path, file.bytes).mediaType, fixture.generator.mediaType);
}

const projectRoot = await mkdtemp(join(tmpdir(), `combo-snp008-${delta}-`));
let builderResult;
let verifierResult;
try {
  for (const file of files) {
    const destination = join(projectRoot, file.path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, file.bytes);
  }

  {
    const manifest = createSnapshotManifest(
      files.map((file) => ({
        path: file.path,
        size: file.bytes.byteLength,
        mediaType: inspectTextContent(file.path, file.bytes).mediaType,
        sha256: sha256(file.bytes),
      })),
    );
    const manifestBytes = snapshotManifestBytes(manifest);
    const tarBytes = createDeterministicTar(files);
    const archiveBytes = compressDeterministicTar(tarBytes);

    assert.equal(
      files.reduce((total, file) => total + file.bytes.byteLength, 0),
      probe.expandedBytes,
    );
    assert.equal(manifestBytes.byteLength, probe.manifest.bytes);
    assert.equal(sha256(manifestBytes), probe.manifest.sha256);
    assert.equal(tarBytes.byteLength, probe.tar.bytes);
    assert.equal(sha256(tarBytes), probe.tar.sha256);
    assert.equal(archiveBytes.byteLength, probe.archive.bytes);
    assert.equal(sha256(archiveBytes), probe.archive.sha256);
    assert.equal(assertSingleFrame(archiveBytes, tarBytes.byteLength), 629);

    if (probe.expected === 'accepted') {
      const verified = verifySnapshotArchive({
        manifestBytes,
        archiveBytes,
        expectedSnapshotDigest: probe.manifest.sha256,
        expectedArchiveDigest: probe.archive.sha256,
      });
      assert.equal(verified.compressedBytes, probe.archive.bytes);
      assert.equal(verified.expandedBytes, probe.expandedBytes);
      assert.equal(verified.fileCount, files.length);
      verifierResult = 'accepted';
    } else {
      const rawTar = zstdDecompressSync(archiveBytes, {
        maxOutputLength: MAX_DECOMPRESSED_TAR_BYTES,
      });
      assert.deepEqual(rawTar, tarBytes, 'raw zstd round trip');
      const parsedFiles = parseDeterministicTar(rawTar);
      const rebuiltTar = createDeterministicTar(parsedFiles);
      assert.deepEqual(rebuiltTar, tarBytes, 'production tar round trip');
      assert.deepEqual(
        compressDeterministicTar(rebuiltTar),
        archiveBytes,
        'production canonical recompression',
      );
      expectSnapshotCode(
        () =>
          verifySnapshotArchive({
            manifestBytes,
            archiveBytes,
            expectedSnapshotDigest: probe.manifest.sha256,
            expectedArchiveDigest: probe.archive.sha256,
          }),
        'SNAPSHOT_COMPRESSED_TOO_LARGE',
      );
      verifierResult = 'SNAPSHOT_COMPRESSED_TOO_LARGE';
    }
  }

  files = [];
  globalThis.gc?.();

  if (probe.expected === 'accepted') {
    const built = await buildSnapshotFromProject(projectRoot);
    assert.equal(built.compressedBytes, probe.archive.bytes);
    assert.equal(built.archiveDigest, probe.archive.sha256);
    assert.equal(built.snapshotDigest, probe.manifest.sha256);
    assert.equal(built.expandedBytes, probe.expandedBytes);
    const verified = verifySnapshotArchive({
      manifestBytes: built.manifestBytes,
      archiveBytes: built.archiveBytes,
      expectedSnapshotDigest: built.snapshotDigest,
      expectedArchiveDigest: built.archiveDigest,
    });
    assert.equal(verified.compressedBytes, probe.archive.bytes);
    builderResult = 'accepted';
  } else {
    await expectSnapshotCodeAsync(
      () => buildSnapshotFromProject(projectRoot),
      'SNAPSHOT_COMPRESSED_TOO_LARGE',
    );
    builderResult = 'SNAPSHOT_COMPRESSED_TOO_LARGE';
  }

  assert.equal(builderResult, probe.builder);
  assert.equal(verifierResult, probe.verifier);

  process.stdout.write(
    `${JSON.stringify({
      protocol: fixture.protocol,
      caseId: fixture.authority.testPlanCase,
      delta,
      archiveBytes: probe.archive.bytes,
      archiveDigest: probe.archive.sha256,
      manifestDigest: probe.manifest.sha256,
      builder: builderResult,
      verifier: verifierResult,
    })}\n`,
  );
} finally {
  await rm(projectRoot, { recursive: true, force: true });
}
