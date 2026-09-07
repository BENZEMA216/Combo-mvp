import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const legacyContractPath = 'scripts/vnext-rebaseline-budget.v1.json';
export const previousContractPath = 'scripts/vnext-rebaseline-budget.v2.json';
export const supersededContractPath = 'scripts/vnext-rebaseline-budget.v3.json';
export const previousBudgetPath = 'scripts/vnext-rebaseline-budget.v4.json';
export const contractPath = 'scripts/vnext-rebaseline-budget.v5.json';
export const policyPaths = Object.freeze([
  '.agents/skills/github-collaboration/SKILL.md',
  '.agents/skills/github-collaboration/references/governance-and-contributions.md',
  '.agents/skills/github-collaboration/references/quality-and-pull-requests.md',
  '.agents/skills/github-collaboration/references/worktree-lifecycle.md',
  '.github/workflows/pr-ci.yml',
  'AGENTS.md',
  legacyContractPath,
  'package.json',
  previousContractPath,
  supersededContractPath,
  previousBudgetPath,
  contractPath,
  'scripts/vnext-rebaseline-budget.mjs',
  'scripts/vnext-rebaseline-budget.test.mjs',
]);

const protocol = 'combo.vnext-rebaseline-budget/5';
const shaPattern = /^[0-9a-f]{40}$/;
const hardCeilings = Object.freeze({
  maxChangedFilesPerPullRequest: 30,
  maxChangedLinesPerFile: 1200,
  maxChangedLinesPerPullRequest: 5000,
  maxChangedLinesFromBase: 15000,
});

export const paymentPlatformScope = Object.freeze({
  allowedFiles: Object.freeze([
    'apps/authz/README.md',
    'apps/authz/package.json',
    'apps/authz/src/__tests__/agent-access-routes.test.ts',
    'apps/authz/src/__tests__/agent-access.test.ts',
    'apps/authz/src/agent-access-routes.ts',
    'apps/authz/src/agent-access.ts',
    'apps/authz/src/app.ts',
    'apps/authz/src/env.ts',
    'apps/authz/src/index.ts',
    'docs/payment-sdk-handoff-acceptance.md',
    'docs/payment-sdk-integration.md',
    'docs/research-development-issues-audit.md',
    'infra/Dockerfile.v2',
    'infra/host/combo-v2-test.conf',
    'infra/host/release/README.md',
    'infra/host/release/combo-v2-billing-forward.service',
    'infra/host/release/combo-v2-llm-gateway-forward.service',
    'infra/k8s/v2/authz.yaml',
    'infra/k8s/v2/billing.yaml',
    'infra/k8s/v2/job-migrate.yaml',
    'infra/k8s/v2/llm-gateway.yaml',
    'infra/k8s/v2/restart-life.yaml',
    'scripts/configure-v2-payment-secrets.mjs',
    'scripts/configure-v2-payment-secrets.test.mjs',
    'scripts/render-v2.mjs',
    'scripts/render-v2.test.mjs',
  ]),
  allowedPathPrefixes: Object.freeze([
    'apps/billing/',
    'apps/llm-gateway/',
    'packages/payment-protocol/',
    'tests/payment-sdk-handoff/',
  ]),
});

export const privateAgentDraftScopeFiles = Object.freeze([
  'apps/authoring/src/__tests__/agent-draft-fixture.ts',
  'apps/authoring/src/__tests__/agent-draft.pg.test.ts',
  'apps/authoring/src/__tests__/agent-draft.test.ts',
  'apps/authoring/src/modules/agent-draft/README.md',
  'apps/authoring/src/modules/agent-draft/routes.ts',
  'apps/authoring/src/modules/agent-draft/service.ts',
  'scripts/README.md',
]);

export const initialTrancheLock = Object.freeze({
  protocol: 'combo.vnext-rebaseline-budget/1',
  scopeId: 'vnext-r1-r3-test-only',
  baseSha: 'd15a985c67c2b9b5e08a5b8bc03a772fb543aecb',
  donorSha: '871c8f43b0725fa2f471173b2fbcf380ccfba930',
  headSha: 'a1f11aed98d465fa91044beba7ccbcb95629030f',
  changedFiles: 300,
  changedLines: 70000,
  contractSha256: 'e0ef9bfa1674c83d3dc8437db63e274f4e8b14810b44ca31bdb56949c4107792',
});

export const previousTrancheLock = Object.freeze({
  protocol: 'combo.vnext-rebaseline-budget/2',
  scopeId: 'vnext-r1-r3-test-only',
  trancheId: 'fixed-hosted-agent-test-beta',
  baseSha: 'a1f11aed98d465fa91044beba7ccbcb95629030f',
  headSha: '353c25a4b318daa1893207e993dd0f1d2067c28e',
  changedFiles: 84,
  changedLines: 14798,
  contractSha256: '729464fa5d3d8538bdebef23c73b9ebe17076758bc74412177eecd545199e9df',
});

export const supersededPlatformV2BootstrapLock = Object.freeze({
  protocol: 'combo.platform-v2-bootstrap/1',
  repository: 'dangdang-tech/Combo',
  pullRequestNumber: 223,
  previousMainSha: '353c25a4b318daa1893207e993dd0f1d2067c28e',
  candidateSha: '0cfeb3c981bc7807ff000713b64a6dbf280e274b',
  rawDiffSha256: '9b9bc134973ae113e2516c97bf479d842e0f491ff7baf13efa4dc9f3e280533d',
  changedFiles: 90,
  changedLines: 7929,
  maxChangedLinesPerFile: 364,
});

