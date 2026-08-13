import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { createJsonSchemaBundle, createOpenApiDocument } from '../dist/artifacts.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const render = (value) =>
  format(JSON.stringify(value), { parser: 'json', printWidth: 100, tabWidth: 2, endOfLine: 'lf' });
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

await mkdir(join(packageRoot, 'schemas'), { recursive: true });
await mkdir(join(packageRoot, 'openapi'), { recursive: true });
await writeFile(
  join(packageRoot, 'schemas', 'contract-schemas.v1.json'),
  await render(createJsonSchemaBundle()),
);
await writeFile(
  join(packageRoot, 'openapi', 'creator-agent-v1.openapi.json'),
  await render(createOpenApiDocument()),
);

const fixtureDirectory = join(packageRoot, 'fixtures');
const fixtureFiles = (await readdir(fixtureDirectory))
  .filter((name) => name.endsWith('.json') && name !== 'index.json')
  .sort();
const fixtures = [];
for (const path of fixtureFiles) {
  const bytes = await readFile(join(fixtureDirectory, path));
  fixtures.push({ path, bytes: bytes.byteLength, digest: sha256(bytes) });
}
await writeFile(
  join(fixtureDirectory, 'index.json'),
  await render({ protocol: 'combo.creator-agent-fixtures/1', schemaVersion: 1, fixtures }),
);
