import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { sha256Hex } from './digest.js';
import { fail } from './errors.js';
import { SnapshotPathRegistry, canonicalizeSnapshotPath, utf8ByteCompare } from './path-policy.js';
import {
  ALPHA_SNAPSHOT_POLICY,
  DETERMINISTIC_ZSTD_LEVEL,
  MAX_DECOMPRESSED_TAR_BYTES,
  REQUIRED_ZSTD_VERSION,
} from './policy.js';

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;

function assertPinnedZstdRuntime(): void {
  const zstdVersion = (process.versions as Record<string, string | undefined>).zstd;
  if (zstdVersion !== REQUIRED_ZSTD_VERSION) fail('SNAPSHOT_ARCHIVE_INVALID');
}

export type ArchiveFile = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

export type ParsedArchiveFile = Readonly<{
  path: string;
  bytes: Buffer;
}>;

function writeBytes(target: Buffer, offset: number, length: number, value: Uint8Array): void {
  if (value.byteLength > length) fail('SNAPSHOT_ARCHIVE_INVALID');
  Buffer.from(value).copy(target, offset);
}

function writeString(target: Buffer, offset: number, length: number, value: string): void {
  writeBytes(target, offset, length, Buffer.from(value, 'utf8'));
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail('SNAPSHOT_ARCHIVE_INVALID');
  const encoded = value.toString(8);
  if (encoded.length > length - 1) fail('SNAPSHOT_ARCHIVE_INVALID');
  writeString(target, offset, length, `${encoded.padStart(length - 1, '0')}\0`);
}

function tarChecksum(header: Buffer): number {
  let checksum = 0;
  for (let index = 0; index < header.length; index += 1) {
    checksum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return checksum;
}

function finalizeChecksum(header: Buffer): void {
  const encoded = tarChecksum(header).toString(8).padStart(6, '0');
  if (encoded.length !== 6) fail('SNAPSHOT_ARCHIVE_INVALID');
  writeString(header, 148, 8, `${encoded}\0 `);
}

function splitUstarPath(path: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { name: path, prefix: '' };
  const slashIndexes: number[] = [];
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === '/') slashIndexes.push(index);
  }
  for (let index = slashIndexes.length - 1; index >= 0; index -= 1) {
    const split = slashIndexes[index]!;
    const prefix = path.slice(0, split);
    const name = path.slice(split + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix };
    }
  }
  return undefined;
}

function createHeader(options: {
  path: string;
  size: number;
  type: '0' | 'x';
  prefix?: string;
}): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  writeString(header, 0, 100, options.path);
  writeOctal(header, 100, 8, 0o444);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, options.size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, options.type);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  if (options.prefix !== undefined) writeString(header, 345, 155, options.prefix);
  finalizeChecksum(header);
  return header;
}

