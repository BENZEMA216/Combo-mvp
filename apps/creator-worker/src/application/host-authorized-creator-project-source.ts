import { lstatSync } from 'node:fs';

import {
  ProjectContextIndexError,
  scanCreatorProjectSourceContextWithHooks,
  type ProjectContextIndexProgress,
  type ProjectContextScan,
} from '../project-context-index.js';

export type HostAuthorizedCreatorProjectSource = Readonly<{
  canonicalPath: string;
  device: bigint;
  inode: bigint;
}>;

export type HostAuthorizedCreatorProjectLease = Readonly<{
  source: HostAuthorizedCreatorProjectSource;
  /**
   * Synchronous local adapter check for the ambient Host dispatch and workspace generation.
   * A future cross-process adapter must implement this with authenticated state or replace the
   * lease with a Host-opened directory descriptor; this function is not an IPC wire contract.
   */
  assertCurrent(): void;
}>;

/**
 * Binds Host authority at the scanner's first directory-read boundary. The scanner then keeps
 * checking that exact root and every opened descendant through content scan and revalidation.
 */
export function scanHostAuthorizedCreatorProjectSourceContext(
  path: string,
  lease: HostAuthorizedCreatorProjectLease,
  onProgress?: (progress: ProjectContextIndexProgress) => void,
): ProjectContextScan {
  return scanCreatorProjectSourceContextWithHooks(path, {
    ...(onProgress === undefined ? {} : { onProgress }),
    beforeDirectoryRead: (relativePath) => {
      if (relativePath !== '') return;
      try {
        lease.assertCurrent();
        const expected = lease.source;
        const observed = lstatSync(path, { bigint: true });
        if (
          path !== expected.canonicalPath ||
          !observed.isDirectory() ||
          observed.dev !== expected.device ||
          observed.ino !== expected.inode
        ) {
          throw new TypeError('Creator Project identity differs from Host authorization.');
        }
      } catch {
        throw new ProjectContextIndexError(
          'PROJECT_CONTEXT_CHANGED',
          'Creator Project identity changed before its first authorized read.',
        );
      }
    },
  });
}
