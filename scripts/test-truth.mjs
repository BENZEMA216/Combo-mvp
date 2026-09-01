#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acceptanceFixedArrays,
  acceptanceGateDefinitions,
  acceptancePath,
  addCounts,
  allowedStatuses,
  commandDigestForStep,
  emptyCounts,
  exactKeys,
  invariant,
  machineReportProtocol,
  manifestPath,
  nonEmptyString,
  parseCanonicalJson,
  parseManifest,
  reportProtocol,
  repoRoot,
  resultProtocol,
  runSuite,
  selectorPath,
  sha256,
  shaPattern,
  validateCandidate,
  validateRepositoryManifest,
  verifySyntheticMergeCheckout,
  writeJson,
} from './test-truth-core.mjs';

export const requiredStepMinimumTestCounts = Object.freeze({
  'TS-CONTRACT-011': Object.freeze([9, 7, 18]),
  'TS-CONTRACT-DB-001': Object.freeze([5]),
  'TS-UNIT-011': Object.freeze([18]),
  'TS-ADAPTER-LOCAL-001': Object.freeze([11, 11]),
  'TS-INFRA-REAL-PR-001': Object.freeze([3, 22, 1, 9, 1, 11, 12]),
  'TS-INFRA-REAL-PR-002': Object.freeze([9, 14, 6, 5]),
});

export {
  acceptancePath,
  classifyInventoryBoundary,
  manifestPath,
  normalizeNodeTestReport,
  normalizeVitestReport,
  parseManifest,
  repoRoot,
  validateRepositoryManifest,
} from './test-truth-core.mjs';

function findFilesWithSuffix(directory, suffix) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...findFilesWithSuffix(path, suffix));
    else if (entry.endsWith(suffix)) files.push(path);
  }
  return files.sort();
}

function findResultFiles(directory) {
  return findFilesWithSuffix(directory, '.result.json');
}

function synthesizedSuite(suite, status, reasonCode) {
  return {
    suiteId: suite.id,
    layer: suite.layer,
    status,
    reasonCodes: [reasonCode],
    counts: emptyCounts(),
    steps: [],
    provenClaimIds: [],
  };
}

function validateCounts(counts, label) {
  exactKeys(
    counts,
    ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'commands'],
    label,
  );
  for (const [name, value] of Object.entries(counts)) {
    invariant(Number.isSafeInteger(value) && value >= 0, `${label}.${name} invalid`);
  }
  invariant(
    counts.tests ===
      counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo,
    `${label} test totals disagree`,
  );
}

