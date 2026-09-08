import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  archivedBudgetPath,
  legacyV5Lock,
  lightweightTransferScopeFiles,
  parseTrancheContract,
  trancheCeilings,
  trancheContractPath,
  verifyLegacyV5Receipt,
  verifyMainlineTrancheBase,
} from './vnext-rebaseline-budget-tranche.mjs';
import {
  assessCumulative,
  assessPullRequest,
  parseContract,
  parseNumstat,
  policyPaths,
} from './vnext-rebaseline-budget.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archivedSource = readFileSync(join(repoRoot, archivedBudgetPath), 'utf8');
const archivedBudget = parseContract(archivedSource);
const source = readFileSync(join(repoRoot, trancheContractPath), 'utf8');
const contract = parseTrancheContract(source, archivedBudget);
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const entry = (path, changedLines = 1) => ({
  path,
  additions: changedLines,
  deletions: 0,
  changedLines,
});

test('v6 freezes the merged compiler Main baseline and all v5 bytes and ceilings', () => {
  assert.equal(contract.baseSha, '39e5b1b5c281c864a62974a15b51b6d0572cf6d0');
  assert.deepEqual(contract.legacyV5, legacyV5Lock);
  assert.equal(
    createHash('sha256').update(archivedSource).digest('hex'),
    legacyV5Lock.contractSha256,
  );
  assert.deepEqual(contract.limits, archivedBudget.limits);
  assert.deepEqual(contract.limits, trancheCeilings);
  assert.deepEqual(contract.compatibility, archivedBudget.compatibility);
  assert.deepEqual(contract.allowedPathPrefixes, archivedBudget.allowedPathPrefixes);
  assert.equal(contract.maintenanceFile, archivedBudget.maintenanceFile);
  assert.equal(lightweightTransferScopeFiles.length, 14);
  assert.deepEqual(
    contract.allowedFiles,
    [...archivedBudget.allowedFiles, ...lightweightTransferScopeFiles].sort(),
  );
  assert.equal(source, canonical(contract));
  for (const path of [
    trancheContractPath,
    'scripts/vnext-rebaseline-budget-tranche.mjs',
    'scripts/vnext-rebaseline-budget-tranche.test.mjs',
    'scripts/vnext-rebaseline-budget.v6.md',
  ]) {
    assert.ok(policyPaths.includes(path));
    assert.equal(assessPullRequest(contract, [entry(path)]).mode, 'GOVERNANCE_ONLY');
  }
});

test('v6 rejects malformed, duplicate, unknown and reordered contract fields', () => {
  assert.throws(() => parseTrancheContract('{', archivedBudget), SyntaxError);
  assert.throws(
    () =>
      parseTrancheContract(
        source.replace('"schemaVersion": 6,', '"schemaVersion": 6,\n  "schemaVersion": 6,'),
        archivedBudget,
      ),
    /canonical JSON/,
  );
  assert.throws(() => parseTrancheContract(`${source}\n`, archivedBudget), /canonical JSON/);
  assert.throws(
    () => parseTrancheContract(canonical({ ...contract, status: 'PASS' }), archivedBudget),
    /keys or key order/,
  );
  const { protocol, ...rest } = contract;
  assert.throws(
    () => parseTrancheContract(canonical({ ...rest, protocol }), archivedBudget),
    /keys or key order/,
  );
});

test('v6 rejects non-Main candidate bases and every altered legacy receipt field', () => {
  for (const baseSha of [
    'e8fb4c73188a8f93fcfd857399d050e5e50d2a03',
    legacyV5Lock.baseSha,
    '0'.repeat(40),
  ]) {
    assert.throws(
      () => parseTrancheContract(canonical({ ...contract, baseSha }), archivedBudget),
      /locked Main SHA/,
    );
  }
  for (const [field, value] of Object.entries(legacyV5Lock)) {
    const changed = structuredClone(contract);
    changed.legacyV5[field] = typeof value === 'number' ? value + 1 : `${value}-changed`;
    assert.throws(
      () => parseTrancheContract(canonical(changed), archivedBudget),
      /legacy v5 receipt changed/,
      field,
    );
  }
});