export const supersededAdmissionLock = Object.freeze({
  protocol: 'combo.platform-v2-bootstrap-supersession/1',
  contractPath: supersededContractPath,
  contractSha256: '205eed9d7dbc16d060834d6f861d0f03b0f9ba279945e43c5a1fe0ac8471f97b',
  governanceBaseSha: '353c25a4b318daa1893207e993dd0f1d2067c28e',
  governanceHeadSha: '5ce34f27cfe49d7442a1f49b6a63b8bc1906660e',
  rawDiffSha256: 'a9ad6aeb8a551e73034e7cb910f26ed274c465be049c7f92aaba8c4e3e4ae85e',
  changedFiles: 4,
  changedLines: 828,
  maxChangedLinesPerFile: 395,
  candidateSha: supersededPlatformV2BootstrapLock.candidateSha,
  stateAtSupersession: 'PENDING',
  disposition: 'SUPERSEDED',
  supersededByProtocol: 'combo.platform-v2-bootstrap/2',
  supersededByCandidateSha: '9997aedceeba5ff68cf50b6bc52a85e952121f15',
});

export const platformV2BootstrapLock = Object.freeze({
  protocol: 'combo.platform-v2-bootstrap/2',
  repository: 'dangdang-tech/Combo',
  pullRequestNumber: 223,
  targetBranch: 'main',
  previousMainSha: '5ce34f27cfe49d7442a1f49b6a63b8bc1906660e',
  candidateSha: '9997aedceeba5ff68cf50b6bc52a85e952121f15',
  rawDiffSha256: '9b7f088a33ad7c6bb9e7ba2dc34ecba341d9cb1ccc46d9f38d37848c82db4f3f',
  changedFiles: 107,
  changedLines: 11810,
  maxChangedLinesPerFile: 563,
  mergeShape: 'TWO_LAYER_MERGE_COMMIT',
});

export const previousBudgetLock = Object.freeze({
  protocol: 'combo.vnext-rebaseline-budget/4',
  contractPath: previousBudgetPath,
  contractSha256: 'e13f3392cdc2c03531ccee2489e256c6f06a85725adfcdada18d76d9b9666718',
  governanceBaseSha: '9997aedceeba5ff68cf50b6bc52a85e952121f15',
  governanceHeadSha: 'fda4f756b58b8514f9d3f5116b9c8f9709b4f2a5',
  rawDiffSha256: '1ec11fbd8c71d54f0123afe5daebb7908e3038a5943865336884bc2fed6009fc',
  changedFiles: 3,
  changedLines: 440,
  maxChangedLinesPerFile: 214,
});

export const productGoalLock = Object.freeze({
  goalId: 'G-001@v1',
  semanticName: '可分享 Agent',
  text: '让用户把一段和自己AGENT的对话、项目或旅程变成一个可分享的 Agent，让其他人打开链接就能使用它，或是用一段话就能让自己的AGENT获取对应能力。',
  sha256: 'd1fcc3355deca962632194c4fbfcd26c4ce5f4494f1af0f813c7ff0a4d7be9ee',
  approvedProjectSha256s: Object.freeze([
    '45dc4af0c2d55d6e9b2d2dec0dcf1d6d0939a5f550b6dbf505cf7ad556c8a098',
    'bba99e15d714c7e8ab02949c12be7f344f0fd2382188510976edb33e23247aea',
  ]),
  headings: Object.freeze(['## 一、唯一产品目标', '## 二、目标用户体验', '## 三、唯一产物模型']),
});

const requiredProductAgentPrelude = Object.freeze([
  '# 项目级智能体协作约定',
  '- 开始任何任务前，必须先读取根目录 `PROJECT.md`、`CLAUDE.md`、本文件，以及任务涉及目录中的说明文件。涉及产品设计、工程拆解、路线或验收时，还必须读取 `ENGINEERING.md`。',
  '- `PROJECT.md` 是用户已经确认的唯一产品基线，定义当前产品目标、目标用户体验和唯一产物模型。除非用户明确要求修改，否则不得改写；需求或实现与其冲突时必须停止并说明冲突，不能自行调整目标。',
  '- `ENGINEERING.md` 是从 `PROJECT.md` 推导出的可变工程工作稿，可在开发中验证和修订，但不得反向覆盖 `PROJECT.md`。任务执行期间若 `PROJECT.md` 发生变化，必须重新读取后再继续。',
]);

export const productBaselineBootstrap = Object.freeze({
  baseSha: 'bc2b6d5693cb9344c343a64dadf7091618fbfe40',
  paths: Object.freeze([
    legacyContractPath,
    'scripts/vnext-rebaseline-budget.mjs',
    'scripts/vnext-rebaseline-budget.test.mjs',
  ]),
});

export const maintenanceModeBootstrap = Object.freeze({
  baseSha: 'acea2c250a279fd53d9c4b7a509cb379280d003f',
  maintenanceFile: 'apps/web/src/pages/LoginPage.test.tsx',
  paths: Object.freeze([
    'apps/web/src/pages/LoginPage.test.tsx',
    'scripts/vnext-rebaseline-budget.mjs',
    'scripts/vnext-rebaseline-budget.test.mjs',
    legacyContractPath,
  ]),
});

const productBaselineFiles = Object.freeze([
  'AGENTS.md',
  'ENGINEERING.md',
  'PROJECT.md',
  'README.md',
]);

const requiredEngineeringPrelude = [
  '# Combo 工程假设与开发记录',
  '',
  '> `WORKING DRAFT` · 开发中验证',
  '>',
  '> [PROJECT.md](./PROJECT.md) 定义已经确认的产品基线。本文记录为实现该产品而提出的工程假设，可随真实开发和用户体验持续调整；发生冲突时，以 `PROJECT.md` 为准。',
].join('\n');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  invariant(
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected),
    `${label} keys or key order changed`,
  );
}

function safeRepoPath(value, { prefix = false } = {}) {
  invariant(
    typeof value === 'string' && value.length > 0,
    'repository paths must be non-empty strings',
  );
  invariant(
    !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.includes('//'),
    `${value} is not a safe repository path`,
  );
  const segments = value.split('/').filter(Boolean);
  invariant(
    !segments.includes('.') && !segments.includes('..'),
    `${value} is not a safe repository path`,
  );
  invariant(!prefix || value.endsWith('/'), `${value} must end with /`);
  invariant(prefix || !value.endsWith('/'), `${value} must name a file`);
}

