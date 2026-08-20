/* global process, URL */
import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';

import {
  PUBLIC_BOUNDARY_CLOSURE_AUTHORITY,
  PUBLIC_BOUNDARY_CLOSURE_PROTOCOL,
  PUBLIC_BOUNDARY_MANUAL_CAPS,
  PUBLIC_BOUNDARY_SOURCE_AST_CENSUS,
  PublicBoundaryClosureCorpusSchema,
  artifactDigest,
  collectPublicArtifactBoundaryRows,
  collectPublicSourceBoundaryRows,
} from '../dist/public-boundary-closure.js';
import {
  PUBLIC_MANUAL_CAP_OUTCOME_FIXTURE_PATH,
  createPublicManualCapOutcomeFixture,
} from '../dist/public-manual-cap-outcomes.js';

const packageUrl = new URL('../', import.meta.url);
const artifactUrls = {
  contractSchemas: new URL('schemas/contract-schemas.v1.json', packageUrl),
  brokerContract: new URL('schemas/broker-contract.v1.json', packageUrl),
  openApi: new URL('openapi/creator-agent-v1.openapi.json', packageUrl),
};
const delegatedFixtures = [
  ['protocol-utf8-boundaries.v1.json', 'utf8-boundaries.test.ts'],
  ['protocol-decoded-boundaries.v1.json', 'decoded-boundaries.test.ts'],
  ['protocol-structural-boundaries.v1.json', 'structural-boundaries.test.ts'],
  ['http-idempotency-key-boundaries.v1.json', 'http-idempotency-key-boundaries.test.ts'],
  ['agent-version-resource-boundaries.v1.json', 'resource-boundaries.test.ts'],
  ['broker-capacity-boundaries.v1.json', 'broker-capacity-boundaries.test.ts'],
  [
    'context-tools-closed-world-boundaries.v1.json',
    'context-tools-closed-world-boundaries.test.ts',
  ],
  [
    'execution-capability-upstream-count-boundaries.v1.json',
    'execution-capability-upstream-count-boundaries.test.ts',
  ],
  ['snapshot-resource-boundaries.v1.json', 'snapshot-resource-boundaries.test.ts'],
  ['snapshot-single-file-boundaries.v1.json', 'snapshot-single-file-boundaries.test.ts'],
  ['snapshot-compressed-boundaries.v1.json', 'snapshot-compressed-boundaries.test.ts'],
  [
    'snapshot-compression-ratio-boundaries.v1.json',
    'snapshot-compression-ratio-boundaries.test.ts',
  ],
  ['snapshot-path-boundaries.v1.json', 'snapshot-path-boundaries.test.ts'],
  ['protocol-wire-boundaries.v1.json', 'wire-boundaries.test.ts'],
];

const artifactEntries = await Promise.all(
  Object.entries(artifactUrls).map(async ([name, url]) => {
    const bytes = await readFile(url);
    return [name, bytes, JSON.parse(bytes.toString('utf8'))];
  }),
);
const renderJson = (value) =>
  format(JSON.stringify(value), {
    parser: 'json',
    printWidth: 100,
    tabWidth: 2,
    endOfLine: 'lf',
  });
const manualOutcomeTarget = new URL('fixtures/public-manual-cap-outcomes.v1.json', packageUrl);
const manualOutcomeRendered = await renderJson(createPublicManualCapOutcomeFixture());
const manualOutcomeBytes = Buffer.from(manualOutcomeRendered, 'utf8');
const corpus = PublicBoundaryClosureCorpusSchema.parse({
  protocol: PUBLIC_BOUNDARY_CLOSURE_PROTOCOL,
  schemaVersion: 1,
  authority: PUBLIC_BOUNDARY_CLOSURE_AUTHORITY,
  status: 'implemented',
  checkedArtifactDigests: Object.fromEntries(
    artifactEntries.map(([name, bytes]) => [name, artifactDigest(bytes)]),
  ),
  sourceRows: collectPublicSourceBoundaryRows(),
  artifactRows: collectPublicArtifactBoundaryRows(
    Object.fromEntries(artifactEntries.map(([name, _bytes, document]) => [name, document])),
  ),
  manualCaps: PUBLIC_BOUNDARY_MANUAL_CAPS,
  manualOutcomeFixture: {
    path: PUBLIC_MANUAL_CAP_OUTCOME_FIXTURE_PATH,
    digest: artifactDigest(manualOutcomeBytes),
  },
  delegatedFixtures: await Promise.all(
    delegatedFixtures.map(async ([path, testFile]) => ({
      path: `packages/creator-agent-protocol/fixtures/${path}`,
      digest: artifactDigest(await readFile(new URL(`fixtures/${path}`, packageUrl))),
      testFiles: [`packages/creator-agent-protocol/src/__tests__/${testFile}`],
    })),
  ),
  sourceAstCensus: PUBLIC_BOUNDARY_SOURCE_AST_CENSUS,
  remainingBoundaryClasses: [],
  requiredExternalEvidence: [
    {
      environment: 'T0-LINUX-CI',
      status: 'NOT_RUN',
      command: 'pnpm vnext:test:g0',
      binding: 'clean-source-sha-and-workflow-run-required',
    },
  ],
  nonClaims: [
    'does-not-prove-formal-t0-linux-pass',
    'does-not-complete-snp-008',
    'does-not-prove-transport-storage-or-production',
  ],
});

const target = new URL('fixtures/public-boundary-closure.v1.json', packageUrl);
const rendered = await renderJson(corpus);
if (process.argv.includes('--check')) {
  const [current, currentManualOutcomes] = await Promise.all([
    readFile(target, 'utf8'),
    readFile(manualOutcomeTarget, 'utf8'),
  ]);
  if (current !== rendered || currentManualOutcomes !== manualOutcomeRendered) {
    throw new Error('public boundary closure fixture 已漂移，请运行 pnpm generate:contracts');
  }
} else {
  await Promise.all([
    writeFile(manualOutcomeTarget, manualOutcomeRendered),
    writeFile(target, rendered),
  ]);
}