function paddedBlock(bytes: Uint8Array): Buffer {
  const paddedLength = Math.ceil(bytes.byteLength / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  const output = Buffer.alloc(paddedLength);
  Buffer.from(bytes).copy(output);
  return output;
}

function paxPathRecord(path: string): Buffer {
  const body = ` path=${path}\n`;
  let length = Buffer.byteLength(body, 'utf8') + 1;
  while (true) {
    const candidate = `${length}${body}`;
    const actualLength = Buffer.byteLength(candidate, 'utf8');
    if (actualLength === length) return Buffer.from(candidate, 'utf8');
    length = actualLength;
  }
}

function appendEntry(chunks: Buffer[], file: ArchiveFile): void {
  const direct = splitUstarPath(file.path);
  if (direct !== undefined) {
    chunks.push(
      createHeader({
        path: direct.name,
        prefix: direct.prefix,
        size: file.bytes.byteLength,
        type: '0',
      }),
      paddedBlock(file.bytes),
    );
    return;
  }

  const pathHash = sha256Hex(Buffer.from(file.path, 'utf8')).slice(0, 32);
  const pax = paxPathRecord(file.path);
  chunks.push(
    createHeader({ path: `PaxHeaders/${pathHash}`, size: pax.byteLength, type: 'x' }),
    paddedBlock(pax),
    createHeader({ path: `PaxFiles/${pathHash}`, size: file.bytes.byteLength, type: '0' }),
    paddedBlock(file.bytes),
  );
}

export function createDeterministicTar(inputFiles: readonly ArchiveFile[]): Buffer {
  if (inputFiles.length === 0) fail('SNAPSHOT_EMPTY');
  if (inputFiles.length > ALPHA_SNAPSHOT_POLICY.maxFileCount) fail('SNAPSHOT_TOO_MANY_FILES');
  const registry = new SnapshotPathRegistry();
  let expandedBytes = 0;
  const files = inputFiles
    .map((file) => {
      const path = registry.add(file.path);
      if (path !== file.path) fail('SNAPSHOT_ARCHIVE_INVALID');
      if (file.bytes.byteLength > ALPHA_SNAPSHOT_POLICY.maxFileBytes) {
        fail('SNAPSHOT_FILE_TOO_LARGE');
      }
      expandedBytes += file.bytes.byteLength;
      if (expandedBytes > ALPHA_SNAPSHOT_POLICY.maxExpandedBytes) {
        fail('SNAPSHOT_EXPANDED_TOO_LARGE');
      }
      return { path, bytes: Buffer.from(file.bytes) };
    })
    .sort((left, right) => utf8ByteCompare(left.path, right.path));

  const chunks: Buffer[] = [];
  for (const file of files) appendEntry(chunks, file);
  chunks.push(Buffer.alloc(TAR_END_BYTES));
  return Buffer.concat(chunks);
}

export function compressDeterministicTar(tarBytes: Uint8Array): Buffer {
  assertPinnedZstdRuntime();
  return zstdCompressSync(tarBytes, {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: DETERMINISTIC_ZSTD_LEVEL,
      [zlibConstants.ZSTD_c_checksumFlag]: 1,
      [zlibConstants.ZSTD_c_contentSizeFlag]: 1,
      [zlibConstants.ZSTD_c_dictIDFlag]: 0,
      [zlibConstants.ZSTD_c_nbWorkers]: 0,
    },
  });
}

export function assertCompressedArchiveLimits(
  compressedBytes: number,
  expandedFileBytes: number,
): void {
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes <= 0) {
    fail('SNAPSHOT_ARCHIVE_INVALID');
  }
  if (compressedBytes > ALPHA_SNAPSHOT_POLICY.maxCompressedBytes) {
    fail('SNAPSHOT_COMPRESSED_TOO_LARGE');
  }
  if (!Number.isSafeInteger(expandedFileBytes) || expandedFileBytes < 0) {
    fail('SNAPSHOT_ARCHIVE_INVALID');
  }
  if (expandedFileBytes > ALPHA_SNAPSHOT_POLICY.maxExpandedBytes) {
    fail('SNAPSHOT_EXPANDED_TOO_LARGE');
  }
  if (expandedFileBytes > compressedBytes * ALPHA_SNAPSHOT_POLICY.maxCompressionRatio) {
    fail('SNAPSHOT_COMPRESSION_RATIO_EXCEEDED');
  }
}

export function decompressZstdWithLimit(archiveBytes: Uint8Array, maxOutputLength: number): Buffer {
  assertPinnedZstdRuntime();
  if (
    archiveBytes.byteLength <= 0 ||
    archiveBytes.byteLength > ALPHA_SNAPSHOT_POLICY.maxCompressedBytes ||
    !Number.isSafeInteger(maxOutputLength) ||
    maxOutputLength <= 0
  ) {
    fail('SNAPSHOT_ARCHIVE_INVALID');
  }
  try {
    return zstdDecompressSync(archiveBytes, { maxOutputLength });
  } catch (error) {
    fail('SNAPSHOT_ARCHIVE_INVALID', error);
  }
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

function readNullTerminatedString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  const bytes = zero === -1 ? field : field.subarray(0, zero);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    fail('SNAPSHOT_ARCHIVE_INVALID', error);
  }
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length).toString('ascii');
  if (!/^[0-7]+\0$/u.test(field)) fail('SNAPSHOT_ARCHIVE_INVALID');
  const value = Number.parseInt(field.slice(0, -1), 8);
  if (!Number.isSafeInteger(value)) fail('SNAPSHOT_ARCHIVE_INVALID');
  return value;
}

