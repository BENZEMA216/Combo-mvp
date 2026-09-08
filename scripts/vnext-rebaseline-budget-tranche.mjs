import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const trancheContractPath = 'scripts/vnext-rebaseline-budget.v6.json';
export const archivedBudgetPath = 'scripts/vnext-rebaseline-budget.v5.json';
export const trancheCeilings = Object.freeze({
  maxChangedFilesPerPullRequest: 30,
  maxChangedLinesPerFile: 1200,
  maxChangedLinesPerPullRequest: 5000,
  maxChangedLinesFromBase: 15000,
});

export const legacyV5Lock = Object.freeze({
  protocol: 'combo.vnext-rebaseline-budget/5',
  repository: 'dangdang-tech/Combo',
  targetBranch: 'main',
  contractPath: archivedBudgetPath,
  contractSha256: '7587abab4e2950dd2bad1945b696d0a9d1ec469235c7c0fe1bbceaee186bee4b',
  baseSha: '9997aedceeba5ff68cf50b6bc52a85e952121f15',
  headSha: '39e5b1b5c281c864a62974a15b51b6d0572cf6d0',
  rawDiffSha256: 'ee8ea095e0216a5d3f93a3efc76932fd03b6a2058e4cf483bbe423ce2a46b80e',
  changedFiles: 147,
  changedLines: 14060,
  maxChangedLinesPerFile: 571,
});