function sortedUniqueStrings(values, label, options) {
  invariant(Array.isArray(values) && values.length > 0, `${label} must be a non-empty array`);
  for (const value of values) safeRepoPath(value, options);
  invariant(new Set(values).size === values.length, `${label} contains duplicates`);
  invariant(
    JSON.stringify(values) === JSON.stringify([...values].sort()),
    `${label} must be sorted`,
  );
}

export function parseContract(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`budget contract is not valid JSON: ${error.message}`);
  }
  invariant(
    source === `${JSON.stringify(value, null, 2)}\n`,
    'budget contract must be canonical JSON with one trailing newline',
  );
  exactKeys(
    value,
    [
      'protocol',
      'schemaVersion',
      'scopeId',
      'trancheId',
      'baseSha',
      'previousBudget',
      'previousTranche',
      'supersededAdmission',
      'platformV2Bootstrap',
      'compatibility',
      'allowedFiles',
      'allowedPathPrefixes',
      'maintenanceFile',
      'limits',
    ],
    'budget contract',
  );
  invariant(value.protocol === protocol, 'budget protocol changed');
  invariant(value.schemaVersion === 5, 'budget schemaVersion must be 5');
  invariant(value.scopeId === 'vnext-with-platform-payment-v5', 'budget scopeId changed');
  invariant(value.trancheId === 'issue-308-payment-platform-contract', 'budget trancheId changed');
  invariant(shaPattern.test(value.baseSha), 'baseSha must be a full lowercase commit SHA');
  exactKeys(
    value.previousBudget,
    [
      'protocol',
      'contractPath',
      'contractSha256',
      'governanceBaseSha',
      'governanceHeadSha',
      'rawDiffSha256',
      'changedFiles',
      'changedLines',
      'maxChangedLinesPerFile',
    ],
    'previousBudget',
  );
  invariant(
    JSON.stringify(value.previousBudget) === JSON.stringify(previousBudgetLock),
    'previousBudget changed',
  );
  exactKeys(
    value.previousTranche,
    [
      'protocol',
      'scopeId',
      'trancheId',
      'baseSha',
      'headSha',
      'changedFiles',
      'changedLines',
      'contractSha256',
    ],
    'previousTranche',
  );
  invariant(
    JSON.stringify(value.previousTranche) === JSON.stringify(previousTrancheLock),
    'previousTranche changed',
  );
  exactKeys(
    value.supersededAdmission,
    [
      'protocol',
      'contractPath',
      'contractSha256',
      'governanceBaseSha',
      'governanceHeadSha',
      'rawDiffSha256',
      'changedFiles',
      'changedLines',
      'maxChangedLinesPerFile',
      'candidateSha',
      'stateAtSupersession',
      'disposition',
      'supersededByProtocol',
      'supersededByCandidateSha',
    ],
    'supersededAdmission',
  );
  invariant(
    JSON.stringify(value.supersededAdmission) === JSON.stringify(supersededAdmissionLock),
    'supersededAdmission changed',
  );
  exactKeys(
    value.platformV2Bootstrap,
    [
      'protocol',
      'repository',
      'pullRequestNumber',
      'targetBranch',
      'previousMainSha',
      'candidateSha',
      'rawDiffSha256',
      'changedFiles',
      'changedLines',
      'maxChangedLinesPerFile',
      'mergeShape',
    ],
    'platformV2Bootstrap',
  );
  invariant(
    value.platformV2Bootstrap.candidateSha === value.baseSha,
    'baseSha must equal the V2 bootstrap candidate',
  );
  invariant(
    JSON.stringify(value.platformV2Bootstrap) === JSON.stringify(platformV2BootstrapLock),
    'platformV2Bootstrap changed',
  );
  invariant(
    value.previousBudget.governanceBaseSha === value.baseSha,
    'baseSha must retain the cumulative baseline from the previous budget',
  );
  invariant(
    value.supersededAdmission.supersededByProtocol === value.platformV2Bootstrap.protocol &&
      value.supersededAdmission.supersededByCandidateSha === value.platformV2Bootstrap.candidateSha,
    'superseded admission replacement pointer changed',
  );
  invariant(
    value.supersededAdmission.governanceBaseSha === value.previousTranche.headSha,
    'superseded governance must continue previousTranche',
  );
  invariant(
    value.platformV2Bootstrap.previousMainSha === value.supersededAdmission.governanceHeadSha,
    'V2 bootstrap must continue the superseding governance head',
  );
  exactKeys(
    value.compatibility,
    ['preservePostgresMigrationHistory', 'preserveWorkerSqliteSchemaHistory'],
    'compatibility',
  );
  invariant(
    value.compatibility.preservePostgresMigrationHistory === true,
    'PostgreSQL migration history must be preserved',
  );
  invariant(
    value.compatibility.preserveWorkerSqliteSchemaHistory === true,
    'Worker SQLite schema history must be preserved',
  );
  sortedUniqueStrings(value.allowedFiles, 'allowedFiles');
  sortedUniqueStrings(value.allowedPathPrefixes, 'allowedPathPrefixes', { prefix: true });
  safeRepoPath(value.maintenanceFile);
  invariant(
    !policyPaths.includes(value.maintenanceFile),
    `${value.maintenanceFile} cannot be both policy and maintenance`,
  );
  invariant(
    !pathAllowed(value, value.maintenanceFile),
    `${value.maintenanceFile} cannot be both product and maintenance`,
  );
  exactKeys(value.limits, Object.keys(hardCeilings), 'limits');
  for (const [name, ceiling] of Object.entries(hardCeilings)) {
    const limit = value.limits[name];
    invariant(
      Number.isSafeInteger(limit) && limit > 0 && limit <= ceiling,
      `${name} must be an integer from 1 through ${ceiling}`,
    );
  }
  return value;
}

