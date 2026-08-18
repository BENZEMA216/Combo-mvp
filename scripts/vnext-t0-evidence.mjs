import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { TextDecoder } from 'node:util';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { VNEXT_G0_SUITE } from './run-vnext-g0.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const EVIDENCE_FILE = 't0-evidence.json';
const MAX_EVIDENCE_JSON_BYTES = 1_048_576;
const MAX_JUNIT_BYTES = 16 * 1024 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const JUNIT_XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
});
const SOURCE_TUPLE_PATHS = Object.freeze([
  '.github/workflows/ci.yml',
  '.github/workflows/pr-ci.yml',
  '.github/workflows/vnext-t0.yml',
  'apps/agent-gateway/vitest.config.ts',
  'apps/runtime/vitest.config.ts',
  'package.json',
  'packages/creator-agent-protocol/fixtures/index.json',
  'packages/creator-agent-protocol/openapi/creator-agent-v1.openapi.json',
  'packages/creator-agent-protocol/package.json',
  'packages/creator-agent-protocol/scripts/run-property.mjs',
  'packages/creator-agent-protocol/schemas/broker-contract.v1.json',
  'packages/creator-agent-protocol/schemas/contract-schemas.v1.json',
  'packages/creator-agent-protocol/src/__tests__/broker-contract.property.test.ts',
  'packages/creator-agent-protocol/src/__tests__/capability.property.test.ts',
  'packages/creator-agent-protocol/src/__tests__/conversation-ready-facts.property.test.ts',
  'packages/creator-agent-protocol/src/__tests__/invocation.property.test.ts',
  'packages/creator-agent-protocol/src/__tests__/property-matrix.test.ts',
  'packages/creator-agent-protocol/src/__tests__/property-matrix.ts',
  'packages/creator-agent-protocol/vitest.config.ts',
  'packages/creator-agent-snapshot/vitest.config.ts',
  'pnpm-lock.yaml',
  'scripts/environment-boundary-contract.test.mjs',
  'scripts/run-vnext-g0.mjs',
  'scripts/vnext-g0-suite.test.mjs',
  'scripts/vnext-t0-evidence.mjs',
  'scripts/vnext-t0-evidence.test.mjs',
  'scripts/vnext-t0-workflow-contract.test.mjs',
  'tests/vnext/cases/iteration-0.yaml',
  'tests/vnext/data-flow-allowlist.yaml',
  'tests/vnext/decisions.yaml',
  'tests/vnext/invariants.yaml',
  'tests/vnext/registries.yaml',
]);
const TEST_CASE_IDS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => `SCH-${String(index + 1).padStart(3, '0')}`),
);
const NON_CLAIMS = Object.freeze([
  'does-not-prove-t1-or-higher',
  'does-not-bind-release-manifest',
  'requires-successful-github-job-and-artifact-digest',
]);

function fail(message) {
  throw new Error(`VNext T0 evidence: ${message}`);
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('only safe integers are canonical evidence numbers');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  fail('unsupported canonical JSON value');
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${label} malformed UTF-8`);
  }
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys`);
  }
}

function containsControl(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function requiredEnvironment(name, maximum = 512) {
  const value = process.env[name];
  if (value === undefined || value.length < 1 || value.length > maximum || containsControl(value)) {
    fail(`${name} is missing or invalid`);
  }
  return value;
}

function optionalShaEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value === '') return null;
  if (!SHA_PATTERN.test(value)) fail(`${name} must be a lowercase 40-character SHA`);
  return value;
}

function positiveInteger(name, value) {
  if (!/^[1-9][0-9]*$/u.test(value)) fail(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name} exceeds the safe integer range`);
  return parsed;
}

function nonNegativeInteger(name, value) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) fail(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name} exceeds the safe integer range`);
  return parsed;
}