function validatePassingSteps(result, suite, candidate, machineReports) {
  invariant(Array.isArray(result.steps), `${suite.id} steps invalid`);
  const minimumTestCounts = requiredStepMinimumTestCounts[suite.id];
  invariant(
    Array.isArray(minimumTestCounts) && minimumTestCounts.length === suite.runner.steps.length,
    `${suite.id} required step minimum-test-count policy missing`,
  );
  invariant(
    result.steps.length === suite.runner.steps.length,
    `${suite.id} PASS step inventory mismatch`,
  );
  const aggregateCounts = emptyCounts();
  const testIds = new Set();
  for (const [index, stepResult] of result.steps.entries()) {
    const step = suite.runner.steps[index];
    const label = `${suite.id} step ${index}`;
    exactKeys(
      stepResult,
      [
        'index',
        'kind',
        'commandDigest',
        'status',
        'reasonCodes',
        'missingRequiredEnvNames',
        'startedAt',
        'finishedAt',
        'exitCode',
        'signal',
        'counts',
        'testCases',
        'collectedFiles',
        'machineReportRef',
        'machineReportSha256',
      ],
      label,
    );
    invariant(stepResult.index === index, `${label} index mismatch`);
    invariant(stepResult.kind === step.kind, `${label} kind mismatch`);
    invariant(
      stepResult.commandDigest === commandDigestForStep(step),
      `${label} command digest mismatch`,
    );
    invariant(stepResult.status === 'PASS', `${label} did not PASS`);
    invariant(
      Array.isArray(stepResult.reasonCodes) && stepResult.reasonCodes.length === 0,
      `${label} PASS contains reason codes`,
    );
    invariant(
      Array.isArray(stepResult.missingRequiredEnvNames) &&
        stepResult.missingRequiredEnvNames.length === 0,
      `${label} PASS contains missing environment`,
    );
    invariant(stepResult.exitCode === 0 && stepResult.signal === null, `${label} exit invalid`);
    validateCounts(stepResult.counts, `${label} counts`);
    addCounts(aggregateCounts, stepResult.counts);
    invariant(Array.isArray(stepResult.testCases), `${label} testCases invalid`);
    invariant(Array.isArray(stepResult.collectedFiles), `${label} collectedFiles invalid`);
    if (step.kind === 'VITEST' || step.kind === 'NODE_TEST') {
      const expectedFiles = step.argv.map((argument) => selectorPath(step, argument)).sort();
      invariant(
        JSON.stringify(stepResult.collectedFiles) === JSON.stringify(expectedFiles),
        `${label} collected file inventory mismatch`,
      );
      invariant(stepResult.counts.tests > 0, `${label} executed zero tests`);
      invariant(stepResult.counts.commands === 0, `${label} machine test command count invalid`);
      nonEmptyString(stepResult.machineReportRef, `${label} machine report ref`);
      invariant(
        !stepResult.machineReportRef.includes('/'),
        `${label} machine report ref must be a basename`,
      );
      invariant(
        /^[0-9a-f]{64}$/.test(stepResult.machineReportSha256),
        `${label} machine report digest invalid`,
      );
      const evidence = machineReports.get(stepResult.machineReportRef);
      invariant(evidence !== undefined, `${label} machine report artifact missing`);
      invariant(
        evidence.sha256 === stepResult.machineReportSha256,
        `${label} machine report artifact digest mismatch`,
      );
      const machineReport = evidence.value;
      exactKeys(
        machineReport,
        [
          'protocol',
          'schemaVersion',
          'suiteId',
          'stepIndex',
          'framework',
          'candidate',
          'commandDigest',
          'status',
          'reasonCodes',
          'counts',
          'testCases',
          'collectedFiles',
        ],
        `${label} machine report`,
      );
      invariant(
        machineReport.protocol === machineReportProtocol,
        `${label} report protocol invalid`,
      );
      invariant(machineReport.schemaVersion === 1, `${label} report schemaVersion invalid`);
      invariant(machineReport.suiteId === suite.id, `${label} report suite mismatch`);
      invariant(machineReport.stepIndex === index, `${label} report step mismatch`);
      invariant(machineReport.framework === step.kind, `${label} report framework mismatch`);
      invariant(
        JSON.stringify(machineReport.candidate) === JSON.stringify(candidate),
        `${label} report candidate mismatch`,
      );
      invariant(
        machineReport.commandDigest === stepResult.commandDigest,
        `${label} report command mismatch`,
      );
      for (const field of ['status', 'reasonCodes', 'counts', 'testCases', 'collectedFiles']) {
        invariant(
          JSON.stringify(machineReport[field]) === JSON.stringify(stepResult[field]),
          `${label} report ${field} mismatch`,
        );
      }
      invariant(
        stepResult.testCases.length === stepResult.counts.tests,
        `${label} test case inventory mismatch`,
      );
      for (const file of stepResult.collectedFiles) {
        invariant(
          stepResult.testCases.some((testCase) => testCase.file === file),
          `${label} collected file executed zero tests: ${file}`,
        );
      }
      invariant(
        stepResult.counts.tests >= minimumTestCounts[index],
        `${label} requires at least ${minimumTestCounts[index]} tests, collected ${stepResult.counts.tests}`,
      );
      for (const testCase of stepResult.testCases) {
        exactKeys(testCase, ['id', 'file', 'name', 'status', 'durationMs'], `${label} test case`);
        invariant(testCase.status === 'PASS', `${label} PASS contains a non-PASS test case`);
        invariant(
          stepResult.collectedFiles.includes(testCase.file),
          `${label} test case file was not collected`,
        );
        invariant(!testIds.has(testCase.id), `${suite.id} duplicate test case id`);
        testIds.add(testCase.id);
      }
    } else {
      invariant(stepResult.counts.tests === 0, `${label} COMMAND invented tests`);
      invariant(stepResult.counts.commands === 1, `${label} COMMAND count invalid`);
      invariant(stepResult.testCases.length === 0, `${label} COMMAND invented test cases`);
      invariant(stepResult.collectedFiles.length === 0, `${label} COMMAND collected test files`);
      invariant(
        stepResult.machineReportRef === null,
        `${label} COMMAND machine report ref invalid`,
      );
      invariant(
        stepResult.machineReportSha256 === null,
        `${label} COMMAND machine report digest invalid`,
      );
    }
  }
  invariant(
    JSON.stringify(result.counts) === JSON.stringify(aggregateCounts),
    `${suite.id} aggregate counts disagree with steps`,
  );
}

