import {
  CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  parseCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import type { ImmutableObjectStore } from '../../platform/infra/object-store.js';
import { TransferDigest, TransferFailure } from './transfer-contract.js';

export const PUBLIC_PACKAGE_MAX_BYTES = 524_288;
export type PublicPackage = {
  manifestText: string;
  packageDigest: string;
  files: readonly { path: string; text: string }[];
};
const bucket = 'combo-artifacts' as const;
function key(digest: string, path: string) {
  TransferDigest.parse(digest);
  if (
    path !== 'agent.json' &&
    !/^(?:AGENT\.md|skills\/[a-z0-9][a-z0-9-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,79})+)$/u.test(
      path,
    )
  ) {
    throw new TransferFailure('validation');
  }
  return `agent-packages/sha256/${digest.slice(7)}/${path}`;
}
export function verifyPublicPackage(candidate: PublicPackage) {
  try {
    const manifest = parseCreatorAgentPackageManifest(candidate.manifestText);
    if (
      digestCreatorAgentPackage(manifest) !== candidate.packageDigest ||
      candidate.files.length !== manifest.files.length
    )
      throw new Error('binding');
    const supplied = new Map(candidate.files.map((file) => [file.path, file.text]));
    if (supplied.size !== candidate.files.length) throw new Error('duplicate');
    let bytes = Buffer.byteLength(candidate.manifestText, 'utf8');
    for (const expected of manifest.files) {
      const text = supplied.get(expected.path);
      if (text === undefined) throw new Error('missing');
      const content = Buffer.from(text, 'utf8');
      bytes += content.length;
      if (
        content.length !== expected.byteLength ||
        digestCreatorAgentPackageFile(content) !== expected.digest
      ) {
        throw new Error('content');
      }
      key(candidate.packageDigest, expected.path);
    }
    if (bytes > PUBLIC_PACKAGE_MAX_BYTES) throw new Error('too large');
    return manifest;
  } catch {
    throw new TransferFailure('unavailable');
  }
}

/** Commit every declared exact file before the manifest; no DB marker exists until readback passes. */
export async function commitPublicPackage(
  objects: ImmutableObjectStore,
  candidate: PublicPackage,
  signal?: AbortSignal,
) {
  const manifest = verifyPublicPackage(candidate);
  const files = [
    ...manifest.files.map(({ path }) => candidate.files.find((file) => file.path === path)!),
    { path: 'agent.json', text: candidate.manifestText },
  ];
  try {
    for (const file of files) {
      const bytes = Buffer.from(file.text, 'utf8');
      const input = {
        bucket,
        key: key(candidate.packageDigest, file.path),
        maxBytes: bytes.length,
        ...(signal ? { signal } : {}),
      };
      await objects.commit({
        ...input,
        bytes,
        contentType: file.path.endsWith('.json')
          ? 'application/json'
          : 'text/markdown; charset=utf-8',
      });
      if (!Buffer.from(await objects.read(input)).equals(bytes))
        throw new TransferFailure('unavailable');
    }
  } catch {
    throw new TransferFailure('unavailable');
  }
}

export async function readPublicPackage(
  objects: ImmutableObjectStore,
  packageDigest: string,
  signal?: AbortSignal,
): Promise<PublicPackage> {
  try {
    TransferDigest.parse(packageDigest);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const manifestText = decoder.decode(
      await objects.read({
        bucket,
        key: key(packageDigest, 'agent.json'),
        maxBytes: CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES,
        ...(signal ? { signal } : {}),
      }),
    );
    const manifest = parseCreatorAgentPackageManifest(manifestText);
    if (
      digestCreatorAgentPackage(manifest) !== packageDigest ||
      manifest.files.length > 31 ||
      manifest.files.reduce(
        (total, file) => total + file.byteLength,
        Buffer.byteLength(manifestText, 'utf8'),
      ) > PUBLIC_PACKAGE_MAX_BYTES
    ) {
      throw new TransferFailure('unavailable');
    }
    const files = [];
    for (const file of manifest.files) {
      const bytes = await objects.read({
        bucket,
        key: key(packageDigest, file.path),
        maxBytes: file.byteLength,
        ...(signal ? { signal } : {}),
      });
      if (bytes.length !== file.byteLength || digestCreatorAgentPackageFile(bytes) !== file.digest)
        throw new TransferFailure('unavailable');
      files.push({ path: file.path, text: decoder.decode(bytes) });
    }
    const candidate = { manifestText, packageDigest, files };
    verifyPublicPackage(candidate);
    return candidate;
  } catch {
    throw new TransferFailure('unavailable');
  }
}
