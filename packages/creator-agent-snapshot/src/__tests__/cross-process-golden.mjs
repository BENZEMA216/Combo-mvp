import { Buffer } from 'node:buffer';
import process from 'node:process';

import {
  compressDeterministicTar,
  createDeterministicTar,
  createSnapshotManifest,
  sha256Hex,
  snapshotManifestBytes,
} from '../../dist/index.js';

const files = [
  { path: 'FACTS.md', bytes: Buffer.from('# Facts\nMarker ALPHA-4731.\n') },
  {
    path: 'nested/TABLE.csv',
    bytes: Buffer.from('name,value\nalpha,17\nbeta,29\n'),
  },
];
const manifest = createSnapshotManifest(
  files.map(({ path, bytes }) => ({
    path,
    size: bytes.byteLength,
    mediaType: path.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/csv; charset=utf-8',
    sha256: sha256Hex(bytes),
  })),
);
const manifestBytes = snapshotManifestBytes(manifest);
const tar = createDeterministicTar(files);
const archive = compressDeterministicTar(tar);
process.stdout.write(
  JSON.stringify({
    node: process.versions.node,
    zstd: process.versions.zstd,
    snapshotDigest: sha256Hex(manifestBytes),
    tarDigest: sha256Hex(tar),
    archiveDigest: sha256Hex(archive),
  }),
);
