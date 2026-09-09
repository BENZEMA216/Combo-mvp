import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  agentDesignScopeFiles,
  designScopeContractPath,
  legacyV6Lock,
  parseDesignScopeContract,
  verifyLegacyV6Receipt,
} from './vnext-rebaseline-budget-design-scope.mjs';
import {
  archivedBudgetPath,
  parseTrancheContract,
  trancheCeilings,
  trancheContractPath,
} from './vnext-rebaseline-budget-tranche.mjs';
import {
  assessCumulative,
  assessPullRequest,
  contractPath,
  isExactMaintenanceModeBootstrap,
  maintenanceModeBootstrap,
  parseContract,
  policyPaths,
} from './vnext-rebaseline-budget.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archivedBudget = parseContract(readFileSync(join(repoRoot, archivedBudgetPath), 'utf8'));
const archivedSource = readFileSync(join(repoRoot, trancheContractPath), 'utf8');
const archivedTranche = parseTrancheContract(archivedSource, archivedBudget);
const source = readFileSync(join(repoRoot, designScopeContractPath), 'utf8');
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const parse = (value) => parseDesignScopeContract(value, archivedSource, archivedBudget);
const contract = parse(source);
const entry = (path, changedLines = 1) => ({
  path,
  additions: changedLines,
  deletions: 0,
  changedLines,
});
const expectedDesignFiles = [
  'apps/web/src/App.landing.test.tsx',
  'apps/web/src/components/AgentIcon.tsx',
  'apps/web/src/components/CopyButton.tsx',
  'apps/web/src/components/CopyInstruction.test.tsx',
  'apps/web/src/components/CopyInstruction.tsx',
  'apps/web/src/components/copyInstruction.css',
  'apps/web/src/pages/LoginPage.test.tsx',
  'apps/web/src/pages/LoginPage.tsx',
  'apps/web/src/pages/agents/AgentPackageReview.tsx',
  'apps/web/src/pages/agents/AgentTransferState.ts',
  'apps/web/src/pages/landing/LandingPage.test.tsx',
  'apps/web/src/pages/landing/LandingPage.tsx',
  'apps/web/src/pages/landing/landing.css',
  'apps/web/src/shell/PublicLayout.test.tsx',
  'apps/web/src/shell/PublicLayout.tsx',
];

test('the active v7 contract adds exactly 15 design files without starting a new tranche', () => {
  assert.equal(contractPath, designScopeContractPath);
  assert.deepEqual(agentDesignScopeFiles, expectedDesignFiles);
  assert.equal(expectedDesignFiles.length, 15);
  assert.deepEqual(
    contract.allowedFiles,
    [...archivedTranche.allowedFiles, ...expectedDesignFiles].sort(),
  );
  assert.deepEqual(contract.legacyV6, legacyV6Lock);
  assert.equal(contract.baseSha, '39e5b1b5c281c864a62974a15b51b6d0572cf6d0');
  assert.equal(contract.trancheId, archivedTranche.trancheId);
  assert.deepEqual(contract.limits, trancheCeilings);
  assert.deepEqual(contract.allowedPathPrefixes, archivedTranche.allowedPathPrefixes);
  assert.deepEqual(contract.compatibility, archivedTranche.compatibility);
  assert.equal(
    assessPullRequest(
      contract,
      expectedDesignFiles.map((path) => entry(path)),
    ).mode,
    'PRODUCT',
  );
  assert.equal(source, canonical(contract));
});

test('v7 rejects malformed, duplicate, reordered, unknown and altered identity fields', () => {
  assert.throws(() => parse('{'), SyntaxError);
  assert.throws(() => parse(`${source}\n`), /canonical JSON/);
  assert.throws(
    () =>
      parse(source.replace('"schemaVersion": 7,', '"schemaVersion": 7,\n  "schemaVersion": 7,')),
    /canonical JSON/,
  );
  assert.throws(() => parse(canonical({ ...contract, status: 'PASS' })), /keys or key order/);
  const { protocol, ...rest } = contract;
  assert.throws(() => parse(canonical({ ...rest, protocol })), /keys or key order/);
  for (const [field, value] of [
    ['protocol', 'combo.vnext-rebaseline-budget/6'],
    ['schemaVersion', 6],
    ['scopeId', 'unbounded-product'],
  ]) {
    assert.throws(() => parse(canonical({ ...contract, [field]: value })), /changed/);
  }
});