export function parseNumstat(numstat, changedNames) {
  const stats = new Map();
  for (const record of numstat.split('\0')) {
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    invariant(firstTab > 0 && secondTab > firstTab, 'malformed git numstat record');
    const additionsText = record.slice(0, firstTab);
    const deletionsText = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    invariant(
      additionsText !== '-' && deletionsText !== '-',
      `binary change is not allowed: ${path}`,
    );
    const additions = Number(additionsText);
    const deletions = Number(deletionsText);
    invariant(Number.isSafeInteger(additions) && additions >= 0, `invalid additions for ${path}`);
    invariant(Number.isSafeInteger(deletions) && deletions >= 0, `invalid deletions for ${path}`);
    invariant(!stats.has(path), `duplicate numstat path: ${path}`);
    stats.set(path, { path, additions, deletions, changedLines: additions + deletions });
  }

  const names = changedNames.split('\0').filter(Boolean);
  invariant(new Set(names).size === names.length, 'git changed-name output contains duplicates');
  return names.map(
    (path) => stats.get(path) ?? { path, additions: 0, deletions: 0, changedLines: 0 },
  );
}

function pathAllowed(contract, path) {
  return (
    contract.allowedFiles.includes(path) ||
    contract.allowedPathPrefixes.some((prefix) => path.startsWith(prefix))
  );
}

function summarize(entries) {
  return {
    changedFiles: entries.length,
    changedLines: entries.reduce((sum, entry) => sum + entry.changedLines, 0),
  };
}

function maxChangedLines(entries) {
  return entries.reduce((maximum, entry) => Math.max(maximum, entry.changedLines), 0);
}

export function isExactPlatformV2Bootstrap({
  entries,
  rawDiffSha256,
  bootstrapState,
  admissionShapeValid,
  previousMainIsAncestor,
}) {
  const summary = summarize(entries);
  return (
    bootstrapState === 'ADMITTING' &&
    admissionShapeValid === true &&
    previousMainIsAncestor === true &&
    rawDiffSha256 === platformV2BootstrapLock.rawDiffSha256 &&
    summary.changedFiles === platformV2BootstrapLock.changedFiles &&
    summary.changedLines === platformV2BootstrapLock.changedLines &&
    maxChangedLines(entries) === platformV2BootstrapLock.maxChangedLinesPerFile
  );
}

export function classifyPlatformV2Bootstrap({ candidateInBase, candidateInHead }) {
  invariant(
    !candidateInBase || candidateInHead,
    'V2 candidate cannot be in base but absent from HEAD',
  );
  if (candidateInBase) return 'CONSUMED';
  if (candidateInHead) return 'ADMITTING';
  return 'PENDING';
}

export function isAuthorizedPlatformV2AdmissionContext({
  githubActions,
  eventName,
  ref,
  repository,
  pullRequestNumber,
  baseRef,
}) {
  if (githubActions !== 'true') return true;
  if (repository !== platformV2BootstrapLock.repository) return false;
  if (eventName === 'pull_request') {
    return (
      String(pullRequestNumber) === String(platformV2BootstrapLock.pullRequestNumber) &&
      baseRef === platformV2BootstrapLock.targetBranch
    );
  }
  if (eventName === 'workflow_call' || eventName === 'workflow_dispatch') return true;
  return eventName === 'push' && ref === 'refs/heads/main';
}

export function isExactPlatformV2AdmissionShape({
  comparisonBase,
  candidateSha,
  headParents,
  sourceParents,
  requireOuterMerge,
}) {
  const directSourceIntegration =
    headParents.length === 2 &&
    headParents[0] === candidateSha &&
    headParents[1] === comparisonBase;
  if (!requireOuterMerge && directSourceIntegration) return true;
  return (
    headParents.length === 2 &&
    headParents[0] === comparisonBase &&
    sourceParents.length === 2 &&
    sourceParents[0] === candidateSha &&
    sourceParents[1] === comparisonBase
  );
}

export function isExactMaintenanceModeBootstrap({ comparisonBase, entries, contract }) {
  const changedPaths = entries.map(({ path }) => path).sort();
  return (
    comparisonBase === maintenanceModeBootstrap.baseSha &&
    contract.maintenanceFile === maintenanceModeBootstrap.maintenanceFile &&
    JSON.stringify(changedPaths) === JSON.stringify([...maintenanceModeBootstrap.paths].sort())
  );
}

export function assessPullRequest(
  contract,
  entries,
  {
    comparisonBase,
    rawDiffSha256,
    bootstrapState = 'PENDING',
    admissionShapeValid = false,
    previousMainIsAncestor = false,
  } = {},
) {
  const changedPolicyPaths = entries.filter(({ path }) => policyPaths.includes(path));
  const changedMaintenancePaths = entries.filter(({ path }) => path === contract.maintenanceFile);
  const exactPlatformV2Bootstrap = isExactPlatformV2Bootstrap({
    entries,
    rawDiffSha256,
    bootstrapState,
    admissionShapeValid,
    previousMainIsAncestor,
  });
  let mode;
  if (exactPlatformV2Bootstrap) {
    mode = 'PLATFORM_V2_BOOTSTRAP';
  } else if (isExactMaintenanceModeBootstrap({ comparisonBase, entries, contract })) {
    mode = 'GOVERNANCE_MAINTENANCE_BOOTSTRAP';
  } else if (changedPolicyPaths.length > 0) {
    invariant(
      entries.every(({ path }) => policyPaths.includes(path)),
      'budget policy changes must be governance-only',
    );
    mode = 'GOVERNANCE_ONLY';
  } else if (changedMaintenancePaths.length > 0) {
    invariant(
      entries.every(({ path }) => path === contract.maintenanceFile),
      'budget maintenance changes must be maintenance-only',
    );
    mode = 'MAINTENANCE';
  } else {
    for (const { path } of entries)
      invariant(pathAllowed(contract, path), `path is outside the R1-R3 rebuild scope: ${path}`);
    mode = 'PRODUCT';
  }
  const summary = summarize(entries);
  if (!exactPlatformV2Bootstrap) {
    invariant(
      summary.changedFiles <= contract.limits.maxChangedFilesPerPullRequest,
      'pull request changed-file budget exceeded',
    );
    invariant(
      summary.changedLines <= contract.limits.maxChangedLinesPerPullRequest,
      'pull request changed-line budget exceeded',
    );
  }
  for (const entry of entries) {
    invariant(
      entry.changedLines <= contract.limits.maxChangedLinesPerFile,
      `per-file changed-line budget exceeded: ${entry.path}`,
    );
  }
  return { mode, ...summary };
}

