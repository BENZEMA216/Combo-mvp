import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  acceptancePath,
  buildAggregate,
  classifyInventoryBoundary,
  manifestPath,
  normalizeNodeTestReport,
  normalizeVitestReport,
  parseManifest,
  renderSummary,
  requiredStepMinimumTestCounts,
  repoRoot,
  validateRepositoryManifest,
} from './test-truth.mjs';

const manifestSource = readFileSync(join(repoRoot, manifestPath), 'utf8');
const manifest = parseManifest(manifestSource);
const manifestSha256 = createHash('sha256').update(manifestSource).digest('hex');
const machineReportProtocol = 'combo.framework-test-report/1';
const candidate = {
  mergeSha: '1'.repeat(40),
  baseSha: '2'.repeat(40),
  headSha: '3'.repeat(40),
};
const acceptance = JSON.parse(readFileSync(join(repoRoot, acceptancePath), 'utf8'));
const coverage = validateRepositoryManifest(manifest);

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function commandForStep(step) {
  if (step.kind === 'VITEST') {
    return ['pnpm', '--dir', step.cwd, 'exec', 'vitest', 'run', ...step.argv];
  }
  if (step.kind === 'NODE_TEST') return ['node', '--test', ...step.argv];
  return step.argv;
}

function commandDigest(step) {
  return createHash('sha256')
    .update(JSON.stringify({ cwd: step.cwd, argv: commandForStep(step) }))
    .digest('hex');
}

function machineReportValue(result, stepResult) {
  return {
    protocol: machineReportProtocol,
    schemaVersion: 1,
    suiteId: result.suiteId,
    stepIndex: stepResult.index,
    framework: stepResult.kind,
    candidate: result.candidate,
    commandDigest: stepResult.commandDigest,
    status: stepResult.status,
    reasonCodes: stepResult.reasonCodes,
    counts: stepResult.counts,
    testCases: stepResult.testCases,
    collectedFiles: stepResult.collectedFiles,
  };
}

function passResult(suite) {
  const counts = {
    tests: 0,
    passed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    commands: 0,
  };
  const steps = suite.runner.steps.map((step, index) => {
    const files = (
      step.kind === 'VITEST' || step.kind === 'NODE_TEST'
        ? step.argv.map((argument) => (step.cwd === '.' ? argument : `${step.cwd}/${argument}`))
        : []
    ).sort();
    const minimumTestCount = requiredStepMinimumTestCounts[suite.id]?.[index] ?? files.length;
    const testCases = Array.from({ length: minimumTestCount }, (_, testIndex) => {
      const file = files[testIndex % files.length];
      return {
        id: `${step.kind === 'NODE_TEST' ? 'node' : 'vitest'}:${file}:fixture ${testIndex}`,
        file,
        name: `fixture ${testIndex}`,
        status: 'PASS',
        durationMs: 1,
      };
    });
    const stepCounts = {
      tests: testCases.length,
      passed: testCases.length,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
      commands: step.kind === 'COMMAND' ? 1 : 0,
    };
    for (const key of Object.keys(counts)) counts[key] += stepCounts[key];
    const machineReported = step.kind === 'VITEST' || step.kind === 'NODE_TEST';
    return {
      index,
      kind: step.kind,
      commandDigest: commandDigest(step),
      status: 'PASS',
      reasonCodes: [],
      missingRequiredEnvNames: [],
      startedAt: '2026-09-01T00:00:00.000Z',
      finishedAt: '2026-09-01T00:00:01.000Z',
      exitCode: 0,
      signal: null,
      counts: stepCounts,
      testCases,
      collectedFiles: files,
      machineReportRef: machineReported ? `${suite.id}-${index}.machine.json` : null,
      machineReportSha256: null,
    };
  });
  const result = {
    protocol: 'combo.test-suite-result/1',
    schemaVersion: 1,
    suiteId: suite.id,
    layer: suite.layer,
    target: 'PR',
    source: suite.resultSource,
    candidate,
    manifestSha256,
    status: 'PASS',
    reasonCodes: [],
    startedAt: '2026-09-01T00:00:00.000Z',
    finishedAt: '2026-09-01T00:00:01.000Z',
    counts,
    steps,
    provenClaimIds: suite.proves.map((claim) => claim.id),
  };
  for (const stepResult of result.steps) {
    if (stepResult.machineReportRef === null) continue;
    stepResult.machineReportSha256 = createHash('sha256')
      .update(canonical(machineReportValue(result, stepResult)))
      .digest('hex');
  }
  return result;
}

