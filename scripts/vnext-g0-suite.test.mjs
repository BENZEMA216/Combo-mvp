import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { runVnextG0, VNEXT_G0_SUITE } from './run-vnext-g0.mjs';

const protocolRequire = createRequire(
  new URL('../packages/creator-agent-protocol/package.json', import.meta.url),
);
const YAML = protocolRequire('yaml');
const rootUrl = new URL('../', import.meta.url);
const text = async (path) => readFile(new URL(path, rootUrl), 'utf8');

function commandTestFiles(group) {
  const runIndex = group.command.indexOf('run');
  assert.notEqual(runIndex, -1, group.id);
  const relative = group.command
    .slice(runIndex + 1)
    .filter((argument) => argument.endsWith('.test.ts'));
  const prefix =
    group.id === 'creator-agent-snapshot'
      ? 'packages/creator-agent-snapshot/'
      : group.id === 'agent-gateway'
        ? 'apps/agent-gateway/'
        : group.id === 'runtime-public-ingress'
          ? 'apps/runtime/'
          : null;
  assert.notEqual(prefix, null, group.id);
  return relative.map((path) => `${prefix}${path}`).sort();
}

function relativeCommandTestFiles(group) {
  const runIndex = group.command.indexOf('run');
  assert.notEqual(runIndex, -1, group.id);
  return group.command
    .slice(runIndex + 1)
    .filter((argument) => argument.endsWith('.test.ts'))
    .sort();
}

function groupCommandFiles(group) {
  return group.command
    .slice(2)
    .filter((argument) => argument.endsWith('.test.mjs'))
    .sort();
}

test('the T0 G0 suite covers every implemented SCH registered test at its declared tier', async () => {
  const registry = YAML.parse(await text('tests/vnext/cases/iteration-0.yaml'), {
    merge: true,
    uniqueKeys: true,
  });
  const schemaCases = registry.cases.filter(({ id }) => /^SCH-\d{3}$/u.test(id));
  assert.deepEqual(
    schemaCases.map(({ id }) => id),
    Array.from({ length: 10 }, (_, index) => `SCH-${String(index + 1).padStart(3, '0')}`),
  );
  assert.ok(schemaCases.every(({ implementation }) => implementation?.status === 'implemented'));
  assert.ok(schemaCases.every(({ environment }) => environment === 'T0-LINUX-CI'));
  assert.ok(schemaCases.every(({ gate }) => gate === 'G0'));
  assert.deepEqual(
    Object.fromEntries(schemaCases.map(({ id, level }) => [id, level])),
    Object.fromEntries(schemaCases.map(({ id }) => [id, id === 'SCH-006' ? 'E0' : 'E1'])),
  );

  const registered = new Set(schemaCases.flatMap(({ implementation }) => implementation.testFiles));
  const executed = VNEXT_G0_SUITE.groups.flatMap(({ registeredTestFiles }) =>
    Array.from(registeredTestFiles),
  );
  const excluded = VNEXT_G0_SUITE.excludedRegisteredTests.map(({ testFile }) => testFile);
  assert.deepEqual([...new Set([...executed, ...excluded])].sort(), [...registered].sort());
  assert.equal(executed.length, new Set(executed).size);
  assert.equal(excluded.length, new Set(excluded).size);
  assert.equal(executed.filter((testFile) => excluded.includes(testFile)).length, 0);
  assert.equal(executed.length + excluded.length, registered.size);
  assert.deepEqual(VNEXT_G0_SUITE.excludedRegisteredTests, [
    {
      testFile: 'apps/agent-gateway/src/postgres-authority.pg.test.ts',
      environment: 'T1-SERVICE-CI',
      reason: 'requires-real-postgresql',
    },
    {
      testFile: 'packages/creator-worker-broker-client/src/postgres-sqlite-vertical.pg.test.ts',
      environment: 'T1-SERVICE-CI',
      reason: 'requires-real-postgresql',
    },
  ]);

  for (const group of VNEXT_G0_SUITE.groups.filter(
    ({ id, registeredTestFiles }) =>
      id !== 'creator-agent-protocol' && registeredTestFiles.length > 0,
  )) {
    assert.deepEqual(commandTestFiles(group), [...group.registeredTestFiles].sort(), group.id);
    assert.deepEqual(
      relativeCommandTestFiles(group),
      [...group.expectedJUnitFiles].sort(),
      `${group.id} JUnit files`,
    );
  }
  const contractGroup = VNEXT_G0_SUITE.groups.find(({ id }) => id === 't0-contracts');
  assert.deepEqual(groupCommandFiles(contractGroup), [...contractGroup.expectedJUnitFiles].sort());
});

test('both T1 workflows activate the two excluded real PostgreSQL suites', async () => {
  const [gatewayTest, verticalTest, gatewayPackage, workerPackage, prWorkflow, releaseWorkflow] =
    await Promise.all([
      text('apps/agent-gateway/src/postgres-authority.pg.test.ts'),
      text('packages/creator-worker-broker-client/src/postgres-sqlite-vertical.pg.test.ts'),
      text('apps/agent-gateway/package.json').then(JSON.parse),
      text('packages/creator-worker-broker-client/package.json').then(JSON.parse),
      text('.github/workflows/pr-ci.yml'),
      text('.github/workflows/ci.yml'),
    ]);
  assert.match(gatewayTest, /process\.env\.CREATOR_AGENT_GATEWAY_PG_TEST === '1'/u);
  assert.match(verticalTest, /process\.env\.CREATOR_AGENT_VERTICAL_PG_SQLITE_TEST === '1'/u);
  assert.equal(gatewayPackage.scripts.test, 'vitest run');
  assert.equal(
    workerPackage.scripts['test:pg-vertical'],
    'vitest run src/postgres-sqlite-vertical.pg.test.ts',
  );
  for (const workflow of [prWorkflow, releaseWorkflow]) {
    assert.match(workflow, /CREATOR_AGENT_GATEWAY_PG_TEST: '1'/u);
    assert.match(workflow, /pnpm -F @cb\/agent-gateway test/u);
    assert.match(workflow, /CREATOR_AGENT_VERTICAL_PG_SQLITE_TEST: '1'/u);
    assert.match(workflow, /pnpm -F @cb\/creator-worker-broker-client test:pg-vertical/u);
  }
});