test('v7 cannot alter any history receipt, compatibility, prefix, baseline or numeric limit', () => {
  for (const field of ['legacyV5', 'legacyV6']) {
    for (const [key, value] of Object.entries(contract[field])) {
      const changed = structuredClone(contract);
      changed[field][key] = typeof value === 'number' ? value + 1 : `${value}-changed`;
      assert.throws(() => parse(canonical(changed)), /receipt changed|preserve/, `${field}.${key}`);
    }
  }
  for (const field of Object.keys(trancheCeilings)) {
    for (const delta of [-1, 1]) {
      const changed = structuredClone(contract);
      changed.limits[field] += delta;
      assert.throws(() => parse(canonical(changed)), /preserve the v6 limits/);
    }
  }
  const mutations = [
    (v) => {
      v.baseSha = legacyV6Lock.headSha;
    },
    (v) => {
      v.trancheId = 'new-budget';
    },
    (v) => {
      v.compatibility.preservePostgresMigrationHistory = false;
    },
    (v) => {
      v.compatibility.preserveWorkerSqliteSchemaHistory = false;
    },
    (v) => v.allowedPathPrefixes.push('apps/web/'),
    (v) => v.allowedPathPrefixes.push('apps/web/src/components/'),
    (v) => v.allowedPathPrefixes.pop(),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(contract);
    mutate(changed);
    assert.throws(() => parse(canonical(changed)), /preserve/);
  }
});

test('v7 rejects added, missing, duplicate or malformed paths and unapproved neighboring files', () => {
  const mutations = [
    (v) => v.allowedFiles.push('apps/web/src/pages/agents/Unapproved.tsx'),
    (v) => v.allowedFiles.splice(v.allowedFiles.indexOf(expectedDesignFiles[0]), 1),
    (v) => v.allowedFiles.push(v.allowedFiles[0]),
    (v) => v.allowedFiles.push('../outside'),
    (v) => v.allowedFiles.push('apps/web/'),
    (v) => v.allowedFiles.reverse(),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(contract);
    mutate(changed);
    assert.throws(() => parse(canonical(changed)), /15 exact design files/);
  }
  for (const path of [
    'apps/web/src/pages/agents/Unapproved.tsx',
    'apps/web/src/pages/landing/Unapproved.tsx',
    'apps/web/src/shell/Unapproved.tsx',
    'apps/web/src/components/Unapproved.tsx',
    'apps/web/src/components/AgentIcon.test.tsx',
    'apps/web/src/pages/LoginPage.a11y.test.tsx',
    'apps/web/src/index.css',
  ]) {
    assert.throws(() => assessPullRequest(contract, [entry(path)]), /outside/);
  }
});

test('only v7 migrates the exact LoginPage test to product and cannot reuse the old bootstrap', () => {
  const loginTest = maintenanceModeBootstrap.maintenanceFile;
  const product = entry('apps/web/src/pages/agents/AgentTransferPage.tsx');
  assert.equal(contract.maintenanceFile, null);
  assert.equal(assessPullRequest(contract, [entry(loginTest)]).mode, 'PRODUCT');
  assert.equal(assessPullRequest(contract, [entry(loginTest), product]).mode, 'PRODUCT');
  for (const maintenanceFile of [loginTest, 'apps/web/src/pages/LoginPage.tsx', '']) {
    assert.throws(
      () => parse(canonical({ ...contract, maintenanceFile })),
      /retire the maintenance-only slot/,
    );
  }
  const entries = maintenanceModeBootstrap.paths.map((path) => entry(path));
  const context = { comparisonBase: maintenanceModeBootstrap.baseSha };
  for (const archived of [archivedBudget, archivedTranche]) {
    assert.equal(assessPullRequest(archived, [entry(loginTest)]).mode, 'MAINTENANCE');
    assert.throws(
      () => assessPullRequest(archived, [entry(loginTest), product]),
      /maintenance-only/,
    );
    assert.equal(
      assessPullRequest(archived, entries, context).mode,
      'GOVERNANCE_MAINTENANCE_BOOTSTRAP',
    );
    assert.equal(
      isExactMaintenanceModeBootstrap({ ...context, entries, contract: archived }),
      true,
    );
    assert.equal(
      isExactMaintenanceModeBootstrap({
        ...context,
        entries: entries.slice(1),
        contract: archived,
      }),
      false,
    );
  }
  assert.equal(isExactMaintenanceModeBootstrap({ ...context, entries, contract }), false);
  assert.throws(() => assessPullRequest(contract, entries, context), /governance-only/);
});

