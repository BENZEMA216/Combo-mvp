import { fstatSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

/**
 * Checks the best path-to-fd binding Node exposes without openat(2).
 * Callers still need their own immutable source signature comparison.
 */
export function isFileDescriptorBoundToCanonicalProjectPath(
  canonicalProjectRoot: string,
  lexicalFilename: string,
  descriptor: number,
): boolean {
  try {
    const resolvedFilename = realpathSync(lexicalFilename);
    const relativeFilename = relative(canonicalProjectRoot, resolvedFilename);
    if (
      resolvedFilename !== lexicalFilename ||
      relativeFilename.length === 0 ||
      relativeFilename === '..' ||
      relativeFilename.startsWith(`..${sep}`) ||
      isAbsolute(relativeFilename)
    ) {
      return false;
    }
    const opened = fstatSync(descriptor, { bigint: true });
    const lexical = lstatSync(lexicalFilename, { bigint: true });
    return (
      opened.isFile() &&
      lexical.isFile() &&
      opened.dev === lexical.dev &&
      opened.ino === lexical.ino
    );
  } catch {
    return false;
  }
}