export function assessCumulative(contract, entries) {
  for (const { path } of entries) {
    invariant(
      policyPaths.includes(path) ||
        path === contract.maintenanceFile ||
        pathAllowed(contract, path),
      `cumulative path is outside the R1-R3 rebuild scope: ${path}`,
    );
  }
  const summary = summarize(entries);
  invariant(
    summary.changedLines <= contract.limits.maxChangedLinesFromBase,
    'R1-R3 cumulative changed-line budget exceeded',
  );
  return summary;
}

function verifyPreviousTranche(contract) {
  const previous = contract.previousTranche;
  invariant(commitExists(previous.baseSha), 'previousTranche base commit is unavailable');
  invariant(commitExists(previous.headSha), 'previousTranche head commit is unavailable');
  invariant(
    isAncestor(previous.baseSha, previous.headSha),
    'previousTranche base must be an ancestor of its head',
  );
  const previousSource = readFileSync(join(repoRoot, previousContractPath), 'utf8');
  invariant(
    createHash('sha256').update(previousSource).digest('hex') === previous.contractSha256,
    'previousTranche contract receipt changed',
  );
  const committedPreviousSource = git(['show', `${previous.headSha}:${previousContractPath}`]);
  invariant(
    previousSource === committedPreviousSource,
    'previousTranche contract must match its committed head',
  );
  const previousContract = JSON.parse(previousSource);
  invariant(
    JSON.stringify(previousContract.previousTranche) === JSON.stringify(initialTrancheLock),
    'initial tranche receipt changed',
  );
  const donorObjectAvailable = commitExists(initialTrancheLock.donorSha);
  if (donorObjectAvailable) {
    invariant(
      isAncestor(initialTrancheLock.baseSha, initialTrancheLock.donorSha),
      'initial tranche base must be an ancestor of its donor',
    );
    invariant(
      !isAncestor(initialTrancheLock.donorSha, previous.headSha),
      'the initial donor branch must never be merged into the rebuild',
    );
    invariant(
      !isAncestor(initialTrancheLock.donorSha, 'HEAD'),
      'the initial donor branch must never be merged into the active tranche',
    );
  }
  const initialSource = readFileSync(join(repoRoot, legacyContractPath), 'utf8');
  invariant(
    createHash('sha256').update(initialSource).digest('hex') === initialTrancheLock.contractSha256,
    'initial tranche contract receipt changed',
  );
  const committedInitialSource = git([
    'show',
    `${initialTrancheLock.headSha}:${legacyContractPath}`,
  ]);
  invariant(
    initialSource === committedInitialSource,
    'initial tranche contract must match its committed head',
  );
  const entries = collectCommittedDiff(previous.baseSha, previous.headSha);
  for (const { path } of entries) {
    invariant(
      policyPaths.includes(path) ||
        path === previousContract.maintenanceFile ||
        pathAllowed(previousContract, path),
      `previousTranche path is outside the declared rebuild scope: ${path}`,
    );
  }
  const summary = summarize(entries);
  invariant(
    summary.changedFiles === previous.changedFiles &&
      summary.changedLines === previous.changedLines,
    'previousTranche committed totals changed',
  );
  return summary;
}

function verifySupersededAdmission(contract) {
  const receipt = contract.supersededAdmission;
  invariant(commitExists(receipt.governanceBaseSha), 'superseded governance base is unavailable');
  invariant(commitExists(receipt.governanceHeadSha), 'superseded governance head is unavailable');
  invariant(commitExists(receipt.candidateSha), 'superseded V2 candidate is unavailable');
  invariant(
    isAncestor(receipt.governanceBaseSha, receipt.governanceHeadSha),
    'superseded governance base must be an ancestor of its head',
  );
  invariant(
    !isAncestor(receipt.candidateSha, receipt.governanceHeadSha),
    'superseded V2 candidate must have remained pending at the governance head',
  );

  const previousSource = readFileSync(join(repoRoot, supersededContractPath), 'utf8');
  invariant(
    previousSource === `${JSON.stringify(JSON.parse(previousSource), null, 2)}\n`,
    'superseded contract must remain canonical JSON',
  );
  invariant(
    createHash('sha256').update(previousSource).digest('hex') === receipt.contractSha256,
    'superseded contract receipt changed',
  );
  invariant(
    git(['show', `${receipt.governanceHeadSha}:${supersededContractPath}`]) === previousSource,
    'superseded contract must match its committed governance head',
  );
  const previousContract = JSON.parse(previousSource);
  invariant(
    previousContract.protocol === 'combo.vnext-rebaseline-budget/3' &&
      previousContract.schemaVersion === 3,
    'superseded contract protocol changed',
  );
  invariant(
    JSON.stringify(previousContract.previousTranche) === JSON.stringify(previousTrancheLock),
    'superseded contract previousTranche changed',
  );
  invariant(
    JSON.stringify(previousContract.platformV2Bootstrap) ===
      JSON.stringify(supersededPlatformV2BootstrapLock),
    'superseded V2 bootstrap receipt changed',
  );
  const successorBudget = JSON.parse(readFileSync(join(repoRoot, previousBudgetPath), 'utf8'));
  for (const field of [
    'compatibility',
    'allowedFiles',
    'allowedPathPrefixes',
    'maintenanceFile',
    'limits',
  ]) {
    invariant(
      JSON.stringify(successorBudget[field]) === JSON.stringify(previousContract[field]),
      `v4 must preserve the v3 ${field}`,
    );
  }

  const entries = collectCommittedDiff(receipt.governanceBaseSha, receipt.governanceHeadSha);
  invariant(
    entries.every(({ path }) => policyPaths.includes(path)),
    'superseding governance bridge must contain policy files only',
  );
  const summary = summarize(entries);
  invariant(
    summary.changedFiles === receipt.changedFiles &&
      summary.changedLines === receipt.changedLines &&
      maxChangedLines(entries) === receipt.maxChangedLinesPerFile,
    'superseding governance bridge totals changed',
  );
  invariant(
    collectCommittedRawDiffSha256(receipt.governanceBaseSha, receipt.governanceHeadSha) ===
      receipt.rawDiffSha256,
    'superseding governance raw diff receipt changed',
  );
  return {
    verified: true,
    stateAtSupersession: receipt.stateAtSupersession,
    disposition: receipt.disposition,
  };
}