function isoDate(name, value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail(`${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function regularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  return stat;
}

function evidenceDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('evidence directory must be a non-symlink directory');
  }
}

function sourceTuple() {
  const files = SOURCE_TUPLE_PATHS.map((path) => {
    const absolute = resolve(REPOSITORY_ROOT, path);
    const stat = regularFile(absolute, `source tuple ${path}`);
    const bytes = readFileSync(absolute);
    return { path, bytes: stat.size, digest: sha256(bytes) };
  });
  return {
    files,
    digest: sha256(Buffer.from(canonicalize(files), 'utf8')),
  };
}

function xmlInteger(node, name, { optional = false } = {}) {
  const value = node?.[`@_${name}`];
  if (value === undefined && optional) return null;
  if (typeof value !== 'string') fail(`JUnit ${name} must occur exactly once`);
  return nonNegativeInteger(`JUnit ${name}`, value);
}

function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function testcaseOutcomes(testcases, profile, label) {
  const requiredAttributes =
    profile === 'node'
      ? ['@_name', '@_time', '@_classname', '@_file']
      : ['@_classname', '@_name', '@_time'];
  const allowedKeys = new Set([...requiredAttributes, 'failure', 'error', 'skipped']);
  return testcases.reduce(
    (counts, testcase) => {
      if (testcase === null || typeof testcase !== 'object' || Array.isArray(testcase)) {
        fail(`${label} JUnit testcase shape`);
      }
      onlyKeys(testcase, allowedKeys, `${label} JUnit testcase`);
      for (const attribute of requiredAttributes) {
        const value = testcase[attribute];
        if (typeof value !== 'string' || value.length < 1 || containsControl(value)) {
          fail(`${label} JUnit testcase attribute`);
        }
      }
      if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/u.test(testcase['@_time'])) {
        fail(`${label} JUnit testcase time`);
      }
      return {
        failures: counts.failures + asArray(testcase.failure).length,
        errors: counts.errors + asArray(testcase.error).length,
        skipped: counts.skipped + asArray(testcase.skipped).length,
      };
    },
    { failures: 0, errors: 0, skipped: 0 },
  );
}

function onlyKeys(node, allowed, label) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) fail(`${label} shape`);
  if (Object.keys(node).some((key) => !allowed.has(key))) fail(`${label} shape`);
}

function repositoryRelativeJUnitFile(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail(`${label} JUnit file identity`);
  const normalized = relative(REPOSITORY_ROOT, path).split(sep).join('/');
  if (normalized === '' || normalized.startsWith('../') || isAbsolute(normalized)) {
    fail(`${label} JUnit file identity`);
  }
  return normalized;
}

function nodeJunitSummary(xml, label) {
  const comments = [...xml.matchAll(/<!--([\s\S]*?)-->/gu)].map((match) => match[1].trim());
  if (comments.length !== 8) fail(`${label} JUnit summary comments`);
  const integer = (index, name) => {
    const match = comments[index].match(new RegExp(`^${name} (0|[1-9][0-9]*)$`, 'u'));
    if (match === null) fail(`${label} JUnit summary comments`);
    return nonNegativeInteger(`${label} JUnit ${name}`, match[1]);
  };
  const duration = comments[7].match(/^duration_ms (0|[1-9][0-9]*)(\.[0-9]+)?$/u);
  if (duration === null) fail(`${label} JUnit summary comments`);
  return {
    tests: integer(0, 'tests'),
    suites: integer(1, 'suites'),
    pass: integer(2, 'pass'),
    fail: integer(3, 'fail'),
    cancelled: integer(4, 'cancelled'),
    skipped: integer(5, 'skipped'),
    todo: integer(6, 'todo'),
  };
}

function junitCounts(bytes, label) {
  if (bytes.length < 1 || bytes.length > MAX_JUNIT_BYTES) fail(`${label} JUnit size`);
  const xml = decodeUtf8(bytes, `${label} JUnit`);
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/u.test(xml) || xml.includes('\0')) {
    fail(`${label} JUnit forbidden XML construct`);
  }
  const nodeSummary = label === 't0-contracts' ? nodeJunitSummary(xml, label) : null;
  if (label !== 't0-contracts' && xml.includes('<!--')) {
    fail(`${label} JUnit forbidden XML construct`);
  }
  if (XMLValidator.validate(xml, { allowBooleanAttributes: false }) !== true) {
    fail(`${label} JUnit malformed XML`);
  }
  const document = JUNIT_XML_PARSER.parse(xml);
  onlyKeys(document, new Set(['?xml', 'testsuites']), `${label} JUnit document`);
  if (document['?xml'] === undefined) fail(`${label} JUnit XML declaration`);
  const root = document.testsuites;

  if (label === 't0-contracts') {
    onlyKeys(root, new Set(['testcase']), `${label} JUnit root`);
    const testcases = asArray(root.testcase);
    const counts = { tests: testcases.length, ...testcaseOutcomes(testcases, 'node', label) };
    if (
      nodeSummary.tests !== counts.tests ||
      nodeSummary.suites !== 0 ||
      nodeSummary.pass !== counts.tests ||
      nodeSummary.fail !== counts.failures + counts.errors ||
      nodeSummary.cancelled !== 0 ||
      nodeSummary.skipped !== counts.skipped ||
      nodeSummary.todo !== 0
    ) {
      fail(`${label} JUnit summary totals`);
    }
    const files = [
      ...new Set(
        testcases.map((testcase) => repositoryRelativeJUnitFile(testcase['@_file'], label)),
      ),
    ].sort();
    return { counts, files };
  }

  onlyKeys(
    root,
    new Set(['testsuite', '@_name', '@_tests', '@_failures', '@_errors', '@_skipped', '@_time']),
    `${label} JUnit root`,
  );
  const suites = asArray(root.testsuite);
  if (suites.length === 0) fail(`${label} JUnit testsuite structure`);
  const files = [];
  const childTotals = suites.reduce(
    (counts, suite) => {
      onlyKeys(
        suite,
        new Set([
          'testcase',
          '@_name',
          '@_timestamp',
          '@_hostname',
          '@_tests',
          '@_failures',
          '@_errors',
          '@_skipped',
          '@_time',
        ]),
        `${label} JUnit testsuite`,
      );
      const tests = xmlInteger(suite, 'tests');
      const failures = xmlInteger(suite, 'failures');
      const errors = xmlInteger(suite, 'errors');
      const skipped = xmlInteger(suite, 'skipped');
      const testcases = asArray(suite.testcase);
      const outcomes = testcaseOutcomes(testcases, 'vitest', label);
      if (tests < 1) fail(`${label} JUnit empty expected suite`);
      const suiteName = suite['@_name'];
      if (
        typeof suiteName !== 'string' ||
        suiteName.length < 1 ||
        containsControl(suiteName) ||
        testcases.some((testcase) => testcase['@_classname'] !== suiteName)
      ) {
        fail(`${label} JUnit suite identity`);
      }
      files.push(suiteName);
      if (
        testcases.length !== tests ||
        outcomes.failures !== failures ||
        outcomes.errors !== errors ||
        outcomes.skipped !== skipped
      ) {
        fail(`${label} JUnit testsuite/testcase totals`);
      }
      return {
        tests: counts.tests + tests,
        failures: counts.failures + failures,
        errors: counts.errors + errors,
        skipped: counts.skipped + skipped,
      };
    },
    { tests: 0, failures: 0, errors: 0, skipped: 0 },
  );
  const aggregate = {
    tests: xmlInteger(root, 'tests'),
    failures: xmlInteger(root, 'failures'),
    errors: xmlInteger(root, 'errors'),
    skipped: xmlInteger(root, 'skipped', { optional: true }),
  };
  if (
    aggregate.tests !== childTotals.tests ||
    aggregate.failures !== childTotals.failures ||
    aggregate.errors !== childTotals.errors ||
    (aggregate.skipped !== null && aggregate.skipped !== childTotals.skipped)
  ) {
    fail(`${label} JUnit aggregate/child totals`);
  }
  if (new Set(files).size !== files.length) fail(`${label} JUnit duplicate suite`);
  return { counts: childTotals, files: files.sort() };
}

function junitArtifacts(directory) {
  return VNEXT_G0_SUITE.groups.map((group) => {
    const absolute = resolve(directory, group.junitPath);
    try {
      const stat = regularFile(absolute, group.id);
      const bytes = readFileSync(absolute);
      const result = junitCounts(bytes, group.id);
      if (canonicalize(result.files) !== canonicalize([...group.expectedJUnitFiles].sort())) {
        fail(`${group.id} JUnit file set`);
      }
      return {
        id: group.id,
        path: group.junitPath,
        status: 'PRESENT',
        bytes: stat.size,
        digest: sha256(bytes),
        counts: result.counts,
        resultFiles: result.files,
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return { id: group.id, path: group.junitPath, status: 'NOT_PRODUCED' };
    }
  });
}

function removeFailureJunitArtifacts(directory) {
  for (const group of VNEXT_G0_SUITE.groups) {
    const path = resolve(directory, group.junitPath);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() && !stat.isSymbolicLink()) fail('failure JUnit entry type');
      unlinkSync(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function evidenceFromEnvironment(directory) {
  const testedSha = requiredEnvironment('VNEXT_T0_SOURCE_SHA', 40);
  const treeSha = requiredEnvironment('VNEXT_T0_TREE_SHA', 40);
  const topLevelWorkflowSha = requiredEnvironment('VNEXT_T0_TOP_LEVEL_WORKFLOW_SHA', 40);
  for (const [name, value] of [
    ['VNEXT_T0_SOURCE_SHA', testedSha],
    ['VNEXT_T0_TREE_SHA', treeSha],
    ['VNEXT_T0_TOP_LEVEL_WORKFLOW_SHA', topLevelWorkflowSha],
  ]) {
    if (!SHA_PATTERN.test(value)) fail(`${name} must be a lowercase 40-character SHA`);
  }

  const disposition = requiredEnvironment('VNEXT_T0_DISPOSITION', 32);
  if (!['FORMAL', 'ADVISORY_ONLY'].includes(disposition)) fail('disposition');
  const cleanValue = requiredEnvironment('VNEXT_T0_CLEAN', 5);
  if (!['true', 'false'].includes(cleanValue)) fail('clean state');
  const clean = cleanValue === 'true';
  const eventName = requiredEnvironment('VNEXT_T0_EVENT_NAME', 64);
  if (!['push', 'pull_request', 'workflow_call', 'workflow_dispatch'].includes(eventName)) {
    fail('event name');
  }
  const gitRef = requiredEnvironment('VNEXT_T0_GIT_REF', 512);
  const refProtectedValue = requiredEnvironment('VNEXT_T0_REF_PROTECTED', 5);
  if (!['true', 'false'].includes(refProtectedValue)) fail('protected-ref state');
  const refProtected = refProtectedValue === 'true';
  const baseSha = optionalShaEnvironment('VNEXT_T0_BASE_SHA');
  const headSha = optionalShaEnvironment('VNEXT_T0_HEAD_SHA');
  const mergeSha = optionalShaEnvironment('VNEXT_T0_MERGE_SHA');
  const commandExecutedValue = requiredEnvironment('VNEXT_T0_COMMAND_EXECUTED', 5);
  if (!['true', 'false'].includes(commandExecutedValue)) fail('command executed state');
  const commandExecuted = commandExecutedValue === 'true';
  const commandExitCodeValue = process.env.VNEXT_T0_COMMAND_EXIT_CODE ?? '';
  const exitCode = commandExecuted
    ? nonNegativeInteger('VNEXT_T0_COMMAND_EXIT_CODE', commandExitCodeValue)
    : null;
  if (commandExecuted && exitCode > 255) fail('exit code must be <= 255');
  if (!commandExecuted && commandExitCodeValue !== '') {
    fail('a NOT_RUN command cannot carry an exit code');
  }
  const conclusion = !clean || !commandExecuted ? 'BLOCKED' : exitCode === 0 ? 'PASS' : 'FAIL';
  const startedAt = isoDate('VNEXT_T0_STARTED_AT', requiredEnvironment('VNEXT_T0_STARTED_AT', 64));
  const finishedAt = isoDate(
    'VNEXT_T0_FINISHED_AT',
    requiredEnvironment('VNEXT_T0_FINISHED_AT', 64),
  );
  if (Date.parse(finishedAt) < Date.parse(startedAt)) fail('finishedAt precedes startedAt');

  const repository = requiredEnvironment('VNEXT_T0_REPOSITORY', 256);
  if (repository !== 'dangdang-tech/Combo') fail('unexpected repository');
  const callerWorkflowPath = requiredEnvironment('VNEXT_T0_CALLER_WORKFLOW_PATH', 128);
  if (!['.github/workflows/pr-ci.yml', '.github/workflows/ci.yml'].includes(callerWorkflowPath)) {
    fail('unexpected caller workflow path');
  }
  const directCallerName = requiredEnvironment('VNEXT_T0_CALLER_WORKFLOW_NAME', 128);
  const topLevelName = requiredEnvironment('VNEXT_T0_TOP_LEVEL_WORKFLOW_NAME', 128);
  const topLevelRef = requiredEnvironment('VNEXT_T0_TOP_LEVEL_WORKFLOW_REF', 512);
  let jobContext;
  try {
    const rawJobContext = process.env.VNEXT_T0_JOB_CONTEXT_JSON;
    if (
      rawJobContext === undefined ||
      rawJobContext.length < 1 ||
      rawJobContext.length > 4096 ||
      rawJobContext.includes('\0')
    ) {
      fail('job workflow context JSON');
    }
    jobContext = JSON.parse(rawJobContext);
  } catch {
    fail('job workflow context JSON');
  }
  const jobWorkflowRef = jobContext?.workflow_ref;
  const jobWorkflowSha = jobContext?.workflow_sha;
  const jobWorkflowRepository = jobContext?.workflow_repository;
  const jobWorkflowFilePath = jobContext?.workflow_file_path;
  if (
    typeof jobWorkflowRef !== 'string' ||
    typeof jobWorkflowSha !== 'string' ||
    typeof jobWorkflowRepository !== 'string' ||
    typeof jobWorkflowFilePath !== 'string' ||
    !SHA_PATTERN.test(jobWorkflowSha) ||
    jobWorkflowRepository !== repository ||
    jobWorkflowFilePath !== '.github/workflows/vnext-t0.yml' ||
    !jobWorkflowRef.startsWith(`${repository}/.github/workflows/vnext-t0.yml@`)
  ) {
    fail('called job workflow authority');
  }
  const runId = requiredEnvironment('VNEXT_T0_RUN_ID', 32);
  if (!/^[1-9][0-9]*$/u.test(runId)) fail('run ID');
  const runnerOs = requiredEnvironment('VNEXT_T0_RUNNER_OS', 32);
  const runnerArch = requiredEnvironment('VNEXT_T0_RUNNER_ARCH', 32);
  if (runnerOs !== 'Linux' || !['X64', 'ARM64'].includes(runnerArch)) fail('runner identity');
  const nodeVersion = requiredEnvironment('VNEXT_T0_NODE_VERSION', 64);
  const pnpmVersion = requiredEnvironment('VNEXT_T0_PNPM_VERSION', 64);
  if (!/^v24\.[0-9]+\.[0-9]+$/u.test(nodeVersion)) fail('Node must be an exact v24 release');
  if (pnpmVersion !== '11.0.9') fail('pnpm must be 11.0.9');

  if (eventName === 'pull_request') {
    if (disposition !== 'ADVISORY_ONLY') fail('pull_request evidence cannot be FORMAL');
    if (baseSha === null || headSha === null || mergeSha !== testedSha)
      fail('pull request SHA tuple');
    if (!/^refs\/pull\/[1-9][0-9]*\/merge$/u.test(gitRef)) fail('pull request ref');
    if (
      callerWorkflowPath !== '.github/workflows/pr-ci.yml' ||
      directCallerName !== 'PR checks' ||
      topLevelName !== 'PR checks' ||
      topLevelRef !== `dangdang-tech/Combo/.github/workflows/pr-ci.yml@${gitRef}` ||
      jobWorkflowRef !== `dangdang-tech/Combo/.github/workflows/vnext-t0.yml@${gitRef}` ||
      jobWorkflowSha !== testedSha
    ) {
      fail('pull request workflow authority');
    }
  } else if (baseSha !== null || headSha !== null || mergeSha !== null) {
    fail('non-pull-request evidence cannot carry a PR SHA tuple');
  }
  if (disposition === 'FORMAL') {
    if (
      eventName !== 'push' ||
      gitRef !== 'refs/heads/main' ||
      !refProtected ||
      callerWorkflowPath !== '.github/workflows/ci.yml' ||
      directCallerName !== 'Release build' ||
      topLevelName !== 'Release build' ||
      topLevelRef !== 'dangdang-tech/Combo/.github/workflows/ci.yml@refs/heads/main' ||
      topLevelWorkflowSha !== testedSha ||
      jobWorkflowRef !== 'dangdang-tech/Combo/.github/workflows/vnext-t0.yml@refs/heads/main' ||
      jobWorkflowSha !== testedSha
    ) {
      fail('FORMAL evidence requires a protected main push workflow at the tested SHA');
    }
  }

  if (conclusion !== 'PASS') removeFailureJunitArtifacts(directory);
  const junit = junitArtifacts(directory);
  const totals = junit.reduce(
    (counts, artifact) => {
      if (artifact.status !== 'PRESENT') return counts;
      return {
        tests: counts.tests + artifact.counts.tests,
        failures: counts.failures + artifact.counts.failures,
        errors: counts.errors + artifact.counts.errors,
        skipped: counts.skipped + artifact.counts.skipped,
      };
    },
    { tests: 0, failures: 0, errors: 0, skipped: 0 },
  );
  if (
    conclusion === 'PASS' &&
    (!clean ||
      junit.some((artifact) => artifact.status !== 'PRESENT' || artifact.counts.tests < 1) ||
      totals.tests < 1 ||
      totals.failures !== 0 ||
      totals.errors !== 0 ||
      totals.skipped !== 0)
  ) {
    fail('PASS requires all five non-empty JUnit artifacts with zero failures/errors/skips');
  }

  return {
    protocol: 'combo.vnext-t0-g0-evidence/1',
    schemaVersion: 1,
    environment: 'T0-LINUX-CI',
    disposition,
    conclusion,
    source: {
      repository,
      testedSha,
      treeSha,
      clean,
      baseSha,
      headSha,
      mergeSha,
    },
    workflow: {
      directCallerName,
      directCallerPath: callerWorkflowPath,
      t0Path: '.github/workflows/vnext-t0.yml',
      topLevelName,
      topLevelRef,
      topLevelSha: topLevelWorkflowSha,
      jobWorkflowRef,
      jobWorkflowSha,
      jobWorkflowRepository,
      jobWorkflowFilePath,
      eventName,
      gitRef,
      refProtected,
      runId,
      runAttempt: positiveInteger(
        'VNEXT_T0_RUN_ATTEMPT',
        requiredEnvironment('VNEXT_T0_RUN_ATTEMPT', 16),
      ),
      job: requiredEnvironment('VNEXT_T0_JOB', 128),
    },
    runner: {
      os: runnerOs,
      architecture: runnerArch === 'X64' ? 'x64' : 'arm64',
      imageOs: requiredEnvironment('VNEXT_T0_RUNNER_IMAGE_OS', 128),
      imageVersion: requiredEnvironment('VNEXT_T0_RUNNER_IMAGE_VERSION', 128),
      nodeVersion,
      pnpmVersion,
    },
    command: {
      argv: [...VNEXT_G0_SUITE.command],
      executed: commandExecuted,
      exitCode,
      startedAt,
      finishedAt,
      property: { ...VNEXT_G0_SUITE.property },
    },
    cases: [...TEST_CASE_IDS],
    sourceTuple: sourceTuple(),
    results: { totals, junit },
    rawLogsIncluded: false,
    nonClaims: [...NON_CLAIMS],
  };
}

function validateJunitEntry(entry, expected, directory) {
  if (entry.id !== expected.id || entry.path !== expected.junitPath) fail('JUnit identity/order');
  if (entry.status === 'NOT_PRODUCED') {
    exactKeys(entry, ['id', 'path', 'status'], `JUnit ${entry.id}`);
    try {
      lstatSync(resolve(directory, entry.path));
      fail(`JUnit ${entry.id} claims NOT_PRODUCED but exists`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }
  if (entry.status !== 'PRESENT') fail('JUnit status');
  exactKeys(
    entry,
    ['id', 'path', 'status', 'bytes', 'digest', 'counts', 'resultFiles'],
    `JUnit ${entry.id}`,
  );
  exactKeys(entry.counts, ['tests', 'failures', 'errors', 'skipped'], `JUnit ${entry.id} counts`);
  if (!DIGEST_PATTERN.test(entry.digest)) fail('JUnit digest');
  const absolute = resolve(directory, entry.path);
  const stat = regularFile(absolute, `JUnit ${entry.id}`);
  const bytes = readFileSync(absolute);
  if (stat.size !== entry.bytes || sha256(bytes) !== entry.digest) fail(`JUnit ${entry.id} digest`);
  const result = junitCounts(bytes, entry.id);
  if (
    canonicalize(result.counts) !== canonicalize(entry.counts) ||
    canonicalize(result.files) !== canonicalize(entry.resultFiles) ||
    canonicalize(result.files) !== canonicalize([...expected.expectedJUnitFiles].sort())
  ) {
    fail(`JUnit ${entry.id} counts`);
  }
}

function validateEvidence(value, directory, expectedSourceSha) {
  exactKeys(
    value,
    [
      'protocol',
      'schemaVersion',
      'environment',
      'disposition',
      'conclusion',
      'source',
      'workflow',
      'runner',
      'command',
      'cases',
      'sourceTuple',
      'results',
      'rawLogsIncluded',
      'nonClaims',
    ],
    'evidence',
  );
  if (
    value.protocol !== 'combo.vnext-t0-g0-evidence/1' ||
    value.schemaVersion !== 1 ||
    value.environment !== 'T0-LINUX-CI'
  ) {
    fail('protocol identity');
  }
  if (!['FORMAL', 'ADVISORY_ONLY'].includes(value.disposition)) fail('disposition');
  if (!['PASS', 'FAIL', 'BLOCKED'].includes(value.conclusion)) fail('conclusion');
  if (
    value.rawLogsIncluded !== false ||
    JSON.stringify(value.nonClaims) !== JSON.stringify(NON_CLAIMS)
  ) {
    fail('non-claim/privacy boundary');
  }
  exactKeys(
    value.source,
    ['repository', 'testedSha', 'treeSha', 'clean', 'baseSha', 'headSha', 'mergeSha'],
    'source',
  );
  if (
    value.source.repository !== 'dangdang-tech/Combo' ||
    !SHA_PATTERN.test(value.source.testedSha) ||
    !SHA_PATTERN.test(value.source.treeSha) ||
    typeof value.source.clean !== 'boolean'
  ) {
    fail('source identity');
  }
  if (expectedSourceSha !== undefined && value.source.testedSha !== expectedSourceSha) {
    fail('tested source SHA mismatch');
  }
  for (const field of ['baseSha', 'headSha', 'mergeSha']) {
    if (value.source[field] !== null && !SHA_PATTERN.test(value.source[field]))
      fail(`source ${field}`);
  }
  exactKeys(
    value.workflow,
    [
      'directCallerName',
      'directCallerPath',
      't0Path',
      'topLevelName',
      'topLevelRef',
      'topLevelSha',
      'jobWorkflowRef',
      'jobWorkflowSha',
      'jobWorkflowRepository',
      'jobWorkflowFilePath',
      'eventName',
      'gitRef',
      'refProtected',
      'runId',
      'runAttempt',
      'job',
    ],
    'workflow',
  );
  if (
    value.workflow.t0Path !== '.github/workflows/vnext-t0.yml' ||
    !SHA_PATTERN.test(value.workflow.topLevelSha) ||
    !SHA_PATTERN.test(value.workflow.jobWorkflowSha) ||
    value.workflow.jobWorkflowRepository !== value.source.repository ||
    value.workflow.jobWorkflowFilePath !== '.github/workflows/vnext-t0.yml' ||
    !value.workflow.jobWorkflowRef.startsWith(
      `${value.source.repository}/.github/workflows/vnext-t0.yml@`,
    ) ||
    !/^[1-9][0-9]*$/u.test(value.workflow.runId) ||
    typeof value.workflow.refProtected !== 'boolean' ||
    !Number.isSafeInteger(value.workflow.runAttempt) ||
    value.workflow.runAttempt < 1
  ) {
    fail('workflow identity');
  }
  if (value.workflow.eventName === 'pull_request') {
    if (
      value.disposition !== 'ADVISORY_ONLY' ||
      value.source.baseSha === null ||
      value.source.headSha === null ||
      value.source.mergeSha !== value.source.testedSha
    ) {
      fail('pull request evidence boundary');
    }
    if (
      value.workflow.directCallerPath !== '.github/workflows/pr-ci.yml' ||
      value.workflow.directCallerName !== 'PR checks' ||
      value.workflow.topLevelName !== 'PR checks' ||
      value.workflow.topLevelRef !==
        `dangdang-tech/Combo/.github/workflows/pr-ci.yml@${value.workflow.gitRef}` ||
      value.workflow.jobWorkflowRef !==
        `dangdang-tech/Combo/.github/workflows/vnext-t0.yml@${value.workflow.gitRef}` ||
      value.workflow.jobWorkflowSha !== value.source.testedSha
    ) {
      fail('pull request workflow authority');
    }
  }
  if (
    value.disposition === 'FORMAL' &&
    (value.workflow.eventName !== 'push' ||
      value.workflow.gitRef !== 'refs/heads/main' ||
      value.workflow.refProtected !== true ||
      value.workflow.directCallerPath !== '.github/workflows/ci.yml' ||
      value.workflow.directCallerName !== 'Release build' ||
      value.workflow.topLevelName !== 'Release build' ||
      value.workflow.topLevelRef !==
        'dangdang-tech/Combo/.github/workflows/ci.yml@refs/heads/main' ||
      value.workflow.topLevelSha !== value.source.testedSha ||
      value.workflow.jobWorkflowRef !==
        'dangdang-tech/Combo/.github/workflows/vnext-t0.yml@refs/heads/main' ||
      value.workflow.jobWorkflowSha !== value.source.testedSha)
  ) {
    fail('FORMAL evidence boundary');
  }
  exactKeys(
    value.runner,
    ['os', 'architecture', 'imageOs', 'imageVersion', 'nodeVersion', 'pnpmVersion'],
    'runner',
  );
  if (
    value.runner.os !== 'Linux' ||
    !['x64', 'arm64'].includes(value.runner.architecture) ||
    !/^v24\.[0-9]+\.[0-9]+$/u.test(value.runner.nodeVersion) ||
    value.runner.pnpmVersion !== '11.0.9'
  ) {
    fail('runner/toolchain');
  }
  exactKeys(
    value.command,
    ['argv', 'executed', 'exitCode', 'startedAt', 'finishedAt', 'property'],
    'command',
  );
  const commandExitCodeValid =
    value.command.executed === true
      ? Number.isSafeInteger(value.command.exitCode) &&
        value.command.exitCode >= 0 &&
        value.command.exitCode <= 255
      : value.command.executed === false && value.command.exitCode === null;
  const expectedConclusion =
    !value.source.clean || !value.command.executed
      ? 'BLOCKED'
      : value.command.exitCode === 0
        ? 'PASS'
        : 'FAIL';
  if (
    JSON.stringify(value.command.argv) !== JSON.stringify(VNEXT_G0_SUITE.command) ||
    !commandExitCodeValid ||
    expectedConclusion !== value.conclusion ||
    canonicalize(value.command.property) !== canonicalize(VNEXT_G0_SUITE.property)
  ) {
    fail('command result');
  }
  isoDate('command.startedAt', value.command.startedAt);
  isoDate('command.finishedAt', value.command.finishedAt);
  if (Date.parse(value.command.finishedAt) < Date.parse(value.command.startedAt))
    fail('command time order');
  if (JSON.stringify(value.cases) !== JSON.stringify(TEST_CASE_IDS)) fail('SCH case set/order');
  exactKeys(value.sourceTuple, ['files', 'digest'], 'source tuple');
  const currentTuple = sourceTuple();
  if (canonicalize(value.sourceTuple) !== canonicalize(currentTuple)) fail('source tuple drift');
  exactKeys(value.results, ['totals', 'junit'], 'results');
  exactKeys(value.results.totals, ['tests', 'failures', 'errors', 'skipped'], 'result totals');
  if (
    !Array.isArray(value.results.junit) ||
    value.results.junit.length !== VNEXT_G0_SUITE.groups.length
  ) {
    fail('JUnit artifact count');
  }
  value.results.junit.forEach((entry, index) =>
    validateJunitEntry(entry, VNEXT_G0_SUITE.groups[index], directory),
  );
  const totals = value.results.junit.reduce(
    (counts, entry) => {
      if (entry.status !== 'PRESENT') return counts;
      return {
        tests: counts.tests + entry.counts.tests,
        failures: counts.failures + entry.counts.failures,
        errors: counts.errors + entry.counts.errors,
        skipped: counts.skipped + entry.counts.skipped,
      };
    },
    { tests: 0, failures: 0, errors: 0, skipped: 0 },
  );
  if (canonicalize(totals) !== canonicalize(value.results.totals)) fail('result totals drift');
  if (
    value.conclusion === 'PASS' &&
    (!value.source.clean ||
      value.results.junit.some(
        (artifact) => artifact.status !== 'PRESENT' || artifact.counts.tests < 1,
      ) ||
      totals.tests < 1 ||
      totals.failures !== 0 ||
      totals.errors !== 0 ||
      totals.skipped !== 0)
  ) {
    fail('invalid PASS evidence');
  }
  return value;
}

function artifactPaths(directory) {
  const paths = [];
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const absolute = resolve(current, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('evidence directory contains a symlink');
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) paths.push(relative(directory, absolute).split(sep).join('/'));
      else fail('evidence directory contains a non-regular entry');
    }
  };
  visit(directory);
  return paths.sort();
}

function readEvidence(directory, expectedSourceSha) {
  evidenceDirectory(directory);
  const evidencePath = resolve(directory, EVIDENCE_FILE);
  regularFile(evidencePath, EVIDENCE_FILE);
  const bytes = readFileSync(evidencePath);
  if (bytes.length < 1 || bytes.length > MAX_EVIDENCE_JSON_BYTES) fail('evidence JSON size');
  const parsed = JSON.parse(decodeUtf8(bytes, 'evidence JSON'));
  validateEvidence(parsed, directory, expectedSourceSha);
  if (!bytes.equals(Buffer.from(canonicalize(parsed), 'utf8')))
    fail('evidence JSON is not canonical');
  const allowed = new Set([
    EVIDENCE_FILE,
    ...parsed.results.junit.filter(({ status }) => status === 'PRESENT').map(({ path }) => path),
  ]);
  const actual = artifactPaths(directory);
  if (actual.some((path) => !allowed.has(path)) || actual.length !== allowed.size) {
    fail('unexpected evidence files');
  }
  return { evidence: parsed, bytes };
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) fail(`missing ${name}`);
  return args[index + 1];
}

function create(directory) {
  evidenceDirectory(directory);
  const evidence = evidenceFromEnvironment(directory);
  const bytes = Buffer.from(canonicalize(evidence), 'utf8');
  if (bytes.length > MAX_EVIDENCE_JSON_BYTES) fail('evidence JSON size');
  writeFileSync(resolve(directory, EVIDENCE_FILE), bytes, { flag: 'wx', mode: 0o600 });
  validateEvidence(evidence, directory, evidence.source.testedSha);
  return { evidence, bytes };
}

function summary(evidence) {
  const totals = evidence.results.totals;
  return [
    '## VNext T0-LINUX-CI / G0 Contract Freeze',
    '',
    `- disposition: \`${evidence.disposition}\``,
    `- tested SHA: \`${evidence.source.testedSha}\``,
    `- command: \`pnpm vnext:test:g0\``,
    `- result: \`${evidence.conclusion}\` (${evidence.command.executed ? `exit ${evidence.command.exitCode}` : 'command NOT_RUN'})`,
    `- JUnit: ${totals.tests} tests, ${totals.failures} failures, ${totals.errors} errors, ${totals.skipped} skipped`,
    `- runner: \`${evidence.runner.imageOs} ${evidence.runner.imageVersion} / ${evidence.runner.architecture} / ${evidence.runner.nodeVersion} / pnpm ${evidence.runner.pnpmVersion}\``,
    `- source tuple: \`${evidence.sourceTuple.digest}\``,
    `- run: \`https://github.com/${evidence.source.repository}/actions/runs/${evidence.workflow.runId}\``,
    '',
  ].join('\n');
}

const [subcommand, ...args] = process.argv.slice(2);
const directory = resolve(flagValue(args, '--directory'));
if (subcommand === 'create') {
  const result = create(directory);
  process.stdout.write(`${sha256(result.bytes)}\n`);
} else if (subcommand === 'verify') {
  const expectedSourceSha = flagValue(args, '--source-sha');
  if (!SHA_PATTERN.test(expectedSourceSha)) fail('--source-sha');
  const result = readEvidence(directory, expectedSourceSha);
  process.stdout.write(`${sha256(result.bytes)}\n`);
} else if (subcommand === 'summary') {
  const result = readEvidence(directory, undefined);
  process.stdout.write(summary(result.evidence));
} else {
  fail('usage: create|verify|summary --directory <path> [--source-sha <sha>]');
}