test('v6 admits exactly the requested files and rejects every scope or compatibility drift', () => {
  assert.equal(
    assessPullRequest(
      contract,
      lightweightTransferScopeFiles.map((path) => entry(path)),
    ).mode,
    'PRODUCT',
  );
  const mutations = [
    (v) => v.allowedFiles.push('apps/web/src/pages/Shell.tsx'),
    (v) => v.allowedFiles.pop(),
    (v) => v.allowedFiles.push(v.allowedFiles[0]),
    (v) => v.allowedFiles.push('../outside'),
    (v) => v.allowedPathPrefixes.push('apps/web/'),
    (v) => v.allowedPathPrefixes.pop(),
    (v) => {
      v.maintenanceFile = 'apps/web/src/App.tsx';
    },
    (v) => {
      v.compatibility.preservePostgresMigrationHistory = false;
    },
    (v) => {
      v.compatibility.preserveWorkerSqliteSchemaHistory = false;
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(contract);
    mutate(changed);
    assert.throws(
      () => parseTrancheContract(canonical(changed), archivedBudget),
      /must (add only|preserve)/,
    );
  }
  for (const path of [
    'apps/web/src/pages/Shell.tsx',
    'apps/web/src/pages/agents/Unapproved.tsx',
    'apps/web/src/api/unapproved.ts',
    'apps/web/src/index.css',
  ]) {
    assert.throws(() => assessPullRequest(contract, [entry(path)]), /outside/);
  }
});

test('all exact ceilings remain mandatory and independently enforced after the tranche', () => {
  for (const field of Object.keys(trancheCeilings)) {
    for (const delta of [-1, 1]) {
      const changed = structuredClone(contract);
      changed.limits[field] += delta;
      assert.throws(
        () => parseTrancheContract(canonical(changed), archivedBudget),
        /exact v5 ceilings/,
      );
    }
  }
  assert.throws(
    () =>
      parseTrancheContract(source, {
        ...archivedBudget,
        limits: { ...archivedBudget.limits, maxChangedLinesFromBase: 15001 },
      }),
    /legacy v5 ceilings/,
  );
  assert.throws(
    () =>
      assessPullRequest(
        contract,
        Array.from({ length: 31 }, (_, i) => entry(`apps/runtime/${i}.ts`)),
      ),
    /changed-file budget exceeded/,
  );
  assert.throws(
    () => assessPullRequest(contract, [entry('apps/web/src/App.tsx', 1201)]),
    /per-file changed-line budget exceeded/,
  );
  assert.throws(
    () =>
      assessPullRequest(
        contract,
        Array.from({ length: 5 }, (_, i) => entry(`apps/runtime/${i}.ts`, i === 0 ? 1001 : 1000)),
      ),
    /pull request changed-line budget exceeded/,
  );
  const capped = [entry('apps/runtime/new.ts', 15000)];
  assert.equal(assessCumulative(contract, capped).changedLines, 15000);
  assert.throws(
    () => assessCumulative(contract, [entry('apps/runtime/new.ts', 15001)]),
    /cumulative changed-line budget exceeded/,
  );
  assert.throws(
    () => assessCumulative(archivedBudget, [entry('apps/runtime/old.ts', 15001)]),
    /cumulative changed-line budget exceeded/,
  );
  assert.throws(() => assessCumulative(archivedBudget, [entry('apps/web/src/App.tsx')]), /outside/);
  assert.throws(() => assessCumulative(archivedBudget, [entry(trancheContractPath)]), /outside/);
  assert.throws(
    () => assessPullRequest(contract, [entry(trancheContractPath), entry('apps/web/src/App.tsx')]),
    /governance-only/,
  );
  assert.equal(assessCumulative(contract, [entry(trancheContractPath, 200)]).changedLines, 200);
});

test('the real frozen historical diff is recomputed and tampered bytes, totals or raw diff fail', () => {
  const git = (args, encoding = 'utf8') => execFileSync('git', args, { cwd: repoRoot, encoding });
  const range = [legacyV5Lock.baseSha, legacyV5Lock.headSha];
  const entries = parseNumstat(
    git(['diff', '--no-renames', '--numstat', '-z', ...range]),
    git(['diff', '--no-renames', '--name-only', '-z', ...range]),
  );
  const rawDiffSha256 = createHash('sha256')
    .update(
      git(['diff', '--raw', '-z', '--full-index', '--no-renames', '--abbrev=40', ...range], null),
    )
    .digest('hex');
  const input = {
    source: archivedSource,
    committedSource: git(['show', `${legacyV5Lock.headSha}:${archivedBudgetPath}`]),
    entries,
    rawDiffSha256,
  };
  assert.deepEqual(assessCumulative(archivedBudget, entries), {
    changedFiles: 147,
    changedLines: 14060,
  });
  assert.deepEqual(verifyLegacyV5Receipt(input), {
    verified: true,
    headSha: legacyV5Lock.headSha,
    changedFiles: 147,
    changedLines: 14060,
    maxChangedLinesPerFile: 571,
  });
  assert.throws(
    () => verifyLegacyV5Receipt({ ...input, source: `${archivedSource} ` }),
    /bytes changed/,
  );
  assert.throws(
    () => verifyLegacyV5Receipt({ ...input, committedSource: `${archivedSource} ` }),
    /locked Main head/,
  );
  assert.throws(
    () => verifyLegacyV5Receipt({ ...input, rawDiffSha256: '0'.repeat(64) }),
    /raw diff receipt changed/,
  );
  assert.throws(
    () => verifyLegacyV5Receipt({ ...input, entries: entries.slice(1) }),
    /changedFiles receipt changed/,
  );
  const changed = structuredClone(entries);
  changed[0].changedLines += 1;
  assert.throws(
    () => verifyLegacyV5Receipt({ ...input, entries: changed }),
    /changedLines receipt changed/,
  );
  const maximumChanged = structuredClone(entries);
  const maxIndex = maximumChanged.findIndex((e) => e.changedLines === 571);
  maximumChanged[maxIndex].changedLines += 1;
  maximumChanged[(maxIndex + 1) % entries.length].changedLines -= 1;
  assert.throws(
    () => verifyLegacyV5Receipt({ ...input, entries: maximumChanged }),
    /maxChangedLinesPerFile receipt changed/,
  );
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'combo-tranche-graph-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Budget graph test');
  git('config', 'user.email', 'budget@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', 'https://github.com/dangdang-tech/Combo.git');
  const commit = (name) => {
    git('commit', '--allow-empty', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  const start = commit('start');
  git('checkout', '-b', 'compiler');
  const candidate = commit('compiler candidate');
  git('checkout', 'main');
  git('merge', '--no-ff', '--no-edit', 'compiler');
  const tranche = git('rev-parse', 'HEAD');
  const main = commit('main successor');
  git('update-ref', 'refs/remotes/origin/main', main);
  git('checkout', '-b', 'feature');
  const feature = commit('feature');
  const verify = (overrides = {}) =>
    verifyMainlineTrancheBase({
      repoRoot: root,
      baseSha: tranche,
      comparisonBase: main,
      environment: {},
      ...overrides,
    });
  return { root, git, commit, start, candidate, tranche, main, feature, verify };
}

test('real Git graph accepts Main tranche and rejects a merged side-parent or unmerged feature base', (t) => {
  const f = fixture(t);
  assert.equal(f.verify().verified, true);
  assert.throws(() => f.verify({ baseSha: f.candidate }), /not on canonical Main first-parent/);
  assert.throws(
    () => f.verify({ baseSha: f.feature, comparisonBase: f.feature }),
    /not on canonical Main first-parent/,
  );
  assert.throws(
    () => f.verify({ comparisonBase: f.feature }),
    /comparison base is not on canonical Main/,
  );
  assert.throws(() => f.verify({ comparisonBase: f.start }), /ancestor of comparison base/);
  assert.throws(() => f.verify({ baseSha: '0'.repeat(40) }), /ancestry proof is unavailable/);
  f.git('checkout', '--detach', f.start);
  assert.throws(() => f.verify(), /ancestor of HEAD/);
});

test('local and feature CI proofs reject wrong origin, absent Main and shallow history', (t) => {
  const f = fixture(t);
  f.git('remote', 'set-url', 'origin', 'https://github.com/example/fork.git');
  assert.throws(() => f.verify(), /canonical origin is required/);
  f.git('remote', 'set-url', 'origin', 'https://github.com/dangdang-tech/Combo.git');
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'dangdang-tech/Combo',
    GITHUB_EVENT_NAME: 'workflow_call',
    SOURCE_SHA: f.feature,
  };
  assert.equal(f.verify({ environment }).verified, true);
  assert.throws(
    () => f.verify({ environment: { ...environment, GITHUB_REPOSITORY: 'example/fork' } }),
    /canonical GitHub repository/,
  );
  assert.throws(
    () => f.verify({ environment: { ...environment, SOURCE_SHA: f.main } }),
    /checkout SHA changed/,
  );
  f.git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.throws(() => f.verify(), /rev-parse/);
  const shallow = join(f.root, 'shallow');
  execFileSync('git', ['clone', '--depth=1', `file://${f.root}`, shallow], { stdio: 'pipe' });
  assert.throws(
    () =>
      verifyMainlineTrancheBase({
        repoRoot: shallow,
        baseSha: f.feature,
        comparisonBase: f.feature,
        environment: {},
      }),
    /full Main history is required/,
  );
});

test('GitHub PR proof binds canonical Main, immutable base and exact two-parent merge', (t) => {
  const f = fixture(t);
  f.git('checkout', '--detach', f.main);
  f.git('merge', '--no-ff', '--no-edit', f.feature);
  const merge = f.git('rev-parse', 'HEAD');
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'dangdang-tech/Combo',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_BASE_REF: 'main',
    MERGE_SHA: merge,
    BASE_SHA: f.main,
    HEAD_SHA: f.feature,
  };
  assert.equal(f.verify({ environment }).mainHead, f.main);
  for (const [field, value, expected] of [
    ['GITHUB_REPOSITORY', 'example/fork', /canonical GitHub repository/],
    ['GITHUB_BASE_REF', 'feature', /must target canonical Main/],
    ['BASE_SHA', f.tranche, /immutable BASE_SHA/],
    ['MERGE_SHA', f.feature, /checkout SHA changed/],
    ['HEAD_SHA', f.main, /exact verified two-parent merge/],
  ]) {
    assert.throws(() => f.verify({ environment: { ...environment, [field]: value } }), expected);
  }
  assert.throws(
    () => f.verify({ baseSha: f.candidate, environment }),
    /not on canonical Main first-parent/,
  );
  f.git('checkout', '--detach', f.feature);
  assert.throws(
    () => f.verify({ environment: { ...environment, MERGE_SHA: f.feature } }),
    /exact verified two-parent merge/,
  );
});

test('GitHub Main push proof binds exact source and comparison first parent', (t) => {
  const f = fixture(t);
  f.git('checkout', '--detach', f.main);
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'dangdang-tech/Combo',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    SOURCE_SHA: f.main,
  };
  assert.equal(f.verify({ comparisonBase: f.tranche, environment }).mainHead, f.main);
  assert.throws(() => f.verify({ environment }), /comparison base must be first parent/);
  assert.throws(
    () =>
      f.verify({
        comparisonBase: f.tranche,
        environment: { ...environment, SOURCE_SHA: f.feature },
      }),
    /checkout SHA changed/,
  );
  assert.throws(
    () => f.verify({ baseSha: f.candidate, comparisonBase: f.tranche, environment }),
    /not on canonical Main first-parent/,
  );
});