function verifyPreviousBudget(contract) {
  const receipt = contract.previousBudget;
  invariant(commitExists(receipt.governanceBaseSha), 'previous budget base is unavailable');
  invariant(commitExists(receipt.governanceHeadSha), 'previous budget head is unavailable');
  invariant(
    isAncestor(receipt.governanceBaseSha, receipt.governanceHeadSha),
    'previous budget base must be an ancestor of its head',
  );
  invariant(
    isAncestor(receipt.governanceHeadSha, 'HEAD'),
    'active budget must descend from the previous budget head',
  );

  const previousSource = readFileSync(join(repoRoot, previousBudgetPath), 'utf8');
  invariant(
    previousSource === `${JSON.stringify(JSON.parse(previousSource), null, 2)}\n`,
    'previous budget contract must remain canonical JSON',
  );
  invariant(
    createHash('sha256').update(previousSource).digest('hex') === receipt.contractSha256,
    'previous budget contract receipt changed',
  );
  invariant(
    git(['show', `${receipt.governanceHeadSha}:${previousBudgetPath}`]) === previousSource,
    'previous budget contract must match its committed governance head',
  );
  const previousBudget = JSON.parse(previousSource);
  invariant(
    previousBudget.protocol === receipt.protocol && previousBudget.schemaVersion === 4,
    'previous budget protocol changed',
  );
  for (const field of [
    'baseSha',
    'previousTranche',
    'supersededAdmission',
    'platformV2Bootstrap',
    'compatibility',
    'maintenanceFile',
    'limits',
  ]) {
    invariant(
      JSON.stringify(contract[field]) === JSON.stringify(previousBudget[field]),
      `v5 must preserve the v4 ${field}`,
    );
  }

  verifyV5Scope(contract, previousBudget);

  const entries = collectCommittedDiff(receipt.governanceBaseSha, receipt.governanceHeadSha);
  invariant(
    entries.every(({ path }) => policyPaths.includes(path)),
    'previous budget governance bridge must contain policy files only',
  );
  const summary = summarize(entries);
  invariant(
    summary.changedFiles === receipt.changedFiles &&
      summary.changedLines === receipt.changedLines &&
      maxChangedLines(entries) === receipt.maxChangedLinesPerFile,
    'previous budget governance bridge totals changed',
  );
  invariant(
    collectCommittedRawDiffSha256(receipt.governanceBaseSha, receipt.governanceHeadSha) ===
      receipt.rawDiffSha256,
    'previous budget governance raw diff receipt changed',
  );
  return { verified: true, governanceHeadSha: receipt.governanceHeadSha };
}

export function verifyV5Scope(contract, previousBudget) {
  const expectedAllowedFiles = [
    ...previousBudget.allowedFiles,
    ...paymentPlatformScope.allowedFiles,
    ...privateAgentDraftScopeFiles,
  ].sort();
  const expectedAllowedPathPrefixes = [
    ...previousBudget.allowedPathPrefixes,
    ...paymentPlatformScope.allowedPathPrefixes,
  ].sort();
  invariant(
    new Set(expectedAllowedFiles).size === expectedAllowedFiles.length &&
      JSON.stringify(contract.allowedFiles) === JSON.stringify(expectedAllowedFiles),
    'v5 allowedFiles must add only the payment handoff and exact private Agent Draft files',
  );
  invariant(
    new Set(expectedAllowedPathPrefixes).size === expectedAllowedPathPrefixes.length &&
      JSON.stringify(contract.allowedPathPrefixes) === JSON.stringify(expectedAllowedPathPrefixes),
    'v5 allowedPathPrefixes must add only the payment platform implementation paths',
  );
}

function verifyPlatformV2Bootstrap(contract) {
  const bootstrap = contract.platformV2Bootstrap;
  invariant(
    bootstrap.previousMainSha === contract.supersededAdmission.governanceHeadSha,
    'V2 bootstrap previous Main changed',
  );
  invariant(bootstrap.candidateSha === contract.baseSha, 'V2 bootstrap candidate changed');
  invariant(commitExists(bootstrap.candidateSha), 'V2 bootstrap candidate is unavailable');
  invariant(
    isAncestor(bootstrap.previousMainSha, bootstrap.candidateSha),
    'V2 bootstrap candidate must descend from previous Main',
  );
  invariant(
    bootstrap.candidateSha !== contract.supersededAdmission.candidateSha &&
      isAncestor(contract.supersededAdmission.candidateSha, bootstrap.candidateSha),
    'replacement V2 candidate must repair and descend from the superseded candidate',
  );
  const entries = collectCommittedDiff(bootstrap.previousMainSha, bootstrap.candidateSha);
  const summary = summarize(entries);
  invariant(
    summary.changedFiles === bootstrap.changedFiles &&
      summary.changedLines === bootstrap.changedLines &&
      maxChangedLines(entries) === bootstrap.maxChangedLinesPerFile,
    'V2 bootstrap committed totals changed',
  );
  invariant(
    collectCommittedRawDiffSha256(bootstrap.previousMainSha, bootstrap.candidateSha) ===
      bootstrap.rawDiffSha256,
    'V2 bootstrap raw diff receipt changed',
  );
  return { candidateAvailable: true };
}

export function isExactProductBaselineBootstrap({ comparisonBase, entries, contract }) {
  const changedPaths = entries.map(({ path }) => path).sort();
  return (
    comparisonBase === productBaselineBootstrap.baseSha &&
    JSON.stringify(changedPaths) === JSON.stringify([...productBaselineBootstrap.paths].sort()) &&
    productBaselineFiles.every((path) => contract.allowedFiles.includes(path))
  );
}

