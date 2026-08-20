import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

export async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(packageRoot, 'fixtures', name), 'utf8')) as unknown;
}

export async function readFixtureText(name: string): Promise<string> {
  return readFile(join(packageRoot, 'fixtures', name), 'utf8');
}
