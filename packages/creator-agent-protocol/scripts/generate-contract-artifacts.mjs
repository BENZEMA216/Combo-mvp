import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { stringify } from 'yaml';
import {
  createBrokerContractArtifact,
  createJsonSchemaBundle,
  createOpenApiDocument,
  currentBrokerContractDigest,
} from '../dist/artifacts.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(packageRoot, '../..');

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
  join(packageRoot, 'schemas', 'broker-contract.v1.json'),
  await render(createBrokerContractArtifact()),
);
await writeFile(
  join(packageRoot, 'openapi', 'creator-agent-v1.openapi.json'),
  await render(createOpenApiDocument()),
);
await writeFile(
  join(repositoryRoot, 'tests', 'vnext', 'registries.yaml'),
  stringify(
    {
      protocol: 'combo.vnext-broker-contract-registry/1',
      schemaVersion: 1,
      contracts: [
        {
          wireProtocol: 'combo.creator-broker/1',
          artifactPath: 'packages/creator-agent-protocol/schemas/broker-contract.v1.json',
          contractDigest: currentBrokerContractDigest(),
        },
      ],
    },
    { lineWidth: 0 },
  ),
);

const fixtureDirectory = join(packageRoot, 'fixtures');
const handshakePath = join(fixtureDirectory, 'broker-handshake.v1.json');
const handshake = JSON.parse(await readFile(handshakePath, 'utf8'));
await writeFile(
  handshakePath,
  await render({ ...handshake, brokerContractDigest: currentBrokerContractDigest() }),
);
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