function validateProducerResult(result, suite, candidate, manifestSha256, machineReports) {
  exactKeys(
    result,
    [
      'protocol',
      'schemaVersion',
      'suiteId',
      'layer',
      'target',
      'source',
      'candidate',
      'manifestSha256',
      'status',
      'reasonCodes',
      'startedAt',
      'finishedAt',
      'counts',
      'steps',
      'provenClaimIds',
    ],
    `${suite.id} result`,
  );
  invariant(result.protocol === resultProtocol, `${suite.id} result protocol invalid`);
  invariant(result.schemaVersion === 1, `${suite.id} result schemaVersion invalid`);
  invariant(result.suiteId === suite.id, `${suite.id} result suite mismatch`);
  invariant(result.layer === suite.layer, `${suite.id} result layer mismatch`);
  invariant(result.target === 'PR', `${suite.id} result target mismatch`);
  invariant(result.source === suite.resultSource, `${suite.id} result source mismatch`);
  invariant(
    JSON.stringify(result.candidate) === JSON.stringify(candidate),
    `${suite.id} result candidate mismatch`,
  );
  invariant(result.manifestSha256 === manifestSha256, `${suite.id} manifest digest mismatch`);
  invariant(allowedStatuses.has(result.status), `${suite.id} result status invalid`);
  invariant(
    result.status !== 'NOT_RUN' && result.status !== 'NOT_IMPLEMENTED',
    `${suite.id} required result did not run`,
  );
  validateCounts(result.counts, `${suite.id} result counts`);
  invariant(Array.isArray(result.provenClaimIds), `${suite.id} provenClaimIds invalid`);
  if (result.status !== 'PASS') {
    invariant(result.provenClaimIds.length === 0, `${suite.id} non-PASS result claims proof`);
  } else {
    invariant(
      Array.isArray(result.reasonCodes) && result.reasonCodes.length === 0,
      `${suite.id} PASS contains reason codes`,
    );
    validatePassingSteps(result, suite, candidate, machineReports);
    invariant(
      result.counts.tests + result.counts.commands > 0,
      `${suite.id} PASS has no execution evidence`,
    );
    invariant(result.counts.failed === 0, `${suite.id} PASS contains failed tests`);
    invariant(result.counts.cancelled === 0, `${suite.id} PASS contains cancelled tests`);
    invariant(result.counts.skipped === 0, `${suite.id} PASS contains skipped tests`);
    invariant(result.counts.todo === 0, `${suite.id} PASS contains todo tests`);
    invariant(
      JSON.stringify(result.provenClaimIds) ===
        JSON.stringify(suite.proves.map((claim) => claim.id)),
      `${suite.id} PASS claim set mismatch`,
    );
  }
  return result;
}