function requiredResults() {
  return manifest.suites
    .filter((suite) => suite.defaults.pr === 'RUN_REQUIRED')
    .map((suite) => passResult(suite));
}

function machineReportsFor(results) {
  const machineReports = new Map();
  for (const result of results) {
    for (const stepResult of result.steps ?? []) {
      if (stepResult.machineReportRef === null) continue;
      const value = machineReportValue(result, stepResult);
      const source = canonical(value);
      machineReports.set(stepResult.machineReportRef, {
        sha256: createHash('sha256').update(source).digest('hex'),
        value,
      });
    }
  }
  return machineReports;
}

function aggregate(overrides = {}) {
  const {
    results = requiredResults(),
    machineReports = machineReportsFor(results),
    ...rest
  } = overrides;
  return buildAggregate({
    manifest,
    manifestSha256,
    results,
    machineReports,
    jobResults: {
      sourceQuality: 'success',
      billingPostgresql: 'success',
      postgresqlRedisIntegration: 'success',
    },
    candidate,
    acceptance,
    coverage,
    ...rest,
  });
}

function acceptanceWithEvidence(commit, { allGates = true } = {}) {
  const value = structuredClone(acceptance);
  value.productStatus = allGates ? 'PASS' : 'BLOCKED';
  value.candidateCommit = commit;
  value.gates = value.gates.map((gate, index) => {
    if (!allGates && index > 0) return gate;
    const kind = [
      'CONTRACT_TEST_REPORT',
      'CONVERSATION_EXTRACTION_TEST_REPORT',
      'SECURITY_BOUNDARY_TEST_REPORT',
      'DESKTOP_CURRENT_TASK_RUN_RECEIPT',
      'NON_DEVELOPER_UAT_RECEIPT',
    ][index];
    return {
      ...gate,
      status: 'PASS',
      evidence: [
        {
          kind,
          artifactRef: `artifact-${index + 1}`,
          artifactSha256: `sha256:${String(index + 1).repeat(64)}`,
          environment: {
            repositoryCommit: commit,
            runtimeIdentity: 'test fixture',
            componentVersions: [{ component: 'combo', version: 'test' }],
          },
        },
      ],
    };
  });
  return value;
}

test('the committed manifest is normalized and exposes its unclassified boundary', () => {
  assert.equal(manifestSource, `${manifestSource.trimEnd()}\n`);
  assert.equal(manifest.suites.length, 9);
  const inventory = validateRepositoryManifest(manifest);
  assert.equal(inventory.totalTestFiles >= inventory.classifiedTestFiles, true);
  assert.equal(inventory.baselineUnclassifiedCount > 0, true);
  assert.equal(inventory.newUnclassifiedCount, 0);
  assert.equal(inventory.unclassifiedPolicy, 'NO_EVIDENCE_CLAIMS');
});

test('unknown fields and duplicate selectors fail closed', () => {
  const unknown = structuredClone(manifest);
  unknown.status = 'GREEN';
  assert.throws(() => parseManifest(canonical(unknown)), /keys or key order changed/);

  const duplicate = structuredClone(manifest);
  duplicate.suites[1].selectors.files = [duplicate.suites[0].selectors.files[0]];
  duplicate.suites[1].runner.steps[0].argv = [
    duplicate.suites[0].selectors.files[0].replace('apps/creator-worker/', ''),
  ];
  assert.throws(() => parseManifest(canonical(duplicate)), /belongs to multiple suites/);
});

