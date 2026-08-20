import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { isMap, isSeq, parseDocument, stringify } from 'yaml';
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

const digestBoundCorpusFiles = Object.freeze([
  'protocol-utf8-boundaries.v1.json',
  'protocol-decoded-boundaries.v1.json',
  'protocol-structural-boundaries.v1.json',
  'agent-version-resource-boundaries.v1.json',
  'broker-capacity-boundaries.v1.json',
  'context-tools-closed-world-boundaries.v1.json',
  'execution-capability-upstream-count-boundaries.v1.json',
  'snapshot-resource-boundaries.v1.json',
  'snapshot-single-file-boundaries.v1.json',
  'snapshot-compressed-boundaries.v1.json',
  'snapshot-path-boundaries.v1.json',
  'protocol-wire-boundaries.v1.json',
  'protocol-raw-ingress-hostile-boundaries.v1.json',
]);

async function digestForBoundPath(path) {
  const target = path.startsWith('packages/creator-agent-protocol/')
    ? join(repositoryRoot, path)
    : path.startsWith('schemas/') || path.startsWith('openapi/')
      ? join(packageRoot, path)
      : path.endsWith('.json') && !path.includes('/')
        ? join(packageRoot, 'fixtures', path)
        : undefined;
  return target === undefined ? undefined : sha256(await readFile(target));
}

async function refreshPathDigestPairs(value) {
  if (Array.isArray(value)) {
    for (const item of value) await refreshPathDigestPairs(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (typeof value.path === 'string' && typeof value.digest === 'string') {
    const digest = await digestForBoundPath(value.path);
    if (digest !== undefined) value.digest = digest;
  }
  for (const item of Object.values(value)) await refreshPathDigestPairs(item);
}

async function refreshDigestBoundCorpora(artifactDigests) {
  const decodedFixturePaths = Object.freeze({
    brokerHandshake: 'broker-handshake.v1.json',
    brokerInvocationPrepare: 'broker-invocation-prepare.v1.json',
    sandboxAttestation: 'sandbox-attestation.v1.json',
    evidenceReviewerSignoff: 'evidence-reviewer-signoff.v1.json',
    snapshotEnvelope: 'snapshot-envelope.v1.json',
    snapshotManifestEnvelope: 'snapshot-manifest-envelope.v1.json',
  });

  for (const path of digestBoundCorpusFiles) {
    const target = join(packageRoot, 'fixtures', path);
    const corpus = JSON.parse(await readFile(target, 'utf8'));
    if (corpus.checkedArtifactDigests !== undefined) {
      for (const key of Object.keys(corpus.checkedArtifactDigests)) {
        if (key === 'advertisedBrokerContract') {
          corpus.checkedArtifactDigests[key] = currentBrokerContractDigest();
        } else if (artifactDigests[key] !== undefined) {
          corpus.checkedArtifactDigests[key] = artifactDigests[key];
        } else {
          throw new Error(`未登记的 checkedArtifactDigests key: ${path}:${key}`);
        }
      }
    }
    if (corpus.baseFixtureDigests !== undefined) {
      for (const [key, fixturePath] of Object.entries(decodedFixturePaths)) {
        if (corpus.baseFixtureDigests[key] !== undefined) {
          corpus.baseFixtureDigests[key] = await digestForBoundPath(fixturePath);
        }
      }
    }
    if (corpus.checkedDependencies?.contractSchemas !== undefined) {
      corpus.checkedDependencies.contractSchemas = artifactDigests.contractSchemas;
    }
    if (corpus.advertisedBoundary?.artifact === 'schemas/broker-contract.v1.json') {
      corpus.advertisedBoundary.digest = artifactDigests.brokerContract;
    }
    await refreshPathDigestPairs(corpus);
    await writeFile(target, await render(corpus));
  }
}

async function refreshTestCaseFixtureDigests() {
  const target = join(repositoryRoot, 'tests', 'vnext', 'cases', 'iteration-0.yaml');
  const document = parseDocument(await readFile(target, 'utf8'));
  const cases = document.get('cases', true);
  if (!isSeq(cases)) throw new Error('VNext test case registry 缺少 cases sequence');
  for (const testCase of cases.items) {
    if (!isMap(testCase)) throw new Error('VNext test case registry case 必须是 map');
    const fixtures = testCase.get('fixture', true);
    const fixtureDigests = testCase.get('fixtureDigests', true);
    if (!isSeq(fixtures) || !isSeq(fixtureDigests) || fixtures.items.length === 0) continue;
    const fixturePaths = fixtures.items
      .map((item) => String(item))
      .filter((path) => path.startsWith('packages/creator-agent-protocol/'));
    if (fixturePaths.length === 0) continue;
    const digests = await Promise.all(fixturePaths.map((path) => digestForBoundPath(path)));
    if (digests.some((digest) => digest === undefined)) {
      throw new Error(`VNext test case 含未解析 fixture: ${String(testCase.get('id'))}`);
    }
    testCase.set('fixtureDigests', digests);
  }
  await writeFile(target, document.toString({ lineWidth: 0 }));
}

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
const compatibilityPath = join(fixtureDirectory, 'protocol-compatibility.v1.json');
const compatibility = JSON.parse(await readFile(compatibilityPath, 'utf8'));
const renderedHandshake = await readFile(handshakePath);
const previousProfile = compatibility.declaredPrevious[0];
const previousHandshakePath = join(
  fixtureDirectory,
  previousProfile.handshakeFixture.split('/').at(-1),
);
const previousHandshake = JSON.parse(await readFile(previousHandshakePath, 'utf8'));
await writeFile(
  previousHandshakePath,
  await render({
    ...previousHandshake,
    brokerContractDigest: currentBrokerContractDigest(),
  }),
);
const renderedPreviousHandshake = await readFile(previousHandshakePath);
await writeFile(
  compatibilityPath,
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
const artifactDigests = {
  contractSchemas: sha256(await readFile(join(packageRoot, 'schemas', 'contract-schemas.v1.json'))),
  brokerContract: sha256(await readFile(join(packageRoot, 'schemas', 'broker-contract.v1.json'))),
  openApi: sha256(await readFile(join(packageRoot, 'openapi', 'creator-agent-v1.openapi.json'))),
};
await refreshDigestBoundCorpora(artifactDigests);
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
await refreshTestCaseFixtureDigests();