export function acceptanceSummary(acceptance) {
  exactKeys(
    acceptance,
    [
      'protocol',
      'schemaVersion',
      'goal',
      'journey',
      'capabilities',
      'surface',
      'source',
      'processContractStatus',
      'productStatus',
      'candidateCommit',
      'gates',
      'observationWindow',
      'requiredUserSteps',
      'forbiddenUserPrerequisites',
      'forbiddenCreatorInputs',
      'forbiddenFallbacks',
      'requiredEvidence',
      'nonAcceptanceEvidenceClasses',
    ],
    'J-011 acceptance ledger',
  );
  invariant(
    acceptance.protocol === 'combo.creator-conversation-acceptance/1',
    'J-011 acceptance protocol invalid',
  );
  invariant(acceptance.schemaVersion === 1, 'J-011 acceptance schemaVersion invalid');
  invariant(acceptance.goal === 'G-001@v1', 'J-011 acceptance goal invalid');
  invariant(acceptance.journey === 'J-011', 'J-011 acceptance journey invalid');
  invariant(acceptance.surface === 'CODEX_DESKTOP', 'J-011 acceptance surface invalid');
  invariant(acceptance.source === 'CURRENT_CONVERSATION', 'J-011 acceptance source invalid');
  invariant(
    acceptance.processContractStatus === 'ACTIVE',
    'J-011 acceptance process contract invalid',
  );
  invariant(
    acceptance.productStatus === 'BLOCKED' || acceptance.productStatus === 'PASS',
    'J-011 acceptance productStatus invalid',
  );
  invariant(
    acceptance.candidateCommit === null || shaPattern.test(acceptance.candidateCommit),
    'J-011 acceptance candidateCommit invalid',
  );
  for (const [name, expected] of Object.entries(acceptanceFixedArrays)) {
    invariant(
      JSON.stringify(acceptance[name]) === JSON.stringify(expected),
      `J-011 acceptance ${name} invalid`,
    );
  }
  exactKeys(acceptance.observationWindow, ['startsAt', 'endsAt'], 'J-011 observationWindow');
  invariant(
    acceptance.observationWindow.startsAt === 'DIRECT_USER_CREATOR_ITEM_ACCEPTED' &&
      acceptance.observationWindow.endsAt === 'DRAFT_TERMINAL_RESULT',
    'J-011 observationWindow invalid',
  );
  invariant(
    Array.isArray(acceptance.gates) && acceptance.gates.length === acceptanceGateDefinitions.length,
    'J-011 acceptance requires exactly five gates',
  );

  const artifactRefs = new Set();
  const artifactDigests = new Set();
  let evidenceCount = 0;
  const gates = acceptance.gates.map((gate, index) => {
    const [expectedId, expectedKind] = acceptanceGateDefinitions[index];
    exactKeys(gate, ['id', 'status', 'evidence'], `J-011 gate ${index}`);
    invariant(gate.id === expectedId, `J-011 gate ${index} id or order invalid`);
    invariant(
      ['NOT_IMPLEMENTED', 'NOT_RUN', 'PASS'].includes(gate.status),
      `${gate.id} status invalid`,
    );
    invariant(Array.isArray(gate.evidence), `${gate.id} evidence invalid`);
    invariant(
      (gate.status === 'PASS') === gate.evidence.length > 0,
      `${gate.id} status and evidence disagree`,
    );
    for (const [evidenceIndex, evidence] of gate.evidence.entries()) {
      const label = `${gate.id} evidence ${evidenceIndex}`;
      exactKeys(evidence, ['kind', 'artifactRef', 'artifactSha256', 'environment'], label);
      invariant(evidence.kind === expectedKind, `${label} kind invalid`);
      nonEmptyString(evidence.artifactRef, `${label}.artifactRef`);
      invariant(
        /^sha256:[0-9a-f]{64}$/.test(evidence.artifactSha256),
        `${label}.artifactSha256 invalid`,
      );
      exactKeys(
        evidence.environment,
        ['repositoryCommit', 'runtimeIdentity', 'componentVersions'],
        `${label}.environment`,
      );
      invariant(
        shaPattern.test(evidence.environment.repositoryCommit),
        `${label}.environment.repositoryCommit invalid`,
      );
      nonEmptyString(evidence.environment.runtimeIdentity, `${label}.environment.runtimeIdentity`);
      invariant(
        Array.isArray(evidence.environment.componentVersions) &&
          evidence.environment.componentVersions.length > 0,
        `${label}.environment.componentVersions invalid`,
      );
      for (const [versionIndex, version] of evidence.environment.componentVersions.entries()) {
        const versionLabel = `${label}.environment.componentVersions[${versionIndex}]`;
        exactKeys(version, ['component', 'version'], versionLabel);
        nonEmptyString(version.component, `${versionLabel}.component`);
        nonEmptyString(version.version, `${versionLabel}.version`);
      }
      invariant(!artifactRefs.has(evidence.artifactRef), 'J-011 evidence artifactRef reused');
      invariant(!artifactDigests.has(evidence.artifactSha256), 'J-011 evidence digest reused');
      artifactRefs.add(evidence.artifactRef);
      artifactDigests.add(evidence.artifactSha256);
      invariant(
        evidence.environment.repositoryCommit === acceptance.candidateCommit,
        'J-011 evidence candidate commit mismatch',
      );
      evidenceCount += 1;
    }
    return { id: gate.id, status: gate.status, evidenceCount: gate.evidence.length };
  });
  const everyGatePassed = acceptance.gates.every((gate) => gate.status === 'PASS');
  invariant(
    everyGatePassed === (acceptance.productStatus === 'PASS'),
    'J-011 productStatus does not equal the five-gate result',
  );
  invariant(
    !everyGatePassed && evidenceCount === 0 ? true : acceptance.candidateCommit !== null,
    'J-011 acceptance candidate binding invalid',
  );
  invariant(
    evidenceCount === 0 && acceptance.candidateCommit === null,
    'tracked J-011 evidence requires an external verified acceptance adapter',
  );
  return {
    protocol: acceptance.protocol,
    journey: acceptance.journey,
    productStatus: acceptance.productStatus,
    candidateCommit: acceptance.candidateCommit,
    gates,
  };
}

