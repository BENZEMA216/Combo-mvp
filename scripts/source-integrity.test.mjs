import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const textExtensions = new Set([
  '.c',
  '.css',
  '.csv',
  '.graphql',
  '.html',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.md',
  '.mjs',
  '.mts',
  '.prisma',
  '.py',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);
const textNames = new Set([
  '.dockerignore',
  '.editorconfig',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  'Dockerfile',
  'LICENSE',
  'Makefile',
]);

test('tracked source and configuration files contain no NUL bytes', async () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((path) => textExtensions.has(extname(path)) || textNames.has(basename(path)));
  const invalid = [];
  for (const path of tracked) {
    if ((await readFile(join(repo, path))).includes(0)) invalid.push(path);
  }
  assert.deepEqual(invalid, [], 'tracked text files with NUL bytes');
});