export function verifyProductBaselineSources({
  projectSource,
  agentsSource,
  engineeringSource,
  allowBootstrapWithoutProject = false,
}) {
  if (projectSource === undefined) {
    invariant(
      allowBootstrapWithoutProject,
      'PROJECT.md product baseline is required before product changes',
    );
    return { status: 'BOOTSTRAP_PENDING' };
  }

  invariant(typeof agentsSource === 'string', 'AGENTS.md product baseline rules are required');
  invariant(typeof engineeringSource === 'string', 'ENGINEERING.md working draft is required');
  const computedGoalSha256 = createHash('sha256').update(productGoalLock.text).digest('hex');
  invariant(computedGoalSha256 === productGoalLock.sha256, 'internal product goal digest changed');
  invariant(
    projectSource.includes(`> **${productGoalLock.text}**`),
    'PROJECT.md product goal text changed',
  );
  invariant(
    projectSource.includes(`### \`${productGoalLock.goalId}\` · ${productGoalLock.semanticName}`),
    'PROJECT.md product goal ID or semantic name changed',
  );
  invariant(
    projectSource.includes(`目标文本 SHA-256：\`${productGoalLock.sha256}\``),
    'PROJECT.md product goal digest changed',
  );
  const headings = projectSource.match(/^## .+$/gm) ?? [];
  invariant(
    JSON.stringify(headings) === JSON.stringify(productGoalLock.headings),
    'PROJECT.md must contain exactly the three confirmed product sections',
  );
  const activeAgentLines = agentsSource.split('\n').filter((line) => line.length > 0);
  invariant(
    JSON.stringify(activeAgentLines.slice(0, requiredProductAgentPrelude.length)) ===
      JSON.stringify(requiredProductAgentPrelude),
    'AGENTS.md must begin with the active product baseline rules',
  );
  for (const line of activeAgentLines.slice(requiredProductAgentPrelude.length)) {
    invariant(
      !line.includes('PROJECT.md') && !line.includes('ENGINEERING.md'),
      'AGENTS.md contains an additional product baseline directive',
    );
  }
  invariant(
    engineeringSource.startsWith(`${requiredEngineeringPrelude}\n`),
    'ENGINEERING.md must begin with the active subordinate working-draft notice',
  );
  const engineeringBody = engineeringSource.slice(requiredEngineeringPrelude.length);
  for (const forbiddenClaim of [
    '最终工程真源',
    '唯一工程真源',
    '最终真源',
    '唯一真源',
    '以 ENGINEERING.md 为准',
    '以 `ENGINEERING.md` 为准',
    '覆盖 PROJECT.md',
    '覆盖 `PROJECT.md`',
  ]) {
    invariant(
      !engineeringBody.includes(forbiddenClaim),
      'ENGINEERING.md cannot claim authority over PROJECT.md',
    );
  }
  const projectSha256 = createHash('sha256').update(projectSource).digest('hex');
  invariant(
    productGoalLock.approvedProjectSha256s.includes(projectSha256),
    'PROJECT.md product baseline changed',
  );
  return { status: 'LOCKED', goalId: productGoalLock.goalId, sha256: productGoalLock.sha256 };
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...options });
}

function isAncestor(ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr.trim() || `cannot compare ${ancestor} and ${descendant}`);
}

function commitExists(sha) {
  const result = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status === 0) return true;
  if (result.status === 1 || result.status === 128) return false;
  throw new Error(result.stderr.trim() || `cannot inspect ${sha}`);
}

function commitParents(commit) {
  const fields = git(['rev-list', '--parents', '-n', '1', commit]).trim().split(' ');
  invariant(
    fields.length >= 1 && shaPattern.test(fields[0]),
    `cannot inspect parents for ${commit}`,
  );
  return fields.slice(1);
}

function verifyPlatformV2AdmissionShape({ comparisonBase, candidateSha, requireOuterMerge }) {
  const headParents = commitParents('HEAD');
  const sourceParents =
    headParents.length === 2 && headParents[0] === comparisonBase
      ? commitParents(headParents[1])
      : [];
  invariant(
    isExactPlatformV2AdmissionShape({
      comparisonBase,
      candidateSha,
      headParents,
      sourceParents,
      requireOuterMerge,
    }),
    'V2 bootstrap must be an exact two-parent Main integration merge',
  );
  return {
    valid: true,
    shape: headParents[0] === comparisonBase ? 'GITHUB_MERGE_COMMIT' : 'LOCAL_SOURCE_INTEGRATION',
  };
}

function verifyPlatformV2GovernanceBase(comparisonBase) {
  const currentSource = readFileSync(join(repoRoot, contractPath), 'utf8');
  const baseSource = git(['show', `${comparisonBase}:${contractPath}`]);
  invariant(
    baseSource === currentSource,
    'V2 admission base must contain the exact active budget contract',
  );
}

function verifyGithubCheckoutIdentity(environment) {
  if (environment.GITHUB_ACTIONS !== 'true') return;
  const expectedHeadSha = environment.MERGE_SHA || environment.SOURCE_SHA;
  invariant(
    typeof expectedHeadSha === 'string' && shaPattern.test(expectedHeadSha),
    'GitHub budget gate requires an immutable expected HEAD SHA',
  );
  invariant(git(['rev-parse', 'HEAD']).trim() === expectedHeadSha, 'GitHub checkout HEAD changed');
  invariant(
    spawnSync('git', ['diff', '--cached', '--quiet', 'HEAD'], { cwd: repoRoot }).status === 0,
    'GitHub checkout index changed',
  );
}

function collectDiff(base) {
  return parseNumstat(
    git(['diff', '--cached', '--no-renames', '--numstat', '-z', base]),
    git(['diff', '--cached', '--no-renames', '--name-only', '-z', base]),
  );
}

function collectCommittedDiff(base, head) {
  return parseNumstat(
    git(['diff', '--no-renames', '--numstat', '-z', base, head]),
    git(['diff', '--no-renames', '--name-only', '-z', base, head]),
  );
}

function collectRawDiffSha256(base) {
  const rawDiff = execFileSync(
    'git',
    ['diff', '--cached', '--raw', '-z', '--full-index', '--no-renames', '--abbrev=40', base],
    { cwd: repoRoot },
  );
  return createHash('sha256').update(rawDiff).digest('hex');
}