test('suite selectors and semantic claims cannot drift beyond their machine policy', () => {
  const postgres = manifest.suites.find((suite) => suite.id === 'TS-INFRA-REAL-PR-001');
  assert.deepEqual(
    postgres.runner.steps.filter((step) => step.cwd === 'db').map((step) => step.argv),
    [
      ['__tests__/agent-package-registry.pg.test.ts'],
      [
        '__tests__/agent-session-receipts.pg.test.ts',
        '__tests__/agent-session-response-message.pg.test.ts',
        '__tests__/agent-session-receipts-roles.pg.test.ts',
      ],
      ['__tests__/agent-session-receipts-upgrade.pg.test.ts'],
      [
        '__tests__/pending-usage-recovery.pg.test.ts',
        '__tests__/pending-usage-recovery-roles.pg.test.ts',
      ],
      ['__tests__/pending-usage-recovery-upgrade.pg.test.ts'],
    ],
    'database evidence must retain the proven non-interfering groups from db-migrate.sh',
  );

  const remainingInfrastructure = manifest.suites.find(
    (suite) => suite.id === 'TS-INFRA-REAL-PR-002',
  );
  assert.equal(remainingInfrastructure.resultSource, 'PR_INTEGRATION');
  assert.equal(remainingInfrastructure.defaults.pr, 'RUN_REQUIRED');
  assert.deepEqual(
    remainingInfrastructure.runner.steps
      .filter((step) => step.kind === 'VITEST')
      .map((step) => step.argv),
    [
      ['__tests__/application-database-roles.pg.test.ts'],
      ['src/__tests__/account-auth.pg.test.ts'],
      ['src/__tests__/terminal-fence.integration.test.ts'],
      ['src/__tests__/session-consistency.integration.test.ts'],
    ],
    'remaining infrastructure evidence must retain all four exact machine selectors',
  );

  const uncovered = structuredClone(manifest);
  uncovered.suites[4].runner.steps = [uncovered.suites[4].runner.steps[0]];
  assert.throws(
    () => parseManifest(canonical(uncovered)),
    /has no machine-reported test step|runner does not exactly cover its selectors/,
  );

  const exaggerated = structuredClone(manifest);
  const unit = exaggerated.suites.find((suite) => suite.id === 'TS-UNIT-011');
  unit.acceptance.relationship = 'GATE';
  unit.acceptance.acceptanceIds = ['ACC-HOST-011D', 'ACC-UAT-011E'];
  unit.proves[0].statement = 'Desktop UAT passed.';
  assert.throws(
    () => parseManifest(canonical(exaggerated)),
    /acceptance relationship changed|proof claim changed/,
  );

  const substituted = structuredClone(manifest);
  const substitutedPostgres = substituted.suites.find(
    (suite) => suite.id === 'TS-INFRA-REAL-PR-001',
  );
  substitutedPostgres.selectors.files = ['apps/web/src/pages/LoginPage.test.tsx'];
  substitutedPostgres.runner.steps = [
    {
      kind: 'VITEST',
      cwd: 'apps/web',
      argv: ['src/pages/LoginPage.test.tsx'],
      requiredEnvNames: [],
      timeoutSeconds: 300,
    },
  ];
  assert.throws(
    () => parseManifest(canonical(substituted)),
    /TS-INFRA-REAL-PR-001 execution policy changed/,
  );

  const weakenedBoundary = structuredClone(manifest);
  const weakenedUnit = weakenedBoundary.suites.find((suite) => suite.id === 'TS-UNIT-011');
  weakenedUnit.defaults.main = 'NOT_SCHEDULED';
  weakenedUnit.doesNotProve = ['Nothing material.'];
  assert.throws(
    () => parseManifest(canonical(weakenedBoundary)),
    /TS-UNIT-011 execution policy changed/,
  );
});

test('test inventory keeps new unclassified files visible and claimless', () => {
  const advancedBaseline = structuredClone(manifest);
  advancedBaseline.coverage.baselineCommit = 'f'.repeat(40);
  advancedBaseline.coverage.baselineTestInventoryCount = 202;
  assert.throws(
    () => parseManifest(canonical(advancedBaseline)),
    /coverage baseline policy changed/,
  );

  assert.deepEqual(
    classifyInventoryBoundary({
      baselineInventory: ['legacy.test.ts'],
      currentInventory: ['legacy.test.ts', 'new.test.ts'],
      classifiedFiles: new Set(['new.test.ts']),
    }),
    {
      baselineUnclassifiedFiles: ['legacy.test.ts'],
      newUnclassifiedFiles: [],
    },
  );
  assert.deepEqual(
    classifyInventoryBoundary({
      baselineInventory: ['legacy.test.ts'],
      currentInventory: ['legacy.test.ts', 'new.test.ts'],
      classifiedFiles: new Set(),
    }),
    {
      baselineUnclassifiedFiles: ['legacy.test.ts'],
      newUnclassifiedFiles: ['new.test.ts'],
    },
  );
});

