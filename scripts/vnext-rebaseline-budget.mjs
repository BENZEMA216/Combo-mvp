import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const legacyContractPath = 'scripts/vnext-rebaseline-budget.v1.json';
export const contractPath = 'scripts/vnext-rebaseline-budget.v2.json';
export const policyPaths = Object.freeze([
  '.agents/skills/github-collaboration/SKILL.md',
  '.agents/skills/github-collaboration/references/governance-and-contributions.md',
  '.agents/skills/github-collaboration/references/quality-and-pull-requests.md',
  '.agents/skills/github-collaboration/references/worktree-lifecycle.md',
  '.github/workflows/pr-ci.yml',
  'AGENTS.md',
  legacyContractPath,
  'package.json',
  contractPath,
  'scripts/vnext-rebaseline-budget.mjs',
  'scripts/vnext-rebaseline-budget.test.mjs',
]);

const protocol = 'combo.vnext-rebaseline-budget/2';
const shaPattern = /^[0-9a-f]{40}$/;
const hardCeilings = Object.freeze({
  maxChangedFilesPerPullRequest: 30,
  maxChangedLinesPerFile: 1200,
  maxChangedLinesPerPullRequest: 5000,
  maxChangedLinesFromBase: 15000,
});

export const previousTrancheLock = Object.freeze({
  protocol: 'combo.vnext-rebaseline-budget/1',
  scopeId: 'vnext-r1-r3-test-only',
  baseSha: 'd15a985c67c2b9b5e08a5b8bc03a772fb543aecb',
  donorSha: '871c8f43b0725fa2f471173b2fbcf380ccfba930',
  headSha: 'a1f11aed98d465fa91044beba7ccbcb95629030f',
  changedFiles: 300,
  changedLines: 70000,
  contractSha256: 'e0ef9bfa1674c83d3dc8437db63e274f4e8b14810b44ca31bdb56949c4107792',
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
      'previousTranche',
      'compatibility',
      'allowedFiles',
      'allowedPathPrefixes',
      'maintenanceFile',
      'limits',
    ],
    'budget contract',
  );
  invariant(value.protocol === protocol, 'budget protocol changed');
  invariant(value.schemaVersion === 2, 'budget schemaVersion must be 2');
  invariant(value.scopeId === 'vnext-r1-r3-test-only', 'budget scopeId changed');
  invariant(value.trancheId === 'fixed-hosted-agent-test-beta', 'budget trancheId changed');
  invariant(shaPattern.test(value.baseSha), 'baseSha must be a full lowercase commit SHA');
  exactKeys(
    value.previousTranche,
    [
      'protocol',
      'scopeId',
      'baseSha',
      'donorSha',
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
  invariant(
    value.baseSha === value.previousTranche.headSha,
    'baseSha must continue previousTranche',
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

export function isExactMaintenanceModeBootstrap({ comparisonBase, entries, contract }) {
  const changedPaths = entries.map(({ path }) => path).sort();
  return (
    comparisonBase === maintenanceModeBootstrap.baseSha &&
    contract.maintenanceFile === maintenanceModeBootstrap.maintenanceFile &&
    JSON.stringify(changedPaths) === JSON.stringify([...maintenanceModeBootstrap.paths].sort())
  );
}

export function assessPullRequest(contract, entries, { comparisonBase } = {}) {
  const changedPolicyPaths = entries.filter(({ path }) => policyPaths.includes(path));
  const changedMaintenancePaths = entries.filter(({ path }) => path === contract.maintenanceFile);
  let mode;
  if (isExactMaintenanceModeBootstrap({ comparisonBase, entries, contract })) {
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
  invariant(
    summary.changedFiles <= contract.limits.maxChangedFilesPerPullRequest,
    'pull request changed-file budget exceeded',
  );
  invariant(
    summary.changedLines <= contract.limits.maxChangedLinesPerPullRequest,
    'pull request changed-line budget exceeded',
  );
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
  const donorObjectAvailable = commitExists(previous.donorSha);
  if (donorObjectAvailable) {
    invariant(
      isAncestor(previous.baseSha, previous.donorSha),
      'previousTranche base must be an ancestor of its donor',
    );
    invariant(
      !isAncestor(previous.donorSha, previous.headSha),
      'the previous donor branch must never be merged into the rebuild',
    );
    invariant(
      !isAncestor(previous.donorSha, 'HEAD'),
      'the previous donor branch must never be merged into the active tranche',
    );
  }
  const legacySource = readFileSync(join(repoRoot, legacyContractPath), 'utf8');
  invariant(
    createHash('sha256').update(legacySource).digest('hex') === previous.contractSha256,
    'previousTranche contract receipt changed',
  );
  const committedLegacySource = git(['show', `${previous.headSha}:${legacyContractPath}`]);
  invariant(
    legacySource === committedLegacySource,
    'previousTranche contract must match its committed head',
  );
  const legacyContract = JSON.parse(legacySource);
  const entries = collectCommittedDiff(previous.baseSha, previous.headSha);
  for (const { path } of entries) {
    invariant(
      policyPaths.includes(path) ||
        path === legacyContract.maintenanceFile ||
        pathAllowed(legacyContract, path),
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

export function defaultBaseRef(environment = process.env) {
  if (environment.GITHUB_BASE_REF) return environment.BASE_SHA;
  if (environment.GITHUB_EVENT_NAME === 'push' && environment.GITHUB_REF === 'refs/heads/main')
    return 'HEAD^1';
  return 'origin/main';
}

export function verifyRepository({ baseRef = defaultBaseRef() } = {}) {
  const contract = parseContract(readFileSync(join(repoRoot, contractPath), 'utf8'));
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
  invariant(commitExists(contract.baseSha), 'baseSha commit is unavailable');
  invariant(isAncestor(contract.baseSha, 'HEAD'), 'baseSha must be an ancestor of HEAD');
  const previousTranche = verifyPreviousTranche(contract);
  const comparisonBase = git(['merge-base', baseRef, 'HEAD']).trim();
  invariant(shaPattern.test(comparisonBase), 'comparison base is unavailable');
  const pullRequestEntries = collectDiff(comparisonBase);
  const pullRequest = assessPullRequest(contract, pullRequestEntries, { comparisonBase });
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
  const cumulative = assessCumulative(contract, collectDiff(contract.baseSha));
  return {
    pullRequest,
    productBaseline,
    previousTranche,
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