function invalidAcceptanceSummary() {
  return {
    protocol: 'combo.creator-conversation-acceptance/1',
    journey: 'J-011',
    productStatus: 'INVALID',
    candidateCommit: null,
    gates: acceptanceGateDefinitions.map(([id]) => ({ id, status: 'INVALID', evidenceCount: 0 })),
  };
}

export function buildAggregate({
  manifest,
  manifestSha256,
  results,
  machineReports,
  jobResults,
  candidate,
  acceptance,
  coverage,
}) {
  validateCandidate(candidate);
  invariant(machineReports instanceof Map, 'machineReports must be a Map');
  exactKeys(
    jobResults,
    ['sourceQuality', 'billingPostgresql', 'postgresqlRedisIntegration'],
    'jobResults',
  );
  for (const [job, result] of Object.entries(jobResults)) {
    invariant(
      ['success', 'failure', 'cancelled', 'skipped'].includes(result),
      `jobResults.${job} invalid`,
    );
  }
  const globalErrors = [];
  const bySuite = new Map();
  for (const result of results) {
    if (bySuite.has(result.suiteId)) globalErrors.push(`duplicate result: ${result.suiteId}`);
    else bySuite.set(result.suiteId, result);
  }
  const knownSuiteIds = new Set(manifest.suites.map((suite) => suite.id));
  for (const suiteId of bySuite.keys()) {
    if (!knownSuiteIds.has(suiteId)) globalErrors.push(`unknown result suite: ${suiteId}`);
  }
  const referencedMachineReports = new Set(
    results.flatMap((result) =>
      Array.isArray(result.steps)
        ? result.steps
            .map((step) => step?.machineReportRef)
            .filter((reference) => typeof reference === 'string')
        : [],
    ),
  );
  for (const reference of machineReports.keys()) {
    if (!referencedMachineReports.has(reference)) {
      globalErrors.push(`orphan machine report artifact: ${reference}`);
    }
  }

  const suites = manifest.suites.map((suite) => {
    if (suite.defaults.pr !== 'RUN_REQUIRED') {
      if (bySuite.has(suite.id)) {
        globalErrors.push(`unscheduled PR suite produced a result: ${suite.id}`);
      }
      return suite.implementation === 'NOT_IMPLEMENTED'
        ? synthesizedSuite(suite, 'NOT_IMPLEMENTED', 'RUNNER_NOT_IMPLEMENTED')
        : synthesizedSuite(suite, 'NOT_RUN', 'NOT_SCHEDULED_FOR_PR');
    }
    const dependencyResult =
      {
        PR_SOURCE: jobResults.sourceQuality,
        PR_INFRA: jobResults.billingPostgresql,
        PR_INTEGRATION: jobResults.postgresqlRedisIntegration,
      }[suite.resultSource] ?? 'skipped';
    const producer = bySuite.get(suite.id);
    if (dependencyResult !== 'success') {
      if (producer) {
        try {
          const validated = validateProducerResult(
            producer,
            suite,
            candidate,
            manifestSha256,
            machineReports,
          );
          if (validated.status !== 'PASS') return validated;
        } catch (error) {
          globalErrors.push(error.message);
        }
      }
      return synthesizedSuite(
        suite,
        'FAIL',
        `DEPENDENCY_JOB_${String(dependencyResult).toUpperCase()}`,
      );
    }
    if (!producer) return synthesizedSuite(suite, 'FAIL', 'MISSING_MACHINE_RESULT');
    try {
      return validateProducerResult(producer, suite, candidate, manifestSha256, machineReports);
    } catch (error) {
      globalErrors.push(error.message);
      return synthesizedSuite(suite, 'FAIL', 'INVALID_MACHINE_RESULT');
    }
  });
  const requiredFailures = suites.filter(
    (suite) =>
      manifest.suites.find((candidateSuite) => candidateSuite.id === suite.suiteId).defaults.pr ===
        'RUN_REQUIRED' && suite.status !== 'PASS',
  );
  let productAcceptance;
  try {
    productAcceptance = acceptanceSummary(acceptance);
  } catch (error) {
    globalErrors.push(`invalid J-011 acceptance ledger: ${error.message}`);
    productAcceptance = invalidAcceptanceSummary();
  }
  const decision = requiredFailures.length === 0 && globalErrors.length === 0 ? 'PASS' : 'FAIL';
  return {
    protocol: reportProtocol,
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: 'PR',
    candidate,
    manifestSha256,
    decision,
    dependencyJobs: jobResults,
    coverage,
    suites,
    productAcceptance,
    nonClaims: [
      'A green PR gate does not prove the real bundled Codex suites ran.',
      'A green PR gate does not prove an Agent browser journey ran.',
      'A green PR gate does not prove Codex Desktop Host or ordinary-user UAT.',
      'PR CI cannot verify tracked J-011 acceptance evidence until the external signed adapter exists.',
      'A green PR gate does not prove Preview, Production, or a cross-user G-001 journey.',
    ],
    errors: globalErrors.sort(),
  };
}

function markdownCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function suiteEvidence(suite) {
  if (suite.status !== 'PASS') return suite.reasonCodes.join(', ');
  return `${suite.counts.tests} framework tests; ${suite.counts.commands} command checks; 0 skipped`;
}

export function renderSummary(report, manifest) {
  const manifestSuites = new Map(manifest.suites.map((suite) => [suite.id, suite]));
  const lines = [
    `# PR CI gate: ${report.decision}`,
    '',
    `Candidate merge SHA: \`${report.candidate.mergeSha}\``,
    '',
    `Base SHA: \`${report.candidate.baseSha}\``,
    '',
    `Head SHA: \`${report.candidate.headSha}\``,
    '',
    `Manifest SHA-256: \`${report.manifestSha256}\``,
    '',
    '## Required and visible suites',
    '',
    '| Suite | Layer | State | Machine evidence | Explicit boundary |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const suite of report.suites) {
    const catalog = manifestSuites.get(suite.suiteId);
    lines.push(
      `| ${suite.suiteId} | ${suite.layer} | ${suite.status} | ${markdownCell(suiteEvidence(suite))} | ${markdownCell(catalog.doesNotProve.join(' '))} |`,
    );
  }
  lines.push(
    '',
    '## Inventory boundary',
    '',
    `- Tracked JS/TS test files: ${report.coverage.totalTestFiles}`,
    `- Catalogued files: ${report.coverage.classifiedTestFiles}`,
    `- Baseline-unclassified files: ${report.coverage.baselineUnclassifiedCount}`,
    `- New unclassified files: ${report.coverage.newUnclassifiedCount}`,
    `- Unclassified policy: ${report.coverage.unclassifiedPolicy}`,
    '',
    '## Product acceptance (read-only)',
    '',
    `J-011 product status: **${report.productAcceptance.productStatus}**`,
    '',
    `J-011 acceptance candidate SHA: \`${report.productAcceptance.candidateCommit ?? 'NONE'}\``,
    '',
    '| Acceptance gate | State | Evidence records |',
    '| --- | --- | --- |',
  );
  for (const gate of report.productAcceptance.gates) {
    lines.push(`| ${gate.id} | ${gate.status} | ${gate.evidenceCount} |`);
  }
  lines.push('', '## This PR gate does not claim', '');
  for (const claim of report.nonClaims) lines.push(`- ${claim}`);
  if (report.errors.length > 0) {
    lines.push('', '## Truth-gate errors', '');
    for (const error of report.errors) lines.push(`- ${error}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    invariant(token.startsWith('--'), `unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    invariant(value !== undefined && !value.startsWith('--'), `missing value for --${name}`);
    invariant(options[name] === undefined, `duplicate option --${name}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function requiredOption(options, name) {
  const value = options[name];
  nonEmptyString(value, `--${name}`);
  return value;
}

function loadManifest(root = repoRoot) {
  const source = readFileSync(join(root, manifestPath), 'utf8');
  const manifest = parseManifest(source);
  const coverage = validateRepositoryManifest(manifest, root);
  return { source, manifest, coverage, digest: sha256(source) };
}

function candidateFromOptions(options) {
  const candidate = {
    mergeSha: requiredOption(options, 'candidate'),
    baseSha: requiredOption(options, 'base'),
    headSha: requiredOption(options, 'head'),
  };
  validateCandidate(candidate);
  return candidate;
}

function readResults(directory) {
  const results = [];
  const errors = [];
  for (const file of findResultFiles(directory)) {
    try {
      results.push(parseCanonicalJson(readFileSync(file, 'utf8'), `producer result ${file}`));
    } catch (error) {
      errors.push(error.message);
    }
  }
  const machineReports = new Map();
  for (const file of findFilesWithSuffix(directory, '.machine.json')) {
    const reference = basename(file);
    try {
      invariant(!machineReports.has(reference), `duplicate machine report artifact: ${reference}`);
      const source = readFileSync(file, 'utf8');
      machineReports.set(reference, {
        sha256: sha256(source),
        value: parseCanonicalJson(source, `machine report ${file}`),
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { results, machineReports, errors };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  if (command === 'validate') {
    invariant(Object.keys(options).length === 0, 'validate does not accept options');
    const { coverage, digest } = loadManifest();
    process.stdout.write(
      `[test-truth] manifest valid (${coverage.classifiedTestFiles}/${coverage.totalTestFiles} files catalogued, sha256:${digest})\n`,
    );
    return;
  }
  if (command === 'run-group') {
    const source = requiredOption(options, 'source');
    invariant(
      source === 'PR_SOURCE' || source === 'PR_INFRA' || source === 'PR_INTEGRATION',
      '--source must be PR_SOURCE, PR_INFRA, or PR_INTEGRATION',
    );
    const target = requiredOption(options, 'target');
    invariant(target === 'PR', 'only the PR target is implemented');
    const candidate = candidateFromOptions(options);
    verifySyntheticMergeCheckout(candidate);
    const resultsDirectory = resolve(requiredOption(options, 'results-dir'));
    const loaded = loadManifest();
    const suites = loaded.manifest.suites.filter(
      (suite) => suite.resultSource === source && suite.defaults.pr === 'RUN_REQUIRED',
    );
    invariant(suites.length > 0, `no required suites for ${source}`);
    const results = suites.map((suite) =>
      runSuite({
        suite,
        target,
        candidate,
        manifestSha256: loaded.digest,
        resultsDirectory,
      }),
    );
    const failed = results.filter((result) => result.status !== 'PASS');
    process.stdout.write(
      `[test-truth] ${source}: ${results.length - failed.length}/${results.length} suites PASS\n`,
    );
    if (failed.length > 0) process.exitCode = 1;
    return;
  }
  if (command === 'aggregate') {
    const candidate = candidateFromOptions(options);
    verifySyntheticMergeCheckout(candidate);
    const loaded = loadManifest();
    const read = readResults(resolve(requiredOption(options, 'results-dir')));
    const acceptance = parseCanonicalJson(
      readFileSync(join(repoRoot, acceptancePath), 'utf8'),
      'J-011 acceptance ledger',
    );
    const report = buildAggregate({
      manifest: loaded.manifest,
      manifestSha256: loaded.digest,
      results: read.results,
      machineReports: read.machineReports,
      jobResults: {
        sourceQuality: requiredOption(options, 'source-result'),
        billingPostgresql: requiredOption(options, 'infra-result'),
        postgresqlRedisIntegration: requiredOption(options, 'integration-result'),
      },
      candidate,
      acceptance,
      coverage: loaded.coverage,
    });
    report.errors.push(...read.errors);
    if (read.errors.length > 0) report.decision = 'FAIL';
    const output = resolve(requiredOption(options, 'output'));
    const summary = resolve(requiredOption(options, 'summary'));
    writeJson(output, report);
    mkdirSync(dirname(summary), { recursive: true });
    writeFileSync(summary, renderSummary(report, loaded.manifest), { mode: 0o600 });
    process.stdout.write(`[test-truth] PR aggregate: ${report.decision}\n`);
    return;
  }
  if (command === 'enforce') {
    const report = parseCanonicalJson(
      readFileSync(resolve(requiredOption(options, 'report')), 'utf8'),
      'test truth report',
    );
    invariant(report.protocol === reportProtocol, 'test truth report protocol invalid');
    invariant(report.schemaVersion === 1, 'test truth report schemaVersion invalid');
    if (report.decision !== 'PASS') {
      for (const suite of report.suites.filter((item) => item.status === 'FAIL')) {
        process.stderr.write(
          `[test-truth:fail] ${suite.suiteId}: ${suite.reasonCodes.join(', ')}\n`,
        );
      }
      for (const error of report.errors) process.stderr.write(`[test-truth:fail] ${error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('[test-truth] required PR evidence is complete\n');
    }
    return;
  }
  throw new Error('usage: test-truth.mjs validate | run-group | aggregate | enforce');
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[test-truth:fail] ${error.message}\n`);
    process.exitCode = 1;
  }
}
