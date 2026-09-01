import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shaPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const playwrightEvidenceProtocol = 'combo.playwright-controlled-local-auth/1';
const supportedPlaywrightVersion = '1.62.0';
const expectedPlaywrightCommandTail = Object.freeze([
  'test',
  '--config',
  'tests/e2e/playwright.test-truth.config.ts',
  '--tsconfig',
  'tsconfig.e2e.json',
  '--browser=chromium',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} keys changed`,
  );
}

function nonEmptyString(value, label) {
  invariant(
    typeof value === 'string' && value.trim() === value && value.length > 0,
    `${label} invalid`,
  );
}

function safeRepoFile(value, label) {
  nonEmptyString(value, label);
  invariant(
    !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.includes('//') &&
      !value.endsWith('/'),
    `${label} is not a safe repository file`,
  );
  invariant(
    !value.split('/').some((segment) => segment === '.' || segment === '..'),
    `${label} is not a safe repository file`,
  );
}

function selectorPath(step, argument) {
  return step.cwd === '.' ? argument : `${step.cwd}/${argument}`;
}

function relativeTestFile(name, step) {
  const absolute = isAbsolute(name) ? resolve(name) : resolve(repoRoot, step.cwd, name);
  const file = relative(repoRoot, absolute).replaceAll('\\', '/');
  safeRepoFile(file, 'Playwright result file');
  return file;
}

function validateCandidate(candidate) {
  invariant(
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate),
    'candidate must be an object',
  );
  exactKeys(candidate, ['mergeSha', 'baseSha', 'headSha'], 'candidate');
  for (const key of ['mergeSha', 'baseSha', 'headSha']) {
    invariant(shaPattern.test(candidate[key]), `candidate.${key} must be a full lowercase SHA`);
  }
}

function playwrightRuntimeReasons(config, step, candidate) {
  invariant(
    config !== null && typeof config === 'object' && !Array.isArray(config),
    'Playwright config invalid',
  );
  invariant(Array.isArray(config.argv), 'Playwright config argv missing');
  invariant(
    config.argv.every((argument) => typeof argument === 'string'),
    'Playwright argv invalid',
  );
  invariant(Array.isArray(config.projects), 'Playwright projects missing');
  invariant(config.projects.length === 1, 'Playwright project inventory invalid');

  const project = config.projects[0];
  invariant(
    project !== null && typeof project === 'object' && !Array.isArray(project),
    'Playwright project invalid',
  );
  invariant(Array.isArray(project.testIgnore), 'Playwright testIgnore missing');
  invariant(Array.isArray(project.testMatch), 'Playwright testMatch missing');

  const reasons = [];
  if (
    config.argv.length !== expectedPlaywrightCommandTail.length + 2 ||
    JSON.stringify(config.argv.slice(2)) !== JSON.stringify(expectedPlaywrightCommandTail)
  ) {
    reasons.push('PLAYWRIGHT_COMMAND_POLICY_MISMATCH');
  }
  const expectedDirectory = resolve(repoRoot, step.cwd);
  const actualRootDirectory = resolve(config.rootDir ?? '');
  const actualTestDirectory = resolve(project.testDir ?? '');
  const runtimeMatches =
    config.version === supportedPlaywrightVersion &&
    config.failOnFlakyTests === true &&
    config.forbidOnly === true &&
    config.fullyParallel === false &&
    config.workers === 1 &&
    config.maxFailures === 0 &&
    config.shard === null &&
    config.updateSnapshots === 'none' &&
    config.grep !== null &&
    typeof config.grep === 'object' &&
    !Array.isArray(config.grep) &&
    Object.keys(config.grep).length === 0 &&
    config.grepInvert === null &&
    JSON.stringify(config.reporter) === JSON.stringify([['json']]) &&
    actualRootDirectory === expectedDirectory &&
    actualTestDirectory === expectedDirectory &&
    project.id === 'chromium' &&
    project.name === 'chromium' &&
    project.repeatEach === 1 &&
    project.retries === 0 &&
    project.testIgnore.length === 0 &&
    JSON.stringify(project.testMatch) === JSON.stringify(step.argv);
  if (!runtimeMatches) reasons.push('PLAYWRIGHT_RUNTIME_POLICY_MISMATCH');

  const forbiddenFilterArguments = new Set([
    '--grep',
    '-g',
    '-G',
    '--grep-invert',
    '--last-failed',
    '--list',
    '--only-changed',
    '--project',
    '--shard',
    '--test-list',
    '--test-list-invert',
  ]);
  if (
    config.argv.some(
      (argument) =>
        forbiddenFilterArguments.has(argument) ||
        [...forbiddenFilterArguments].some((flag) => argument.startsWith(`${flag}=`)),
    )
  ) {
    reasons.push('PLAYWRIGHT_FILTERED_EXECUTION');
  }

  const forbiddenBrowserArguments = new Set(['--debug', '--headed', '--ui']);
  const browserArguments = config.argv.filter(
    (argument) => argument === '--browser' || argument.startsWith('--browser='),
  );
  if (
    JSON.stringify(browserArguments) !== JSON.stringify(['--browser=chromium']) ||
    config.argv.some(
      (argument) =>
        forbiddenBrowserArguments.has(argument) ||
        [...forbiddenBrowserArguments].some((flag) => argument.startsWith(`${flag}=`)),
    )
  ) {
    reasons.push('PLAYWRIGHT_BROWSER_COMMAND_OVERRIDE');
  }

  invariant(
    config.metadata !== null &&
      typeof config.metadata === 'object' &&
      !Array.isArray(config.metadata),
    'Playwright metadata invalid',
  );
  const evidence = config.metadata.comboEvidence;
  exactKeys(
    evidence,
    [
      'protocol',
      'candidateCommit',
      'environment',
      'browserCliDefault',
      'emailDelivery',
      'transport',
      'cookieSecure',
    ],
    'Playwright evidence metadata',
  );
  if (
    evidence.protocol !== playwrightEvidenceProtocol ||
    evidence.candidateCommit !== candidate.mergeSha ||
    evidence.environment !== 'LOCAL_DOCKER_COMPOSE' ||
    evidence.browserCliDefault !== 'chromium' ||
    evidence.emailDelivery !== 'RESEND_MOCK' ||
    evidence.transport !== 'HTTP' ||
    evidence.cookieSecure !== false
  ) {
    reasons.push('PLAYWRIGHT_EVIDENCE_METADATA_MISMATCH');
  }
  if (config.metadata.actualWorkers !== 1) {
    reasons.push('PLAYWRIGHT_RUNTIME_POLICY_MISMATCH');
  }
  return reasons;
}

function collectPlaywrightSpecs(suites, output = []) {
  invariant(Array.isArray(suites), 'Playwright suites missing');
  for (const suite of suites) {
    invariant(
      suite !== null && typeof suite === 'object' && !Array.isArray(suite),
      'Playwright suite invalid',
    );
    invariant(Array.isArray(suite.specs), 'Playwright suite specs missing');
    for (const spec of suite.specs) output.push(spec);
    if (suite.suites !== undefined) collectPlaywrightSpecs(suite.suites, output);
  }
  return output;
}

export function normalizePlaywrightReport(
  raw,
  { step, candidate, exitCode, rawDigest, minimumTestCount },
) {
  invariant(
    raw !== null && typeof raw === 'object' && !Array.isArray(raw),
    'Playwright report invalid',
  );
  validateCandidate(candidate);
  invariant(sha256Pattern.test(rawDigest), 'Playwright raw report digest invalid');
  invariant(
    Number.isSafeInteger(minimumTestCount) && minimumTestCount > 0,
    'Playwright minimum test count invalid',
  );
  invariant(Array.isArray(raw.errors), 'Playwright global errors missing');
  invariant(
    raw.stats !== null && typeof raw.stats === 'object' && !Array.isArray(raw.stats),
    'Playwright stats missing',
  );
  for (const field of ['expected', 'skipped', 'unexpected', 'flaky']) {
    invariant(
      Number.isSafeInteger(raw.stats[field]) && raw.stats[field] >= 0,
      `Playwright ${field} count invalid`,
    );
  }

  const reasonCodes = playwrightRuntimeReasons(raw.config, step, candidate);
  if (exitCode !== 0) reasonCodes.push('COMMAND_EXIT_NONZERO');
  if (raw.errors.length > 0) reasonCodes.push('PLAYWRIGHT_GLOBAL_ERROR');

  const specs = collectPlaywrightSpecs(raw.suites);
  const caseOrdinals = new Map();
  const collectedFiles = [];
  const testCases = [];
  const outcomeCounts = { expected: 0, skipped: 0, unexpected: 0, flaky: 0 };

  for (const spec of specs) {
    invariant(
      spec !== null && typeof spec === 'object' && !Array.isArray(spec),
      'Playwright spec invalid',
    );
    nonEmptyString(spec.title, 'Playwright test title');
    invariant(Array.isArray(spec.tests), 'Playwright spec tests missing');
    invariant(spec.tests.length === 1, 'Playwright spec execution inventory invalid');
    const file = relativeTestFile(spec.file, step);
    if (!collectedFiles.includes(file)) collectedFiles.push(file);
    const ordinal = (caseOrdinals.get(file) ?? 0) + 1;
    caseOrdinals.set(file, ordinal);
    const id = `playwright:${file}:case-${ordinal}`;

    const execution = spec.tests[0];
    invariant(
      execution !== null && typeof execution === 'object' && !Array.isArray(execution),
      'Playwright test execution invalid',
    );
    invariant(
      ['expected', 'skipped', 'unexpected', 'flaky'].includes(execution.status),
      'Playwright test outcome invalid',
    );
    outcomeCounts[execution.status] += 1;
    invariant(Array.isArray(execution.annotations), 'Playwright annotations missing');
    invariant(Array.isArray(execution.results), 'Playwright results missing');

    if (execution.projectId !== 'chromium' || execution.projectName !== 'chromium') {
      reasonCodes.push('PLAYWRIGHT_BROWSER_PROJECT_MISMATCH');
    }

    if (execution.expectedStatus !== 'passed') {
      reasonCodes.push('PLAYWRIGHT_EXPECTED_STATUS_OVERRIDE');
    }
    if (execution.annotations.length > 0) reasonCodes.push('PLAYWRIGHT_UNEXPECTED_ANNOTATION');
    if (execution.status === 'flaky' || execution.results.length > 1) {
      reasonCodes.push('PLAYWRIGHT_UNEXPECTED_RETRY');
    }

    let status = 'FAIL';
    let durationMs = 0;
    if (execution.results.length === 0) {
      status = execution.status === 'skipped' ? 'SKIPPED' : 'FAIL';
    } else {
      const resultStatuses = [];
      for (const result of execution.results) {
        invariant(
          result !== null && typeof result === 'object' && !Array.isArray(result),
          'Playwright test result invalid',
        );
        invariant(
          ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(result.status),
          'Playwright result status invalid',
        );
        invariant(
          Number.isSafeInteger(result.retry) && result.retry >= 0,
          'Playwright retry invalid',
        );
        invariant(Array.isArray(result.attachments), 'Playwright attachments missing');
        invariant(Array.isArray(result.stdout), 'Playwright stdout missing');
        invariant(Array.isArray(result.stderr), 'Playwright stderr missing');
        if (result.retry !== 0) reasonCodes.push('PLAYWRIGHT_UNEXPECTED_RETRY');
        if (result.attachments.length > 0 || result.stdout.length > 0 || result.stderr.length > 0) {
          reasonCodes.push('PLAYWRIGHT_UNSAFE_RAW_OUTPUT');
        }
        resultStatuses.push(result.status);
        if (typeof result.duration === 'number' && result.duration >= 0)
          durationMs += result.duration;
      }
      status = resultStatuses.includes('interrupted')
        ? 'CANCELLED'
        : resultStatuses.includes('failed') || resultStatuses.includes('timedOut')
          ? 'FAIL'
          : resultStatuses.includes('skipped')
            ? 'SKIPPED'
            : execution.results.length === 1 &&
                resultStatuses[0] === 'passed' &&
                execution.status === 'expected' &&
                execution.expectedStatus === 'passed' &&
                execution.annotations.length === 0
              ? 'PASS'
              : 'FAIL';
    }
    testCases.push({
      id,
      file,
      name: `Playwright case ${ordinal}`,
      status,
      durationMs: execution.results.length === 0 ? null : durationMs,
    });
  }

  const counts = {
    tests: testCases.length,
    passed: testCases.filter((item) => item.status === 'PASS').length,
    failed: testCases.filter((item) => item.status === 'FAIL').length,
    cancelled: testCases.filter((item) => item.status === 'CANCELLED').length,
    skipped: testCases.filter((item) => item.status === 'SKIPPED').length,
    todo: 0,
    commands: 0,
  };
  invariant(
    raw.stats.expected + raw.stats.skipped + raw.stats.unexpected + raw.stats.flaky ===
      counts.tests,
    'Playwright stats total disagrees with test inventory',
  );
  for (const field of Object.keys(outcomeCounts)) {
    invariant(raw.stats[field] === outcomeCounts[field], 'Playwright outcome stats disagree');
  }
  if (counts.tests === 0) reasonCodes.push('ZERO_TESTS_EXECUTED');
  if (counts.tests < minimumTestCount) {
    reasonCodes.push('PLAYWRIGHT_MINIMUM_TEST_COUNT_NOT_MET');
  }
  if (counts.failed > 0) reasonCodes.push('TEST_FAILURE');
  if (counts.cancelled > 0) reasonCodes.push('TEST_CANCELLED');
  if (counts.skipped > 0) reasonCodes.push('UNEXPECTED_SKIP');
  collectedFiles.sort();
  const expectedFiles = step.argv.map((argument) => selectorPath(step, argument)).sort();
  if (JSON.stringify(collectedFiles) !== JSON.stringify(expectedFiles)) {
    reasonCodes.push('COLLECTED_FILE_MISMATCH');
  }
  const normalizedReasonCodes = [...new Set(reasonCodes)].sort();
  return {
    status: normalizedReasonCodes.length === 0 ? 'PASS' : 'FAIL',
    reasonCodes: normalizedReasonCodes,
    counts,
    testCases,
    collectedFiles,
    rawReportSha256: rawDigest,
  };
}