test('Desktop UAT cannot gain a runner or proof claim through the CI manifest', () => {
  const injected = structuredClone(manifest);
  const desktop = injected.suites.find((suite) => suite.id === 'TS-DESKTOP-UAT-011');
  desktop.implementation = 'AVAILABLE';
  desktop.resultSource = 'PR_SOURCE';
  desktop.defaults.pr = 'RUN_REQUIRED';
  desktop.selectors.files = ['apps/web/src/pages/LoginPage.test.tsx'];
  desktop.proves = [
    { id: 'CLAIM-FORGED-DESKTOP-PASS', statement: 'A GitHub runner says Desktop passed.' },
  ];
  desktop.runner = {
    kind: 'STEPS',
    steps: [
      {
        kind: 'COMMAND',
        cwd: '.',
        argv: ['true'],
        requiredEnvNames: [],
        timeoutSeconds: 1,
      },
    ],
  };
  assert.throws(
    () => parseManifest(canonical(injected)),
    /proof claim changed|Desktop UAT must remain NOT_IMPLEMENTED/,
  );
});

test('Vitest success is derived from assertion states, not its top-level success flag', () => {
  const step = {
    cwd: 'apps/creator-worker',
    argv: ['src/__tests__/example.test.ts'],
  };
  const raw = {
    success: true,
    numTotalTests: 2,
    testResults: [
      {
        name: join(repoRoot, 'apps/creator-worker/src/__tests__/example.test.ts'),
        assertionResults: [
          { fullName: 'runs one case', status: 'passed', duration: 2 },
          { fullName: 'silently skips reality', status: 'pending', duration: null },
        ],
      },
    ],
  };
  const normalized = normalizeVitestReport(raw, {
    step,
    exitCode: 0,
    rawDigest: 'a'.repeat(64),
  });
  assert.equal(normalized.status, 'FAIL');
  assert.deepEqual(normalized.reasonCodes, ['UNEXPECTED_SKIP']);
  assert.equal(normalized.counts.skipped, 1);
});

test('a Vitest report must collect every exact selected file', () => {
  const normalized = normalizeVitestReport(
    { success: true, numTotalTests: 0, testResults: [] },
    {
      step: { cwd: 'apps/creator-worker', argv: ['src/__tests__/missing.test.ts'] },
      exitCode: 0,
      rawDigest: 'a'.repeat(64),
    },
  );
  assert.equal(normalized.status, 'FAIL');
  assert.deepEqual(normalized.reasonCodes, ['COLLECTED_FILE_MISMATCH', 'ZERO_TESTS_EXECUTED']);

  const partial = normalizeVitestReport(
    {
      success: true,
      numTotalTests: 1,
      testResults: [
        {
          name: join(repoRoot, 'apps/creator-worker/src/__tests__/first.test.ts'),
          assertionResults: [{ fullName: 'one real case', status: 'passed', duration: 1 }],
        },
        {
          name: join(repoRoot, 'apps/creator-worker/src/__tests__/empty.test.ts'),
          assertionResults: [],
        },
      ],
    },
    {
      step: {
        cwd: 'apps/creator-worker',
        argv: ['src/__tests__/empty.test.ts', 'src/__tests__/first.test.ts'],
      },
      exitCode: 0,
      rawDigest: 'a'.repeat(64),
    },
  );
  assert.equal(partial.status, 'FAIL');
  assert.deepEqual(partial.reasonCodes, ['ZERO_TESTS_IN_SELECTED_FILE']);
});