test('new governance paths stay isolated and counted without expanding archived v6 cumulative scope', () => {
  for (const path of [
    designScopeContractPath,
    'scripts/vnext-rebaseline-budget-design-scope.mjs',
    'scripts/vnext-rebaseline-budget-design-scope.test.mjs',
    'scripts/vnext-rebaseline-budget.v7.md',
  ]) {
    assert.ok(policyPaths.includes(path));
    assert.equal(assessPullRequest(contract, [entry(path)]).mode, 'GOVERNANCE_ONLY');
    assert.equal(assessCumulative(contract, [entry(path, 200)]).changedLines, 200);
    assert.throws(() => assessCumulative(archivedTranche, [entry(path)]), /outside/);
    for (const productPath of expectedDesignFiles) {
      assert.throws(
        () => assessPullRequest(contract, [entry(path), entry(productPath)]),
        /governance-only/,
      );
    }
  }
  for (const path of expectedDesignFiles.filter(
    (path) => path !== archivedTranche.maintenanceFile,
  )) {
    assert.throws(() => assessPullRequest(archivedTranche, [entry(path)]), /outside/);
    assert.throws(() => assessCumulative(archivedTranche, [entry(path)]), /outside/);
  }
  assert.equal(assessCumulative(archivedTranche, [entry(trancheContractPath)]).changedFiles, 1);
});

test('all four unchanged budgets are enforced for the v7 scope', () => {
  assert.throws(
    () =>
      assessPullRequest(
        contract,
        Array.from({ length: 31 }, (_, i) => entry(`apps/runtime/${i}.ts`)),
      ),
    /changed-file budget exceeded/,
  );
  assert.throws(
    () => assessPullRequest(contract, [entry(expectedDesignFiles[0], 1201)]),
    /per-file changed-line budget exceeded/,
  );
  assert.throws(
    () =>
      assessPullRequest(
        contract,
        expectedDesignFiles.slice(0, 5).map((path, i) => entry(path, i === 0 ? 1001 : 1000)),
      ),
    /pull request changed-line budget exceeded/,
  );
  assert.equal(
    assessCumulative(contract, [entry(expectedDesignFiles[0], 15000)]).changedLines,
    15000,
  );
  assert.throws(
    () => assessCumulative(contract, [entry(expectedDesignFiles[0], 15001)]),
    /cumulative changed-line budget exceeded/,
  );
});

test('the v6 archive is checked against actual locked Main bytes and tampering fails closed', () => {
  const committedSource = execFileSync(
    'git',
    ['show', `${legacyV6Lock.headSha}:${trancheContractPath}`],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const input = { source: archivedSource, committedSource };
  assert.deepEqual(verifyLegacyV6Receipt(input), { verified: true, ...legacyV6Lock });
  assert.throws(
    () => verifyLegacyV6Receipt({ ...input, source: `${archivedSource} ` }),
    /bytes changed/,
  );
  assert.throws(
    () => verifyLegacyV6Receipt({ ...input, committedSource: `${committedSource} ` }),
    /locked Main head/,
  );
  assert.throws(
    () => parseDesignScopeContract(source, `${archivedSource} `, archivedBudget),
    /bytes changed/,
  );
  assert.throws(
    () =>
      parseDesignScopeContract(source, archivedSource, {
        ...archivedBudget,
        limits: { ...trancheCeilings, maxChangedLinesFromBase: 15001 },
      }),
    /legacy v5 ceilings changed/,
  );
});
