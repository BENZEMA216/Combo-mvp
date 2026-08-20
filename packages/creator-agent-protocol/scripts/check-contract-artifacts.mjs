import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
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
const differences = [];

const check = async (path, expected) => {
  const actual = await readFile(join(packageRoot, path), 'utf8');
  if (actual !== expected) differences.push(path);
};

const checkRepository = async (path, expected) => {
  const actual = await readFile(join(repositoryRoot, path), 'utf8');
  if (actual !== expected) differences.push(path);
};

await check('schemas/contract-schemas.v1.json', await render(createJsonSchemaBundle()));
await check('schemas/broker-contract.v1.json', await render(createBrokerContractArtifact()));
await check('openapi/creator-agent-v1.openapi.json', await render(createOpenApiDocument()));
await checkRepository(
  'tests/vnext/registries.yaml',
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
await check(
  'fixtures/broker-handshake.v1.json',
  await render({ ...handshake, brokerContractDigest: currentBrokerContractDigest() }),
);
const compatibilityPath = join(fixtureDirectory, 'protocol-compatibility.v1.json');
const compatibility = JSON.parse(await readFile(compatibilityPath, 'utf8'));
const renderedHandshake = await readFile(handshakePath);
const previousProfile = compatibility.declaredPrevious[0];
const previousHandshakePath = join(
  fixtureDirectory,
  previousProfile.handshakeFixture.split('/').at(-1),
);
const previousHandshake = JSON.parse(await readFile(previousHandshakePath, 'utf8'));
await check(
  `fixtures/${previousProfile.handshakeFixture.split('/').at(-1)}`,
  await render({
    ...previousHandshake,
    brokerContractDigest: currentBrokerContractDigest(),
  }),
);
const renderedPreviousHandshake = await readFile(previousHandshakePath);
await check(
  'fixtures/protocol-compatibility.v1.json',
  await render({
    ...compatibility,
    current: {
      ...compatibility.current,
      brokerContractDigest: currentBrokerContractDigest(),
      handshakeFixtureDigest: sha256(renderedHandshake),
    },
    declaredPrevious: compatibility.declaredPrevious.map((profile, index) =>
      index === 0
        ? {
            ...profile,
            brokerContractDigest: currentBrokerContractDigest(),
            handshakeFixtureDigest: sha256(renderedPreviousHandshake),
          }
        : profile,
    ),
    gatewayReleases: compatibility.gatewayReleases.map((release) => ({
      ...release,
      brokerContractDigest: currentBrokerContractDigest(),
    })),
  }),
);
const fixtureFiles = (await readdir(fixtureDirectory))
  .filter((name) => name.endsWith('.json') && name !== 'index.json')
  .sort();
const fixtures = [];
for (const path of fixtureFiles) {
  const bytes = await readFile(join(fixtureDirectory, path));
  fixtures.push({ path, bytes: bytes.byteLength, digest: sha256(bytes) });
}
await check(
  'fixtures/index.json',
  await render({ protocol: 'combo.creator-agent-fixtures/1', schemaVersion: 1, fixtures }),
);

if (differences.length > 0) {
  throw new Error(`合同产物已漂移，请运行 pnpm generate:contracts：${differences.join(', ')}`);
}