test('Node test PASS is derived from its global event summary and rejects skip', () => {
  const step = {
    cwd: '.',
    argv: ['scripts/first.test.mjs', 'scripts/second.test.mjs'],
  };
  const completion = (file, name, number, skip = null) => ({
    type: 'test:pass',
    data: {
      name,
      nesting: 0,
      testNumber: number,
      skip,
      todo: null,
      file: join(repoRoot, file),
      details: { duration_ms: 1, type: 'test' },
    },
  });
  const fileSummary = (file, { passed, skipped, suites = 0 }) => ({
    type: 'test:summary',
    data: {
      success: true,
      counts: {
        tests: passed + skipped,
        failed: 0,
        passed,
        cancelled: 0,
        skipped,
        todo: 0,
        topLevel: passed + skipped,
        suites,
      },
      duration_ms: 1,
      file: join(repoRoot, file),
    },
  });
  const events = [
    completion('scripts/first.test.mjs', 'runs', 1),
    completion('scripts/second.test.mjs', 'silently skipped', 1, true),
    {
      type: 'test:pass',
      data: {
        name: 'outer describe suite',
        nesting: 0,
        testNumber: 2,
        skip: null,
        todo: null,
        file: join(repoRoot, 'scripts/first.test.mjs'),
        details: { duration_ms: 1, type: 'suite' },
      },
    },
    fileSummary('scripts/first.test.mjs', { passed: 1, skipped: 0, suites: 1 }),
    fileSummary('scripts/second.test.mjs', { passed: 0, skipped: 1 }),
    {
      type: 'test:summary',
      data: {
        success: true,
        counts: {
          tests: 2,
          failed: 0,
          passed: 1,
          cancelled: 0,
          skipped: 1,
          todo: 0,
          topLevel: 2,
          suites: 1,
        },
        duration_ms: 2,
      },
    },
  ];
  const normalized = normalizeNodeTestReport(events, {
    step,
    exitCode: 0,
    rawDigest: 'b'.repeat(64),
  });
  assert.equal(normalized.status, 'FAIL');
  assert.deepEqual(normalized.reasonCodes, ['UNEXPECTED_SKIP']);
  assert.equal(normalized.counts.skipped, 1);
  assert.deepEqual(normalized.collectedFiles, step.argv);
});

test('Node test rejects missing summaries and a zero-case file wrapper reported as PASS', () => {
  assert.throws(
    () =>
      normalizeNodeTestReport([], {
        step: { cwd: '.', argv: ['scripts/missing.test.mjs'] },
        exitCode: 0,
        rawDigest: 'b'.repeat(64),
      }),
    /event report invalid/,
  );
  assert.throws(
    () =>
      normalizeNodeTestReport(
        [
          {
            type: 'test:pass',
            data: {
              name: 'scripts/empty.test.mjs',
              nesting: 0,
              testNumber: 1,
              skip: null,
              todo: null,
              file: join(repoRoot, 'scripts/empty.test.mjs'),
              details: { duration_ms: 1, type: 'test' },
            },
          },
          {
            type: 'test:summary',
            data: {
              success: true,
              counts: {
                tests: 1,
                failed: 0,
                passed: 1,
                cancelled: 0,
                skipped: 0,
                todo: 0,
                topLevel: 1,
                suites: 0,
              },
              duration_ms: 1,
            },
          },
        ],
        {
          step: { cwd: '.', argv: ['scripts/empty.test.mjs'] },
          exitCode: 0,
          rawDigest: 'b'.repeat(64),
        },
      ),
    /per-file summary inventory mismatch/,
  );
});

describe('native Node suite event compatibility', () => {
  test('a regular case inside describe remains machine reportable', () => {
    assert.equal(1 + 1, 2);
  });
});

test('an aggregate passes only with exact candidate-bound results from all required jobs', () => {
  const report = aggregate();
  assert.equal(report.decision, 'PASS');
  assert.deepEqual(
    report.suites.filter((suite) => suite.status === 'PASS').map((suite) => suite.suiteId),
    [
      'TS-CONTRACT-011',
      'TS-CONTRACT-DB-001',
      'TS-UNIT-011',
      'TS-ADAPTER-LOCAL-001',
      'TS-INFRA-REAL-PR-001',
      'TS-INFRA-REAL-PR-002',
    ],
  );
  assert.equal(
    report.suites.find((suite) => suite.suiteId === 'TS-HOST-REAL-001').status,
    'NOT_RUN',
  );
  assert.equal(
    report.suites.find((suite) => suite.suiteId === 'TS-BROWSER-AUTH-001').status,
    'NOT_IMPLEMENTED',
  );
  assert.equal(
    report.suites.find((suite) => suite.suiteId === 'TS-DESKTOP-UAT-011').status,
    'NOT_IMPLEMENTED',
  );
  assert.equal(report.productAcceptance.productStatus, 'BLOCKED');
});