function assertCanonicalHeader(header: Buffer): void {
  if (header.subarray(257, 263).toString('binary') !== 'ustar\0') fail('SNAPSHOT_ARCHIVE_INVALID');
  if (header.subarray(263, 265).toString('ascii') !== '00') fail('SNAPSHOT_ARCHIVE_INVALID');
  if (readOctal(header, 100, 8) !== 0o444) fail('SNAPSHOT_ARCHIVE_INVALID');
  if (readOctal(header, 108, 8) !== 0 || readOctal(header, 116, 8) !== 0) {
    fail('SNAPSHOT_ARCHIVE_INVALID');
  }
  if (readOctal(header, 136, 12) !== 0) fail('SNAPSHOT_ARCHIVE_INVALID');
  const storedChecksum = header.subarray(148, 154).toString('ascii');
  if (!/^[0-7]{6}$/u.test(storedChecksum)) fail('SNAPSHOT_ARCHIVE_INVALID');
  if (header[154] !== 0 || header[155] !== 0x20) fail('SNAPSHOT_ARCHIVE_INVALID');
  if (Number.parseInt(storedChecksum, 8) !== tarChecksum(header)) fail('SNAPSHOT_ARCHIVE_INVALID');
  if (!isZeroBlock(header.subarray(157, 257))) fail('SNAPSHOT_ARCHIVE_INVALID');
  if (!isZeroBlock(header.subarray(265, 345))) fail('SNAPSHOT_ARCHIVE_INVALID');
  if (!isZeroBlock(header.subarray(500, 512))) fail('SNAPSHOT_ARCHIVE_INVALID');
}

function assertExactHeader(header: Buffer, expected: Buffer): void {
  if (!header.equals(expected)) fail('SNAPSHOT_ARCHIVE_INVALID');
}

function parsePaxPath(bytes: Buffer): string {
  const split = bytes.indexOf(0x20);
  if (split <= 0) fail('SNAPSHOT_ARCHIVE_INVALID');
  const lengthText = bytes.subarray(0, split).toString('ascii');
  if (!/^[1-9][0-9]*$/u.test(lengthText)) fail('SNAPSHOT_ARCHIVE_INVALID');
  if (Number.parseInt(lengthText, 10) !== bytes.byteLength) fail('SNAPSHOT_ARCHIVE_INVALID');
  const body = bytes.subarray(split + 1);
  if (body.byteLength < 7 || body.at(-1) !== 0x0a) fail('SNAPSHOT_ARCHIVE_INVALID');
  if (body.subarray(0, 5).toString('ascii') !== 'path=') fail('SNAPSHOT_ARCHIVE_INVALID');
  const pathBytes = body.subarray(5, -1);
  let path: string;
  try {
    path = new TextDecoder('utf-8', { fatal: true }).decode(pathBytes);
  } catch (error) {
    fail('SNAPSHOT_ARCHIVE_INVALID', error);
  }
  return canonicalizeSnapshotPath(path);
}