export const lightweightTransferScopeFiles = Object.freeze([
  'apps/authoring/src/__tests__/agent-transfer-fixture.ts',
  'apps/authoring/src/__tests__/agent-transfer.pg.test.ts',
  'apps/authoring/src/__tests__/agent-transfer.test.ts',
  'apps/authoring/src/modules/agent-draft/index.ts',
  'apps/web/src/App.agentPackages.test.tsx',
  'apps/web/src/App.tsx',
  'apps/web/src/api/agentPackages.test.ts',
  'apps/web/src/api/agentPackages.ts',
  'apps/web/src/api/index.ts',
  'apps/web/src/pages/agents/AgentReleasePage.test.tsx',
  'apps/web/src/pages/agents/AgentReleasePage.tsx',
  'apps/web/src/pages/agents/AgentTransferPage.test.tsx',
  'apps/web/src/pages/agents/AgentTransferPage.tsx',
  'apps/web/src/pages/agents/README.md',
  'apps/web/src/pages/agents/agentPackages.css',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  invariant(JSON.stringify(actual) === JSON.stringify(expected), message);
}

export function parseTrancheContract(source, archivedBudget) {
  const contract = JSON.parse(source);
  invariant(
    source === `${JSON.stringify(contract, null, 2)}\n`,
    'v6 contract must be canonical JSON with one trailing newline',
  );
  equal(
    Object.keys(contract),
    [
      'protocol',
      'schemaVersion',
      'scopeId',
      'trancheId',
      'baseSha',
      'legacyV5',
      'compatibility',
      'allowedFiles',
      'allowedPathPrefixes',
      'maintenanceFile',
      'limits',
    ],
    'v6 contract keys or key order changed',
  );
  invariant(contract.protocol === 'combo.vnext-rebaseline-budget/6', 'v6 protocol changed');
  invariant(contract.schemaVersion === 6, 'v6 schemaVersion changed');
  invariant(contract.scopeId === 'lightweight-agent-product-v6', 'v6 scopeId changed');
  invariant(contract.trancheId === 'lightweight-agent-transfer-loop', 'v6 trancheId changed');
  invariant(contract.baseSha === legacyV5Lock.headSha, 'v6 base must equal the locked Main SHA');
  equal(contract.legacyV5, legacyV5Lock, 'legacy v5 receipt changed');
  invariant(archivedBudget.baseSha === legacyV5Lock.baseSha, 'legacy v5 baseline changed');
  equal(archivedBudget.limits, trancheCeilings, 'legacy v5 ceilings changed');
  equal(contract.limits, trancheCeilings, 'v6 must preserve the exact v5 ceilings');
  for (const field of ['compatibility', 'allowedPathPrefixes', 'maintenanceFile']) {
    equal(contract[field], archivedBudget[field], `v6 must preserve the v5 ${field}`);
  }
  const expectedFiles = [...archivedBudget.allowedFiles, ...lightweightTransferScopeFiles].sort();
  invariant(new Set(expectedFiles).size === expectedFiles.length, 'v6 scope delta overlaps v5');
  equal(
    contract.allowedFiles,
    expectedFiles,
    'v6 allowedFiles must add only 15 exact transfer files',
  );
  return contract;
}

export function verifyLegacyV5Receipt({ source, committedSource, entries, rawDiffSha256 }) {
  invariant(
    createHash('sha256').update(source).digest('hex') === legacyV5Lock.contractSha256,
    'legacy v5 contract bytes changed',
  );
  invariant(source === committedSource, 'legacy v5 contract must match its locked Main head');
  invariant(rawDiffSha256 === legacyV5Lock.rawDiffSha256, 'legacy v5 raw diff receipt changed');
  const totals = {
    changedFiles: entries.length,
    changedLines: entries.reduce((sum, entry) => sum + entry.changedLines, 0),
    maxChangedLinesPerFile: entries.reduce((max, entry) => Math.max(max, entry.changedLines), 0),
  };
  for (const [field, value] of Object.entries(totals)) {
    invariant(value === legacyV5Lock[field], `legacy v5 ${field} receipt changed`);
  }
  invariant(
    totals.changedLines <= trancheCeilings.maxChangedLinesFromBase,
    'legacy v5 cumulative changed-line budget exceeded',
  );
  return { verified: true, headSha: legacyV5Lock.headSha, ...totals };
}

// The caller obtains comparisonBase from git merge-base. This separately proves that
// both it and the immutable tranche base are on a trusted Main first-parent history.
export function verifyMainlineTrancheBase({ repoRoot, baseSha, comparisonBase, environment }) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const shaPattern = /^[0-9a-f]{40}$/;
  const ancestor = (base, head) => {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', base, head], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    invariant(result.status === 0 || result.status === 1, 'tranche ancestry proof is unavailable');
    return result.status === 0;
  };
  invariant(
    shaPattern.test(baseSha) && shaPattern.test(comparisonBase),
    'invalid tranche base SHA',
  );
  invariant(
    git(['rev-parse', '--is-shallow-repository']) === 'false',
    'full Main history is required',
  );
  const head = git(['rev-parse', 'HEAD']);
  invariant(
    ancestor(baseSha, comparisonBase),
    'tranche base must be an ancestor of comparison base',
  );
  invariant(ancestor(baseSha, head), 'tranche base must be an ancestor of HEAD');
  invariant(ancestor(comparisonBase, head), 'comparison base must be an ancestor of HEAD');
  let mainHead;
  if (environment.GITHUB_ACTIONS === 'true') {
    invariant(
      environment.GITHUB_REPOSITORY === legacyV5Lock.repository,
      'tranche proof requires the canonical GitHub repository',
    );
    const expectedHead = environment.MERGE_SHA || environment.SOURCE_SHA;
    invariant(
      shaPattern.test(expectedHead ?? '') && expectedHead === head,
      'tranche checkout SHA changed',
    );
    if (environment.GITHUB_EVENT_NAME === 'pull_request') {
      invariant(environment.GITHUB_BASE_REF === 'main', 'tranche PR must target canonical Main');
      invariant(
        shaPattern.test(environment.BASE_SHA ?? '') && environment.BASE_SHA === comparisonBase,
        'tranche PR comparison base must equal immutable BASE_SHA',
      );
      equal(
        git(['rev-list', '--parents', '-n', '1', head]).split(' ').slice(1),
        [environment.BASE_SHA, environment.HEAD_SHA],
        'tranche PR must use the exact verified two-parent merge',
      );
      mainHead = environment.BASE_SHA;
    } else if (
      environment.GITHUB_EVENT_NAME === 'push' &&
      environment.GITHUB_REF === 'refs/heads/main'
    ) {
      invariant(environment.SOURCE_SHA === head, 'Main tranche check requires exact SOURCE_SHA');
      invariant(
        git(['rev-parse', 'HEAD^1']) === comparisonBase,
        'Main comparison base must be first parent',
      );
      mainHead = environment.SOURCE_SHA;
    }
  }
  if (mainHead === undefined) {
    const canonicalUrls = [
      'https://github.com/dangdang-tech/Combo.git',
      'https://github.com/dangdang-tech/Combo',
      'git@github.com:dangdang-tech/Combo.git',
      'ssh://git@github.com/dangdang-tech/Combo.git',
    ];
    invariant(
      canonicalUrls.includes(git(['remote', 'get-url', 'origin'])),
      'canonical origin is required',
    );
    mainHead = git(['rev-parse', 'refs/remotes/origin/main^{commit}']);
  }
  const firstParents = new Set(git(['rev-list', '--first-parent', mainHead]).split('\n'));
  invariant(
    firstParents.has(baseSha),
    'tranche base is not on canonical Main first-parent history',
  );
  invariant(
    firstParents.has(comparisonBase),
    'comparison base is not on canonical Main first-parent history',
  );
  return { verified: true, baseSha, mainHead, comparisonBase };
}