test('a malformed or internally inconsistent acceptance ledger is INVALID and fails closed', () => {
  const partial = structuredClone(acceptance);
  partial.productStatus = 'PASS';
  partial.gates = partial.gates.slice(0, 2);
  const report = aggregate({
    acceptance: partial,
    jobResults: {
      sourceQuality: 'failure',
      billingPostgresql: 'success',
      postgresqlRedisIntegration: 'success',
    },
  });
  assert.equal(report.decision, 'FAIL');
  assert.equal(report.productAcceptance.productStatus, 'INVALID');
  assert.deepEqual(
    report.productAcceptance.gates.map((gate) => gate.status),
    ['INVALID', 'INVALID', 'INVALID', 'INVALID', 'INVALID'],
  );
  assert.match(report.errors.join('\n'), /invalid J-011 acceptance ledger/);
  assert.doesNotMatch(renderSummary(report, manifest), /J-011 product status: \*\*PASS\*\*/);

  for (const unverifiedAcceptance of [
    acceptanceWithEvidence(candidate.mergeSha),
    acceptanceWithEvidence('4'.repeat(40)),
    acceptanceWithEvidence('4'.repeat(40), { allGates: false }),
  ]) {
    const unverified = aggregate({ acceptance: unverifiedAcceptance });
    assert.equal(unverified.decision, 'FAIL');
    assert.equal(unverified.productAcceptance.productStatus, 'INVALID');
    assert.match(unverified.errors.join('\n'), /external verified acceptance adapter/);
  }
});

