import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assessCumulative,
  assessPullRequest,
  contractPath,
  defaultBaseRef,
  parseContract,
  parseNumstat,
  policyPaths,
} from './vnext-rebaseline-budget.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(repo, contractPath), 'utf8');
const contract = parseContract(source);

function entry(path, changedLines = 1) {
  return { path, additions: changedLines, deletions: 0, changedLines };
}

test('the committed budget contract is canonical and pinned to the clean rebuild', () => {
  assert.equal(contract.baseSha, 'd15a985c67c2b9b5e08a5b8bc03a772fb543aecb');
  assert.equal(contract.donorSha, '871c8f43b0725fa2f471173b2fbcf380ccfba930');
  assert.deepEqual(contract.compatibility, {
    preservePostgresMigrationHistory: false,
    preserveWorkerSqliteSchemaHistory: false,
  });
  assert.equal(source, `${JSON.stringify(contract, null, 2)}\n`);
});

test('the PR quality job retains full history and the budget-bearing test entrypoints', () => {
  const pullRequestWorkflow = readFileSync(join(repo, '.github/workflows/pr-ci.yml'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.match(pullRequestWorkflow, /fetch-depth: 0/);
  assert.match(pullRequestWorkflow, /run: pnpm test:fast/);
  assert.match(
    packageJson.scripts['test:workflow-contracts'],
    /^node scripts\/vnext-rebaseline-budget\.mjs && /,
  );
  assert.match(packageJson.scripts['test:fast'], /pnpm test:workflow-contracts$/);
  assert.match(packageJson.scripts.test, /pnpm test:workflow-contracts$/);
});

test('GitHub pull requests use their base branch and Main checks use the first parent', () => {
  assert.equal(
    defaultBaseRef({ GITHUB_BASE_REF: 'main', BASE_SHA: contract.baseSha }),
    contract.baseSha,
  );
  assert.equal(
    defaultBaseRef({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }),
    'HEAD^1',
  );
  assert.equal(defaultBaseRef({ GITHUB_ACTIONS: 'true' }), 'origin/main');
});

test('unknown fields, duplicate keys, unsafe paths, and relaxed ceilings fail closed', () => {
  const unknown = structuredClone(contract);
  unknown.status = 'GREEN';
  assert.throws(
    () => parseContract(`${JSON.stringify(unknown, null, 2)}\n`),
    /keys or key order changed/,
  );

  const duplicate = source.replace(
    '"schemaVersion": 1,',
    '"schemaVersion": 1,\n  "schemaVersion": 1,',
  );
  assert.throws(() => parseContract(duplicate), /canonical JSON/);

  const unsafe = structuredClone(contract);
  unsafe.allowedFiles = [...unsafe.allowedFiles, '../outside'].sort();
  assert.throws(
    () => parseContract(`${JSON.stringify(unsafe, null, 2)}\n`),
    /safe repository path/,
  );

  const relaxed = structuredClone(contract);
  relaxed.limits.maxChangedLinesPerPullRequest = 5001;
  assert.throws(
    () => parseContract(`${JSON.stringify(relaxed, null, 2)}\n`),
    /from 1 through 5000/,
  );
});

test('numstat counts additions and deletions and retains mode-only files', () => {
  assert.deepEqual(
    parseNumstat('2\t3\tapps/runtime/a.ts\0', 'apps/runtime/a.ts\0apps/runtime/mode.ts\0'),
    [
      { path: 'apps/runtime/a.ts', additions: 2, deletions: 3, changedLines: 5 },
      { path: 'apps/runtime/mode.ts', additions: 0, deletions: 0, changedLines: 0 },
    ],
  );
  assert.throws(
    () => parseNumstat('-\t-\tapps/runtime/image.bin\0', 'apps/runtime/image.bin\0'),
    /binary change is not allowed/,
  );
});

test('governance edits cannot share a pull request with product edits', () => {
  const governance = policyPaths.map((path) => entry(path));
  assert.equal(assessPullRequest(contract, governance).mode, 'GOVERNANCE_ONLY');
  assert.throws(
    () => assessPullRequest(contract, [...governance, entry('apps/runtime/src/product.ts')]),
    /governance-only/,
  );
});

test('product edits must stay inside the declared rebuild surface', () => {
  assert.equal(
    assessPullRequest(contract, [entry('apps/runtime/src/product.ts', 20)]).mode,
    'PRODUCT',
  );
  assert.throws(
    () => assessPullRequest(contract, [entry('packages/creator-agent-snapshot/src/index.ts')]),
    /outside the R1-R3 rebuild scope/,
  );
  assert.throws(
    () => assessPullRequest(contract, [entry('infra/k8s/production.yaml')]),
    /outside the R1-R3 rebuild scope/,
  );
});

test('per-pull-request file, line, and per-file ceilings are exact', () => {
  const thirty = Array.from({ length: 30 }, (_, index) =>
    entry(`apps/runtime/src/file-${index}.ts`, index === 0 ? 1200 : 1),
  );
  assert.equal(assessPullRequest(contract, thirty).changedFiles, 30);
  assert.throws(
    () => assessPullRequest(contract, [...thirty, entry('apps/runtime/src/file-30.ts')]),
    /changed-file budget exceeded/,
  );
  assert.throws(
    () => assessPullRequest(contract, [entry('apps/runtime/src/large.ts', 1201)]),
    /per-file changed-line budget exceeded/,
  );
  assert.throws(
    () =>
      assessPullRequest(
        contract,
        Array.from({ length: 5 }, (_, index) => entry(`apps/runtime/src/chunk-${index}.ts`, 1001)),
      ),
    /changed-line budget exceeded/,
  );
});

test('the cumulative train has a separate hard ceiling and the same scope boundary', () => {
  assert.equal(
    assessCumulative(contract, [entry('apps/creator-worker/src/root.ts', 70000)]).changedLines,
    70000,
  );
  assert.throws(
    () => assessCumulative(contract, [entry('apps/creator-worker/src/root.ts', 70001)]),
    /cumulative changed-line budget exceeded/,
  );
});