export function parseDeterministicTar(tarBytes: Uint8Array): readonly ParsedArchiveFile[] {
  const tar = Buffer.from(tarBytes);
  if (tar.byteLength < TAR_END_BYTES || tar.byteLength % TAR_BLOCK_BYTES !== 0) {
    fail('SNAPSHOT_ARCHIVE_INVALID');
  }

  const files: ParsedArchiveFile[] = [];
  const registry = new SnapshotPathRegistry();
  let offset = 0;
  let pendingPaxPath: string | undefined;
  let foundEnd = false;
  let expandedBytes = 0;

  while (offset < tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      const second = tar.subarray(offset + TAR_BLOCK_BYTES, offset + TAR_END_BYTES);
      if (second.byteLength !== TAR_BLOCK_BYTES || !isZeroBlock(second)) {
        fail('SNAPSHOT_ARCHIVE_INVALID');
      }
      if (offset + TAR_END_BYTES !== tar.byteLength) fail('SNAPSHOT_ARCHIVE_INVALID');
      foundEnd = true;
      break;
    }

    assertCanonicalHeader(header);
    const type = String.fromCharCode(header[156]!);
    if (type !== '0' && type !== 'x') {
      if (type === '1') fail('SNAPSHOT_HARDLINK_FORBIDDEN');
      if (type === '2') fail('SNAPSHOT_SYMLINK_FORBIDDEN');
      fail('SNAPSHOT_SPECIAL_FILE_FORBIDDEN');
    }
    const size = readOctal(header, 124, 12);
    const dataStart = offset + TAR_BLOCK_BYTES;
    const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + paddedSize;
    if (dataEnd > tar.byteLength || nextOffset > tar.byteLength) fail('SNAPSHOT_ARCHIVE_INVALID');
    if (!isZeroBlock(tar.subarray(dataEnd, nextOffset))) fail('SNAPSHOT_ARCHIVE_INVALID');

    const name = readNullTerminatedString(header, 0, 100);
    const prefix = readNullTerminatedString(header, 345, 155);
    const headerPath = prefix.length > 0 ? `${prefix}/${name}` : name;
    const data = tar.subarray(dataStart, dataEnd);

    if (type === 'x') {
      if (pendingPaxPath !== undefined || !/^PaxHeaders\/[0-9a-f]{32}$/u.test(headerPath)) {
        fail('SNAPSHOT_ARCHIVE_INVALID');
      }
      pendingPaxPath = parsePaxPath(data);
      const expectedHeader = `PaxHeaders/${sha256Hex(Buffer.from(pendingPaxPath, 'utf8')).slice(0, 32)}`;
      if (headerPath !== expectedHeader) fail('SNAPSHOT_ARCHIVE_INVALID');
      assertExactHeader(
        header,
        createHeader({ path: expectedHeader, size: data.byteLength, type: 'x' }),
      );
    } else {
      let path: string;
      if (pendingPaxPath !== undefined) {
        path = pendingPaxPath;
        if (splitUstarPath(path) !== undefined) fail('SNAPSHOT_ARCHIVE_INVALID');
        const expectedFile = `PaxFiles/${sha256Hex(Buffer.from(path, 'utf8')).slice(0, 32)}`;
        if (headerPath !== expectedFile) fail('SNAPSHOT_ARCHIVE_INVALID');
        assertExactHeader(
          header,
          createHeader({ path: expectedFile, size: data.byteLength, type: '0' }),
        );
        pendingPaxPath = undefined;
      } else {
        path = canonicalizeSnapshotPath(headerPath);
        if (path !== headerPath) fail('SNAPSHOT_ARCHIVE_INVALID');
        const direct = splitUstarPath(path);
        if (direct === undefined) fail('SNAPSHOT_ARCHIVE_INVALID');
        assertExactHeader(
          header,
          createHeader({
            path: direct.name,
            prefix: direct.prefix,
            size: data.byteLength,
            type: '0',
          }),
        );
      }
      registry.add(path);
      if (size > ALPHA_SNAPSHOT_POLICY.maxFileBytes) fail('SNAPSHOT_FILE_TOO_LARGE');
      expandedBytes += size;
      if (expandedBytes > ALPHA_SNAPSHOT_POLICY.maxExpandedBytes) {
        fail('SNAPSHOT_EXPANDED_TOO_LARGE');
      }
      if (files.length >= ALPHA_SNAPSHOT_POLICY.maxFileCount) fail('SNAPSHOT_TOO_MANY_FILES');
      files.push(Object.freeze({ path, bytes: Buffer.from(data) }));
    }
    offset = nextOffset;
  }

  if (!foundEnd || pendingPaxPath !== undefined || files.length === 0) {
    fail('SNAPSHOT_ARCHIVE_INVALID');
  }
  for (let index = 1; index < files.length; index += 1) {
    if (utf8ByteCompare(files[index - 1]!.path, files[index]!.path) >= 0) {
      fail('SNAPSHOT_ARCHIVE_INVALID');
    }
  }
  return Object.freeze(files);
}

export function decompressAndParseDeterministicArchive(
  archiveBytes: Uint8Array,
): readonly ParsedArchiveFile[] {
  return parseDeterministicTar(decompressZstdWithLimit(archiveBytes, MAX_DECOMPRESSED_TAR_BYTES));
}
