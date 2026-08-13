import { extname } from 'node:path';
import { TextDecoder } from 'node:util';

import { fail } from './errors.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

const secretPatterns: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bASIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{30,255}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,255}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];

const sourceExtensions = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.m',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

function containsBinaryControl(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

function mediaTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.md' || extension === '.markdown') return 'text/markdown; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.csv') return 'text/csv; charset=utf-8';
  if (sourceExtensions.has(extension)) return 'text/plain; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

export type InspectedTextContent = Readonly<{
  mediaType: string;
  text: string;
}>;

export function inspectTextContent(path: string, bytes: Uint8Array): InspectedTextContent {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch (error) {
    fail('SNAPSHOT_UTF8_REQUIRED', error);
  }

  if (text.includes('\u0000')) fail('SNAPSHOT_NUL_FORBIDDEN');
  if (containsBinaryControl(text)) fail('SNAPSHOT_BINARY_FILE');
  if (text.startsWith('version https://git-lfs.github.com/spec/v1\n')) {
    fail('SNAPSHOT_LFS_POINTER_FORBIDDEN');
  }
  if (secretPatterns.some((pattern) => pattern.test(text))) fail('SNAPSHOT_SECRET_DETECTED');

  const mediaType = mediaTypeForPath(path);
  if (mediaType.startsWith('application/json')) {
    try {
      JSON.parse(text);
    } catch (error) {
      fail('SNAPSHOT_WRONG_FILE_TYPE', error);
    }
  }
  return { mediaType, text };
}