function collectCommittedRawDiffSha256(base, head) {
  const rawDiff = execFileSync(
    'git',
    ['diff', '--raw', '-z', '--full-index', '--no-renames', '--abbrev=40', base, head],
    { cwd: repoRoot },
  );
  return createHash('sha256').update(rawDiff).digest('hex');
}

export function defaultBaseRef(environment = process.env) {
  if (environment.GITHUB_BASE_REF) return environment.BASE_SHA;
  if (environment.GITHUB_EVENT_NAME === 'push' && environment.GITHUB_REF === 'refs/heads/main')
    return 'HEAD^1';
  return 'origin/main';
}

export function verifyRepository({ baseRef, environment = process.env } = {}) {
  const resolvedBaseRef = baseRef ?? defaultBaseRef(environment);
  const contract = parseContract(readFileSync(join(repoRoot, contractPath), 'utf8'));
  if (environment.GITHUB_ACTIONS === 'true') {
    invariant(
      environment.GITHUB_REPOSITORY === contract.platformV2Bootstrap.repository,
      'budget gate is running in the wrong GitHub repository',
    );
  }
  verifyGithubCheckoutIdentity(environment);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  invariant(
    untracked.length === 0,
    `budget check requires new files to be staged: ${untracked.join(', ')}`,
  );
  invariant(
    spawnSync('git', ['diff', '--quiet'], { cwd: repoRoot }).status === 0,
    'budget check requires all tracked changes to be staged',
  );
  const previousBudget = verifyPreviousBudget(contract);
  const previousTranche = verifyPreviousTranche(contract);
  const supersededAdmission = verifySupersededAdmission(contract);
  const platformV2Receipt = verifyPlatformV2Bootstrap(contract);
  const comparisonBase = git(['merge-base', resolvedBaseRef, 'HEAD']).trim();
  invariant(shaPattern.test(comparisonBase), 'comparison base is unavailable');
  const previousMainIsAncestor = isAncestor(
    contract.platformV2Bootstrap.previousMainSha,
    comparisonBase,
  );
  invariant(previousMainIsAncestor, 'pull request base must descend from previous Main');
  const candidateInBase = isAncestor(contract.platformV2Bootstrap.candidateSha, comparisonBase);
  const candidateInHead = isAncestor(contract.platformV2Bootstrap.candidateSha, 'HEAD');
  const bootstrapState = classifyPlatformV2Bootstrap({ candidateInBase, candidateInHead });
  let admission = { valid: false, shape: null };
  if (bootstrapState === 'ADMITTING') {
    verifyPlatformV2GovernanceBase(comparisonBase);
    admission = verifyPlatformV2AdmissionShape({
      comparisonBase,
      candidateSha: contract.platformV2Bootstrap.candidateSha,
      requireOuterMerge:
        environment.GITHUB_EVENT_NAME === 'pull_request' ||
        (environment.GITHUB_EVENT_NAME === 'push' && environment.GITHUB_REF === 'refs/heads/main'),
    });
  }
  const platformV2Bootstrap = {
    ...platformV2Receipt,
    state: bootstrapState,
    candidateInBase,
    candidateInHead,
    admissionShape: admission.shape,
  };
  const pullRequestEntries = collectDiff(comparisonBase);
  const pullRequest = assessPullRequest(contract, pullRequestEntries, {
    comparisonBase,
    rawDiffSha256: collectRawDiffSha256(comparisonBase),
    bootstrapState,
    admissionShapeValid: admission.valid,
    previousMainIsAncestor,
  });
  if (bootstrapState === 'PENDING') {
    invariant(
      pullRequest.mode === 'GOVERNANCE_ONLY',
      'only governance changes are allowed until the V2 bootstrap candidate is integrated',
    );
  }
  if (bootstrapState === 'ADMITTING') {
    invariant(
      isAuthorizedPlatformV2AdmissionContext({
        githubActions: environment.GITHUB_ACTIONS,
        eventName: environment.GITHUB_EVENT_NAME,
        ref: environment.GITHUB_REF,
        repository: environment.GITHUB_REPOSITORY,
        pullRequestNumber: environment.PULL_REQUEST_NUMBER,
        baseRef: environment.GITHUB_BASE_REF,
      }),
      'V2 bootstrap admission is not authorized in this GitHub context',
    );
    invariant(
      pullRequest.mode === 'PLATFORM_V2_BOOTSTRAP',
      'the V2 admission must match the exact bootstrap payload',
    );
  }
  const projectPath = join(repoRoot, 'PROJECT.md');
  const agentsPath = join(repoRoot, 'AGENTS.md');
  const engineeringPath = join(repoRoot, 'ENGINEERING.md');
  const productBaseline = verifyProductBaselineSources({
    projectSource: existsSync(projectPath) ? readFileSync(projectPath, 'utf8') : undefined,
    agentsSource: existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : undefined,
    engineeringSource: existsSync(engineeringPath)
      ? readFileSync(engineeringPath, 'utf8')
      : undefined,
    allowBootstrapWithoutProject:
      pullRequest.mode === 'GOVERNANCE_ONLY' &&
      isAncestor(productBaselineBootstrap.baseSha, 'HEAD') &&
      isExactProductBaselineBootstrap({
        comparisonBase: productBaselineBootstrap.baseSha,
        entries: collectDiff(productBaselineBootstrap.baseSha),
        contract,
      }),
  });
  const cumulative =
    bootstrapState !== 'PENDING'
      ? { status: bootstrapState, ...assessCumulative(contract, collectDiff(contract.baseSha)) }
      : { status: 'PENDING_PLATFORM_V2_BOOTSTRAP', changedFiles: 0, changedLines: 0 };
  return {
    pullRequest,
    productBaseline,
    previousBudget,
    previousTranche,
    supersededAdmission,
    platformV2Bootstrap,
    cumulative,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(verifyRepository())}\n`);
  } catch (error) {
    process.stderr.write(`vnext rebaseline budget failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
