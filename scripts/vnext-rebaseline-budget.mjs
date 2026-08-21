import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const contractPath = 'scripts/vnext-rebaseline-budget.v1.json';
export const policyPaths = Object.freeze([
  '.github/workflows/pr-ci.yml',
  'package.json',
  contractPath,
  'scripts/vnext-rebaseline-budget.mjs',
  'scripts/vnext-rebaseline-budget.test.mjs',
]);

const protocol = 'combo.vnext-rebaseline-budget/1';
const shaPattern = /^[0-9a-f]{40}$/;
const hardCeilings = Object.freeze({
  maxChangedFilesPerPullRequest: 30,
  maxChangedLinesPerFile: 1200,
  maxChangedLinesPerPullRequest: 5000,
  maxChangedLinesFromBase: 70000,
});

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
      'baseSha',
      'donorSha',
      'compatibility',
      'allowedFiles',
      'allowedPathPrefixes',
      'limits',
    ],
    'budget contract',
  );
  invariant(value.protocol === protocol, 'budget protocol changed');
  invariant(value.schemaVersion === 1, 'budget schemaVersion must be 1');
  invariant(value.scopeId === 'vnext-r1-r3-test-only', 'budget scopeId changed');
  invariant(
    shaPattern.test(value.baseSha) && shaPattern.test(value.donorSha),
    'baseSha and donorSha must be full lowercase commit SHAs',
  );
  invariant(value.baseSha !== value.donorSha, 'baseSha and donorSha must differ');
  exactKeys(
    value.compatibility,
    ['preservePostgresMigrationHistory', 'preserveWorkerSqliteSchemaHistory'],
    'compatibility',
  );
  invariant(
    value.compatibility.preservePostgresMigrationHistory === false,
    'PostgreSQL migration history preservation is out of scope',
  );
  invariant(
    value.compatibility.preserveWorkerSqliteSchemaHistory === false,
    'Worker SQLite schema history preservation is out of scope',
  );
  sortedUniqueStrings(value.allowedFiles, 'allowedFiles');
  sortedUniqueStrings(value.allowedPathPrefixes, 'allowedPathPrefixes', { prefix: true });
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

export function assessPullRequest(contract, entries) {
  const changedPolicyPaths = entries.filter(({ path }) => policyPaths.includes(path));
  if (changedPolicyPaths.length > 0) {
    invariant(
      entries.every(({ path }) => policyPaths.includes(path)),
      'budget policy changes must be governance-only',
    );
  } else {
    for (const { path } of entries)
      invariant(pathAllowed(contract, path), `path is outside the R1-R3 rebuild scope: ${path}`);
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
  return { mode: changedPolicyPaths.length > 0 ? 'GOVERNANCE_ONLY' : 'PRODUCT', ...summary };
}

export function assessCumulative(contract, entries) {
  for (const { path } of entries) {
    invariant(
      policyPaths.includes(path) || pathAllowed(contract, path),
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
  const comparisonBase = git(['merge-base', baseRef, 'HEAD']).trim();
  invariant(shaPattern.test(comparisonBase), 'comparison base is unavailable');
  const donorObjectAvailable = commitExists(contract.donorSha);
  if (donorObjectAvailable) {
    invariant(
      isAncestor(contract.baseSha, contract.donorSha),
      'baseSha must be an ancestor of donorSha',
    );
    invariant(
      !isAncestor(contract.donorSha, 'HEAD'),
      'the donor branch must never be merged into the rebuild',
    );
  }
  const pullRequest = assessPullRequest(contract, collectDiff(comparisonBase));
  const cumulative = assessCumulative(contract, collectDiff(contract.baseSha));
  return {
    pullRequest,
    cumulative,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(verifyRepository())}\n`);
  } catch (error) {
    process.stderr.write(`vnext rebaseline budget failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