test('missing, blocked, mismatched, and unscheduled producer results fail the aggregate', () => {
  const missing = aggregate({ results: requiredResults().slice(1) });
  assert.equal(missing.decision, 'FAIL');
  assert.equal(missing.suites[0].reasonCodes[0], 'MISSING_MACHINE_RESULT');

  const blockedResults = requiredResults();
  blockedResults[0] = {
    ...blockedResults[0],
    status: 'BLOCKED',
    reasonCodes: ['MISSING_REQUIRED_ENV'],
    counts: {
      tests: 0,
      passed: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
      commands: 0,
    },
    provenClaimIds: [],
  };
  assert.equal(aggregate({ results: blockedResults }).decision, 'FAIL');

  const mismatched = requiredResults();
  mismatched[0] = {
    ...mismatched[0],
    candidate: { ...candidate, headSha: '4'.repeat(40) },
  };
  const mismatchedReport = aggregate({ results: mismatched });
  assert.equal(mismatchedReport.decision, 'FAIL');
  assert.match(mismatchedReport.errors.join('\n'), /candidate mismatch/);

  const host = manifest.suites.find((suite) => suite.id === 'TS-HOST-REAL-001');
  const injected = aggregate({ results: [...requiredResults(), passResult(host)] });
  assert.equal(injected.decision, 'FAIL');
  assert.match(injected.errors.join('\n'), /unscheduled PR suite produced a result/);

  const forged = requiredResults();
  forged[0] = { ...forged[0], steps: [] };
  const forgedReport = aggregate({ results: forged });
  assert.equal(forgedReport.decision, 'FAIL');
  assert.match(forgedReport.errors.join('\n'), /PASS step inventory mismatch/);

  const missingArtifacts = aggregate({ machineReports: new Map() });
  assert.equal(missingArtifacts.decision, 'FAIL');
  assert.match(missingArtifacts.errors.join('\n'), /machine report artifact missing/);

  const forgedDigest = requiredResults();
  forgedDigest[0].steps[0].machineReportSha256 = 'f'.repeat(64);
  const forgedDigestReport = aggregate({ results: forgedDigest });
  assert.equal(forgedDigestReport.decision, 'FAIL');
  assert.match(forgedDigestReport.errors.join('\n'), /machine report artifact digest mismatch/);

  const emptySelectedFile = requiredResults();
  const emptyFileStep = emptySelectedFile[0].steps[0];
  const removedTestCases = emptyFileStep.testCases.length - 1;
  emptyFileStep.testCases = emptyFileStep.testCases.slice(0, 1);
  emptyFileStep.counts.tests -= removedTestCases;
  emptyFileStep.counts.passed -= removedTestCases;
  emptySelectedFile[0].counts.tests -= removedTestCases;
  emptySelectedFile[0].counts.passed -= removedTestCases;
  const emptyFileReports = machineReportsFor(emptySelectedFile);
  emptyFileStep.machineReportSha256 = emptyFileReports.get(emptyFileStep.machineReportRef).sha256;
  const emptyFileReport = aggregate({
    results: emptySelectedFile,
    machineReports: emptyFileReports,
  });
  assert.equal(emptyFileReport.decision, 'FAIL');
  assert.match(emptyFileReport.errors.join('\n'), /collected file executed zero tests/);

  const reducedCaseInventory = requiredResults();
  const remainingInfrastructure = reducedCaseInventory.find(
    (result) => result.suiteId === 'TS-INFRA-REAL-PR-002',
  );
  const reducedStep = remainingInfrastructure.steps[0];
  reducedStep.testCases.pop();
  reducedStep.counts.tests -= 1;
  reducedStep.counts.passed -= 1;
  remainingInfrastructure.counts.tests -= 1;
  remainingInfrastructure.counts.passed -= 1;
  const reducedReports = machineReportsFor(reducedCaseInventory);
  reducedStep.machineReportSha256 = reducedReports.get(reducedStep.machineReportRef).sha256;
  const reducedReport = aggregate({
    results: reducedCaseInventory,
    machineReports: reducedReports,
  });
  assert.equal(reducedReport.decision, 'FAIL');
  assert.match(reducedReport.errors.join('\n'), /requires at least 9 tests, collected 8/);

  const expandedCaseInventory = requiredResults();
  const expandedInfrastructure = expandedCaseInventory.find(
    (result) => result.suiteId === 'TS-INFRA-REAL-PR-002',
  );
  const expandedStep = expandedInfrastructure.steps[0];
  expandedStep.testCases.push({
    id: `vitest:${expandedStep.collectedFiles[0]}:new candidate case`,
    file: expandedStep.collectedFiles[0],
    name: 'new candidate case',
    status: 'PASS',
    durationMs: 1,
  });
  expandedStep.counts.tests += 1;
  expandedStep.counts.passed += 1;
  expandedInfrastructure.counts.tests += 1;
  expandedInfrastructure.counts.passed += 1;
  const expandedReports = machineReportsFor(expandedCaseInventory);
  expandedStep.machineReportSha256 = expandedReports.get(expandedStep.machineReportRef).sha256;
  assert.equal(
    aggregate({ results: expandedCaseInventory, machineReports: expandedReports }).decision,
    'PASS',
  );

  const failedIntegration = aggregate({
    jobResults: {
      sourceQuality: 'success',
      billingPostgresql: 'success',
      postgresqlRedisIntegration: 'failure',
    },
  });
  assert.equal(failedIntegration.decision, 'FAIL');
  assert.deepEqual(
    failedIntegration.suites.find((suite) => suite.suiteId === 'TS-INFRA-REAL-PR-002').reasonCodes,
    ['DEPENDENCY_JOB_FAILURE'],
  );

  assert.throws(
    () =>
      aggregate({
        jobResults: {
          sourceQuality: 'success',
          billingPostgresql: 'not-a-job-result',
          postgresqlRedisIntegration: 'success',
        },
      }),
    /jobResults\.billingPostgresql invalid/,
  );
});

test('the Markdown summary keeps product acceptance and non-claims visible', () => {
  const summary = renderSummary(aggregate(), manifest);
  assert.match(summary, /^# PR CI gate: PASS/m);
  assert.match(summary, /J-011 product status: \*\*BLOCKED\*\*/);
  assert.match(summary, /J-011 acceptance candidate SHA: `NONE`/);
  assert.match(summary, /TS-HOST-REAL-001 \| HOST_REAL \| NOT_RUN/);
  assert.match(summary, /TS-BROWSER-AUTH-001 \| BROWSER \| NOT_IMPLEMENTED/);
  assert.match(summary, /TS-DESKTOP-UAT-011 \| DESKTOP_UAT \| NOT_IMPLEMENTED/);
  assert.match(summary, /external signed adapter exists/);
  assert.doesNotMatch(summary, /All tests passed/i);
});