test('the root command and protocol package freeze the exact T0 G0 matrix', async () => {
  const [rootPackage, protocolPackage, propertyMatrix, propertyRunner, runnerSource] =
    await Promise.all([
      text('package.json').then(JSON.parse),
      text('packages/creator-agent-protocol/package.json').then(JSON.parse),
      text('packages/creator-agent-protocol/src/__tests__/property-matrix.ts'),
      text('packages/creator-agent-protocol/scripts/run-property.mjs'),
      text('scripts/run-vnext-g0.mjs'),
    ]);

  assert.equal(rootPackage.scripts['vnext:test:g0'], 'node scripts/run-vnext-g0.mjs');
  assert.deepEqual(VNEXT_G0_SUITE.command, ['pnpm', 'vnext:test:g0']);
  assert.deepEqual(VNEXT_G0_SUITE.property, {
    seedBase: 12_648_430,
    seedCount: 100,
    totalRunsPerModel: 100_000,
    seedCorpusDigest: 'sha256:a608d11159dc2055653480d744a39af76ab84cf0bbef0c57f479e0a0f9f91a42',
  });
  assert.match(propertyMatrix, /DEFAULT_PROPERTY_RUNS = 100_000/u);
  assert.match(propertyMatrix, /DEFAULT_PROPERTY_SEED_BASE = 12_648_430/u);
  assert.match(propertyMatrix, /DEFAULT_PROPERTY_SEED_COUNT = 100/u);
  assert.match(
    propertyMatrix,
    /sha256:a608d11159dc2055653480d744a39af76ab84cf0bbef0c57f479e0a0f9f91a42/u,
  );
  assert.match(propertyRunner, /--seeds/u);
  assert.match(propertyRunner, /capability\.property\.test\.ts/u);

  const protocolGroup = VNEXT_G0_SUITE.groups.find(({ id }) => id === 'creator-agent-protocol');
  assert.ok(protocolGroup);
  assert.equal(
    protocolPackage.scripts['test:fast'],
    'pnpm check:contracts && pnpm check:adr && pnpm typecheck:test && pnpm test:g0',
  );
  assert.deepEqual(
    protocolPackage.scripts['test:g0'].split(/\s+/u).filter((value) => value.endsWith('.test.ts')),
    protocolGroup.expectedJUnitFiles,
  );
  for (const testFile of protocolGroup.registeredTestFiles) {
    const relative = testFile.replace('packages/creator-agent-protocol/', '');
    assert.match(
      protocolPackage.scripts['test:g0'],
      new RegExp(relative.replaceAll('/', '\\/'), 'u'),
    );
  }
  assert.match(protocolPackage.scripts['test:g0'], /property-matrix\.test\.ts/u);
  assert.doesNotMatch(JSON.stringify(VNEXT_G0_SUITE), /\.skip|\.todo|--passWithNoTests|\|\| true/u);
  assert.doesNotMatch(runnerSource, /--passWithNoTests|\|\| true/u);
});

test('the G0 runner propagates the frozen matrix, emits exact JUnit paths, and stops on failure', async (t) => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), 'combo-vnext-g0-runner-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const calls = [];
  const status = await runVnextG0({
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    environment: { VNEXT_T0_EVIDENCE_DIRECTORY: evidenceDirectory },
    cwd: fileURLToPath(rootUrl),
    write() {},
  });
  assert.equal(status, 0);
  assert.equal(calls.length, VNEXT_G0_SUITE.groups.length);
  calls.forEach((call, index) => {
    const group = VNEXT_G0_SUITE.groups[index];
    if (group.id === 't0-contracts') {
      assert.deepEqual(
        [call.command, ...call.args],
        [
          'node',
          '--test',
          '--test-reporter=spec',
          '--test-reporter-destination=stdout',
          '--test-reporter=junit',
          `--test-reporter-destination=${resolve(evidenceDirectory, group.junitPath)}`,
          ...group.command.slice(2),
        ],
      );
    } else {
      assert.deepEqual([call.command, ...call.args], group.command);
    }
    assert.equal(call.options.env.VNEXT_PROPERTY_SEED, '12648430');
    assert.equal(call.options.env.VNEXT_PROPERTY_SEEDS, '100');
    assert.equal(call.options.env.VNEXT_PROPERTY_RUNS, '100000');
    assert.equal(
      call.options.env.VNEXT_T0_JUNIT_FILE,
      group.id === 't0-contracts' ? undefined : resolve(evidenceDirectory, group.junitPath),
    );
  });

  let failureCalls = 0;
  const failed = await runVnextG0({
    spawn() {
      failureCalls += 1;
      return { status: 17 };
    },
    environment: {},
    cwd: fileURLToPath(rootUrl),
    write() {},
  });
  assert.equal(failed, 17);
  assert.equal(failureCalls, 1);

  await assert.rejects(
    runVnextG0({
      spawn() {
        throw new Error('must not spawn');
      },
      environment: { VNEXT_PROPERTY_SEEDS: '99' },
      cwd: fileURLToPath(rootUrl),
      write() {},
    }),
    /cannot weaken the frozen T0 G0 property matrix/u,
  );
});
