#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifestPath = 'tests/test-suites/manifest.v1.json';
export const acceptancePath = 'apps/creator-worker/creator-conversation-acceptance.v1.json';

const manifestProtocol = 'combo.test-suite-manifest/1';
const resultProtocol = 'combo.test-suite-result/1';
const machineReportProtocol = 'combo.framework-test-report/1';
const reportProtocol = 'combo.test-truth/1';
const coveragePolicy = Object.freeze({
  mode: 'PILOT_INVENTORY',
  baselineCommit: 'a1f11aed98d465fa91044beba7ccbcb95629030f',
  baselineTestInventoryCount: 200,
  unclassifiedPolicy: 'NO_EVIDENCE_CLAIMS',
});
const shaPattern = /^[0-9a-f]{40}$/;
const suiteIdPattern = /^TS-[A-Z0-9]+(?:-[A-Z0-9]+)+$/;
const claimIdPattern = /^CLAIM-[A-Z0-9]+(?:-[A-Z0-9]+)+$/;
const testFilePattern = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const allowedLayers = new Set([
  'CONTRACT',
  'UNIT_FAKE',
  'ADAPTER_LOCAL',
  'INFRA_REAL',
  'HOST_REAL',
  'BROWSER',
  'DESKTOP_UAT',
]);
const allowedSources = new Set(['PR_SOURCE', 'PR_INFRA', 'MAIN_INTEGRATION', 'MANUAL', 'NONE']);
const allowedPrMainSchedules = new Set(['RUN_REQUIRED', 'RUN_OPTIONAL', 'NOT_SCHEDULED']);
const allowedManualSchedules = new Set(['AVAILABLE', 'REQUIRED_FOR_ACCEPTANCE', 'NOT_AVAILABLE']);
const allowedStatuses = new Set(['PASS', 'FAIL', 'NOT_RUN', 'BLOCKED', 'NOT_IMPLEMENTED']);
const nodeTruthReporterPath = join(repoRoot, 'scripts/node-test-truth-reporter.mjs');
const acceptanceGateDefinitions = Object.freeze([
  ['ACC-CONTRACT-011A', 'CONTRACT_TEST_REPORT'],
  ['ACC-UNIT-011B', 'CONVERSATION_EXTRACTION_TEST_REPORT'],
  ['ACC-SEC-011C', 'SECURITY_BOUNDARY_TEST_REPORT'],
  ['ACC-HOST-011D', 'DESKTOP_CURRENT_TASK_RUN_RECEIPT'],
  ['ACC-UAT-011E', 'NON_DEVELOPER_UAT_RECEIPT'],
]);
const acceptanceFixedArrays = Object.freeze({
  capabilities: ['CAP-011', 'CAP-012'],
  requiredUserSteps: ['ONE_NATURAL_LANGUAGE_INSTRUCTION'],
  forbiddenUserPrerequisites: ['HOOK_TRUST', 'PROJECT_PATH_INPUT', 'TERMINAL_COMMAND'],
  forbiddenCreatorInputs: [
    'CALLER_SUPPLIED_TASK_ID',
    'CALLER_SUPPLIED_THREAD_ID',
    'CALLER_SUPPLIED_SESSION_ID',
    'CALLER_SUPPLIED_RAW_TRANSCRIPT',
  ],
  forbiddenFallbacks: [
    'LEGACY_HOOK_BRIDGE',
    'PROJECT_SCAN',
    'RAW_SESSION_FILE_READ',
    'PLUGIN_OR_MCP_THREAD_STORE_READ',
  ],
  requiredEvidence: [
    'DIRECT_USER_CREATOR_ITEM',
    'DESKTOP_ATTESTED_ACTIVE_CURRENT_TASK_SOURCE_BOUNDARY',
    'EXACT_COMPONENT_VERSIONS',
    'SIGNED_DESKTOP_CURRENT_TASK_RUN_RECEIPT',
    'SANITIZED_CONVERSATION_PROVENANCE',
    'STUDIO_VISIBLE_AGENT_PACKAGE_DRAFT',
    'ZERO_ADDITIONAL_CREATOR_PROJECT_SCANS',
    'ZERO_ADDITIONAL_CREATOR_PROJECT_FILE_READS',
    'ZERO_ADDITIONAL_CREATOR_PROJECT_FILE_WRITES',
    'ZERO_CREATOR_CLI_OR_BRIDGE_CHILD_PROCESSES',
    'ZERO_HOOK_TRUST_WRITES',
    'ZERO_PLUGIN_OR_MCP_THREAD_STORE_READS',
    'ZERO_RAW_SESSION_FILE_READS',
    'ZERO_USER_TERMINAL_ACTIONS',
  ],
  nonAcceptanceEvidenceClasses: [
    'PROJECT_FIRST_CREATOR',
    'PLUGIN_HOOK_OR_BRIDGE',
    'CREATOR_CLI',
    'FAKE_HOST_OR_PORT',
    'ISOLATED_BUNDLED_CODEX_THREAD',
    'PRESENTATION_ONLY_DRAFT_CARD',
  ],
});
const suiteSemanticPolicy = Object.freeze({
  'TS-CONTRACT-011': {
    layer: 'CONTRACT',
    acceptance: {
      relationship: 'SUPPORTING',
      journeyIds: ['J-011'],
      acceptanceIds: ['ACC-CONTRACT-011A'],
    },
    proves: [
      {
        id: 'CLAIM-J011-MACHINE-CONTRACT',
        statement:
          'The J-011 machine contract, evidence verifier, and current blocked status are internally consistent.',
      },
    ],
  },
  'TS-CONTRACT-DB-001': {
    layer: 'CONTRACT',
    acceptance: { relationship: 'SUPPORTING', journeyIds: [], acceptanceIds: [] },
    proves: [
      {
        id: 'CLAIM-PENDING-USAGE-RECOVERY-MIGRATION-CONTRACT',
        statement:
          'The selected pending-usage recovery migration source invariants passed against the exact candidate tree.',
      },
    ],
  },
  'TS-UNIT-011': {
    layer: 'UNIT_FAKE',
    acceptance: {
      relationship: 'SUPPORTING',
      journeyIds: ['J-011'],
      acceptanceIds: ['ACC-UNIT-011B'],
    },
    proves: [
      {
        id: 'CLAIM-J011-UNIT-FAKE',
        statement:
          'Draft extraction and composition behave as specified with controlled local inputs and fake Host boundaries.',
      },
    ],
  },
  'TS-ADAPTER-LOCAL-001': {
    layer: 'ADAPTER_LOCAL',
    acceptance: { relationship: 'SUPPORTING', journeyIds: [], acceptanceIds: [] },
    proves: [
      {
        id: 'CLAIM-CONTROLLED-LOCAL-ADAPTERS',
        statement:
          'The selected SQLite, filesystem, and loopback WebSocket adapters satisfy their controlled local contracts.',
      },
    ],
  },
  'TS-INFRA-REAL-PR-001': {
    layer: 'INFRA_REAL',
    acceptance: { relationship: 'SUPPORTING', journeyIds: [], acceptanceIds: [] },
    proves: [
      {
        id: 'CLAIM-PR-POSTGRES-INVARIANTS',
        statement:
          'The selected Registry, receipt, pending-usage recovery, role, upgrade, and billing invariants passed against ephemeral PostgreSQL 16.',
      },
    ],
  },
  'TS-INFRA-REAL-MAIN-002': {
    layer: 'INFRA_REAL',
    acceptance: { relationship: 'SUPPORTING', journeyIds: [], acceptanceIds: [] },
    proves: [
      {
        id: 'CLAIM-MAIN-INFRA-INTEGRATIONS',
        statement:
          'The remaining selected PostgreSQL and Redis integration contracts passed on the tested main candidate.',
      },
    ],
  },
  'TS-HOST-REAL-001': {
    layer: 'HOST_REAL',
    acceptance: { relationship: 'NON_ACCEPTANCE', journeyIds: ['J-011'], acceptanceIds: [] },
    proves: [
      {
        id: 'CLAIM-BUNDLED-CODEX-LOCAL-HOST',
        statement:
          'The selected isolated local runs completed through the bundled Codex executable on the tested machine.',
      },
    ],
  },
  'TS-BROWSER-AUTH-001': {
    layer: 'BROWSER',
    acceptance: { relationship: 'SUPPORTING', journeyIds: [], acceptanceIds: [] },
    proves: [],
  },
  'TS-DESKTOP-UAT-011': {
    layer: 'DESKTOP_UAT',
    acceptance: {
      relationship: 'GATE',
      journeyIds: ['J-011'],
      acceptanceIds: ['ACC-HOST-011D', 'ACC-UAT-011E'],
    },
    proves: [],
  },
});
const suiteExecutionPolicyDigests = Object.freeze({
  'TS-CONTRACT-011': '8b5070aca06a5e6dede7deb0f3df44b6c11c25beb7f1fda6d04f0fe94256d7b8',
  'TS-CONTRACT-DB-001': '432fd6d3a31e80fd66ad8ab6143f762b41825b05d3759731bfe340db94924f29',
  'TS-UNIT-011': 'fe4d387d827a61f05e4c06c50ad6b1b1b9d1f3d316adfd762b2747e1305abb75',
  'TS-ADAPTER-LOCAL-001': 'bfbf919bd1ad68ce316fd307f954c6697a078d0d501fec1472c53b63a2779007',
  'TS-INFRA-REAL-PR-001': '5e19a7197120b4f5ee3b11cf911a7ec24dc8a1dc58dbd84942dd0bb6768c423c',
  'TS-INFRA-REAL-MAIN-002': 'bb533ba0250b38b134aef544dc0dc2fed99416b749620de856cd6a5c5fa70309',
  'TS-HOST-REAL-001': '8029a02fdb0c332d941fbc3e4cac23acf303eabe1e9bdf0a70e05be8cff056e3',
  'TS-BROWSER-AUTH-001': 'b53be46c1ccc2e86c2dccf86469ca777c3bf134fe470ca9a7028b5e2dc1f4b9a',
  'TS-DESKTOP-UAT-011': 'd642d6aa24371e31373c3c2d008760712fc78b2925879d19c5f19acf28d2bcd2',
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

function nonEmptyString(value, label) {
  invariant(
    typeof value === 'string' && value.trim() === value && value.length > 0,
    `${label} invalid`,
  );
}

function safeRepoFile(value, label = 'repository path') {
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

function safeRepoDirectory(value, label) {
  if (value === '.') return;
  safeRepoFile(value, label);
}

function sortedUniqueStrings(values, label, { allowEmpty = false, paths = false } = {}) {
  invariant(Array.isArray(values), `${label} must be an array`);
  invariant(allowEmpty || values.length > 0, `${label} must not be empty`);
  for (const value of values) {
    if (paths) safeRepoFile(value, label);
    else nonEmptyString(value, label);
  }
  invariant(new Set(values).size === values.length, `${label} contains duplicates`);
  invariant(
    JSON.stringify(values) === JSON.stringify([...values].sort()),
    `${label} must be sorted`,
  );
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseCanonicalJson(source, label) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  invariant(
    source === `${source.trimEnd()}\n`,
    `${label} must have exactly one trailing newline and no trailing whitespace`,
  );
  return value;
}

function validateClaim(claim, label) {
  exactKeys(claim, ['id', 'statement'], label);
  invariant(claimIdPattern.test(claim.id), `${label}.id invalid`);
  nonEmptyString(claim.statement, `${label}.statement`);
}

function selectorPath(step, argument) {
  return step.cwd === '.' ? argument : `${step.cwd}/${argument}`;
}

export function parseManifest(source) {
  const value = parseCanonicalJson(source, 'test suite manifest');
  exactKeys(value, ['protocol', 'schemaVersion', 'coverage', 'suites'], 'test suite manifest');
  invariant(value.protocol === manifestProtocol, 'test suite manifest protocol changed');
  invariant(value.schemaVersion === 1, 'test suite manifest schemaVersion must be 1');
  exactKeys(
    value.coverage,
    ['mode', 'baselineCommit', 'baselineTestInventoryCount', 'unclassifiedPolicy'],
    'coverage',
  );
  invariant(
    JSON.stringify(value.coverage) === JSON.stringify(coveragePolicy),
    'coverage baseline policy changed',
  );
  invariant(value.coverage.mode === 'PILOT_INVENTORY', 'coverage mode changed');
  invariant(shaPattern.test(value.coverage.baselineCommit), 'coverage baselineCommit invalid');
  invariant(
    Number.isSafeInteger(value.coverage.baselineTestInventoryCount) &&
      value.coverage.baselineTestInventoryCount > 0,
    'coverage baselineTestInventoryCount invalid',
  );
  invariant(
    value.coverage.unclassifiedPolicy === 'NO_EVIDENCE_CLAIMS',
    'unclassified tests must make no evidence claims',
  );
  invariant(Array.isArray(value.suites) && value.suites.length > 0, 'suites must not be empty');

  const suiteIds = new Set();
  const selectorOwners = new Map();
  const claimIds = new Set();
  for (const [suiteIndex, suite] of value.suites.entries()) {
    const label = `suites[${suiteIndex}]`;
    exactKeys(
      suite,
      [
        'id',
        'name',
        'layer',
        'implementation',
        'resultSource',
        'acceptance',
        'selectors',
        'runner',
        'defaults',
        'proves',
        'doesNotProve',
      ],
      label,
    );
    invariant(suiteIdPattern.test(suite.id), `${label}.id invalid`);
    invariant(!suiteIds.has(suite.id), `duplicate suite id: ${suite.id}`);
    suiteIds.add(suite.id);
    nonEmptyString(suite.name, `${label}.name`);
    invariant(allowedLayers.has(suite.layer), `${label}.layer invalid`);
    invariant(
      suite.implementation === 'AVAILABLE' || suite.implementation === 'NOT_IMPLEMENTED',
      `${label}.implementation invalid`,
    );
    invariant(allowedSources.has(suite.resultSource), `${label}.resultSource invalid`);

    exactKeys(
      suite.acceptance,
      ['relationship', 'journeyIds', 'acceptanceIds'],
      `${label}.acceptance`,
    );
    invariant(
      ['SUPPORTING', 'NON_ACCEPTANCE', 'GATE'].includes(suite.acceptance.relationship),
      `${label}.acceptance.relationship invalid`,
    );
    sortedUniqueStrings(suite.acceptance.journeyIds, `${label}.acceptance.journeyIds`, {
      allowEmpty: true,
    });
    sortedUniqueStrings(suite.acceptance.acceptanceIds, `${label}.acceptance.acceptanceIds`, {
      allowEmpty: true,
    });

    exactKeys(suite.selectors, ['files'], `${label}.selectors`);
    sortedUniqueStrings(suite.selectors.files, `${label}.selectors.files`, {
      allowEmpty: suite.implementation === 'NOT_IMPLEMENTED',
      paths: true,
    });
    for (const file of suite.selectors.files) {
      invariant(testFilePattern.test(file), `${file} is not a supported JS/TS test file`);
      invariant(!selectorOwners.has(file), `${file} belongs to multiple suites`);
      selectorOwners.set(file, suite.id);
    }

    exactKeys(suite.defaults, ['pr', 'main', 'manual'], `${label}.defaults`);
    invariant(allowedPrMainSchedules.has(suite.defaults.pr), `${label}.defaults.pr invalid`);
    invariant(allowedPrMainSchedules.has(suite.defaults.main), `${label}.defaults.main invalid`);
    invariant(
      allowedManualSchedules.has(suite.defaults.manual),
      `${label}.defaults.manual invalid`,
    );

    invariant(Array.isArray(suite.proves), `${label}.proves must be an array`);
    for (const [claimIndex, claim] of suite.proves.entries()) {
      validateClaim(claim, `${label}.proves[${claimIndex}]`);
      invariant(!claimIds.has(claim.id), `duplicate claim id: ${claim.id}`);
      claimIds.add(claim.id);
    }
    sortedUniqueStrings(suite.doesNotProve, `${label}.doesNotProve`);
    const semanticPolicy = suiteSemanticPolicy[suite.id];
    invariant(semanticPolicy !== undefined, `${suite.id} has no semantic truth policy`);
    invariant(suite.layer === semanticPolicy.layer, `${suite.id} layer policy changed`);
    invariant(
      JSON.stringify(suite.acceptance) === JSON.stringify(semanticPolicy.acceptance),
      `${suite.id} acceptance relationship changed`,
    );
    invariant(
      JSON.stringify(suite.proves) === JSON.stringify(semanticPolicy.proves),
      `${suite.id} proof claim changed`,
    );
    if (suite.implementation === 'NOT_IMPLEMENTED') {
      invariant(suite.runner === null, `${suite.id} NOT_IMPLEMENTED runner must be null`);
      invariant(suite.resultSource === 'NONE', `${suite.id} NOT_IMPLEMENTED source must be NONE`);
      invariant(
        suite.defaults.pr === 'NOT_SCHEDULED' && suite.defaults.main === 'NOT_SCHEDULED',
        `${suite.id} NOT_IMPLEMENTED suite cannot be scheduled`,
      );
      invariant(suite.proves.length === 0, `${suite.id} NOT_IMPLEMENTED cannot claim proof`);
    } else {
      invariant(suite.runner !== null, `${suite.id} AVAILABLE runner is required`);
      invariant(suite.resultSource !== 'NONE', `${suite.id} AVAILABLE source cannot be NONE`);
      invariant(suite.proves.length > 0, `${suite.id} AVAILABLE suite needs a bounded claim`);
      exactKeys(suite.runner, ['kind', 'steps'], `${label}.runner`);
      invariant(suite.runner.kind === 'STEPS', `${label}.runner.kind invalid`);
      invariant(
        Array.isArray(suite.runner.steps) && suite.runner.steps.length > 0,
        `${label}.runner.steps must not be empty`,
      );
      for (const [stepIndex, step] of suite.runner.steps.entries()) {
        const stepLabel = `${label}.runner.steps[${stepIndex}]`;
        exactKeys(step, ['kind', 'cwd', 'argv', 'requiredEnvNames', 'timeoutSeconds'], stepLabel);
        invariant(
          step.kind === 'VITEST' || step.kind === 'NODE_TEST' || step.kind === 'COMMAND',
          `${stepLabel}.kind invalid`,
        );
        safeRepoDirectory(step.cwd, `${stepLabel}.cwd`);
        invariant(Array.isArray(step.argv) && step.argv.length > 0, `${stepLabel}.argv invalid`);
        for (const argument of step.argv) nonEmptyString(argument, `${stepLabel}.argv`);
        sortedUniqueStrings(step.requiredEnvNames, `${stepLabel}.requiredEnvNames`, {
          allowEmpty: true,
        });
        invariant(
          Number.isSafeInteger(step.timeoutSeconds) &&
            step.timeoutSeconds > 0 &&
            step.timeoutSeconds <= 3600,
          `${stepLabel}.timeoutSeconds invalid`,
        );
        if (step.kind === 'VITEST' || step.kind === 'NODE_TEST') {
          for (const argument of step.argv) {
            invariant(
              suite.selectors.files.includes(selectorPath(step, argument)),
              `${suite.id} Vitest argument is not an exact selector: ${argument}`,
            );
          }
        }
      }
      const selectedTestFiles = suite.runner.steps
        .filter((step) => step.kind === 'VITEST' || step.kind === 'NODE_TEST')
        .flatMap((step) => step.argv.map((argument) => selectorPath(step, argument)))
        .sort();
      invariant(selectedTestFiles.length > 0, `${suite.id} has no machine-reported test step`);
      invariant(
        JSON.stringify(selectedTestFiles) === JSON.stringify(suite.selectors.files),
        `${suite.id} runner does not exactly cover its selectors`,
      );
    }

    const prSource = suite.resultSource === 'PR_SOURCE' || suite.resultSource === 'PR_INFRA';
    invariant(
      (suite.defaults.pr === 'RUN_REQUIRED') === prSource,
      `${suite.id} PR schedule and result source disagree`,
    );
    if (suite.layer === 'DESKTOP_UAT') {
      invariant(
        suite.implementation === 'NOT_IMPLEMENTED',
        'Desktop UAT must remain NOT_IMPLEMENTED',
      );
      invariant(suite.resultSource === 'NONE', 'Desktop UAT cannot run in CI');
      invariant(suite.proves.length === 0, 'Desktop UAT cannot claim proof without a Host runner');
    }
    invariant(
      sha256(JSON.stringify(suite)) === suiteExecutionPolicyDigests[suite.id],
      `${suite.id} execution policy changed`,
    );
  }

  invariant(
    suiteIds.size === Object.keys(suiteSemanticPolicy).length,
    'test suite semantic policy inventory changed',
  );
  invariant(
    suiteIds.size === Object.keys(suiteExecutionPolicyDigests).length,
    'test suite execution policy inventory changed',
  );
  invariant(suiteIds.has('TS-DESKTOP-UAT-011'), 'Desktop UAT truth entry is required');
  return value;
}

function gitLines(args, cwd = repoRoot) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
}

export function validateRepositoryManifest(manifest, root = repoRoot) {
  for (const suite of manifest.suites) {
    for (const file of suite.selectors.files) {
      invariant(existsSync(join(root, file)), `manifest selector does not exist: ${file}`);
    }
  }
  const baselineInventory = gitLines(
    ['ls-tree', '-r', '--name-only', manifest.coverage.baselineCommit],
    root,
  ).filter((file) => testFilePattern.test(file));
  invariant(
    baselineInventory.length === manifest.coverage.baselineTestInventoryCount,
    `baseline test inventory changed: expected ${manifest.coverage.baselineTestInventoryCount}, got ${baselineInventory.length}`,
  );
  const currentInventory = gitLines(['ls-files', '-co', '--exclude-standard'], root)
    .filter((file) => testFilePattern.test(file))
    .sort();
  const classified = new Set(manifest.suites.flatMap((suite) => suite.selectors.files));
  const boundary = classifyInventoryBoundary({
    baselineInventory,
    currentInventory,
    classifiedFiles: classified,
  });
  return {
    mode: manifest.coverage.mode,
    totalTestFiles: currentInventory.length,
    classifiedTestFiles:
      currentInventory.length -
      boundary.baselineUnclassifiedFiles.length -
      boundary.newUnclassifiedFiles.length,
    baselineUnclassifiedCount: boundary.baselineUnclassifiedFiles.length,
    newUnclassifiedCount: boundary.newUnclassifiedFiles.length,
    unclassifiedPolicy: manifest.coverage.unclassifiedPolicy,
  };
}

export function classifyInventoryBoundary({
  baselineInventory,
  currentInventory,
  classifiedFiles,
}) {
  const baselineFiles = new Set(baselineInventory);
  const classified =
    classifiedFiles instanceof Set ? classifiedFiles : new Set(classifiedFiles ?? []);
  const unclassified = currentInventory.filter((file) => !classified.has(file));
  return {
    baselineUnclassifiedFiles: unclassified.filter((file) => baselineFiles.has(file)),
    newUnclassifiedFiles: unclassified.filter((file) => !baselineFiles.has(file)),
  };
}

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

function validateCandidate(candidate) {
  exactKeys(candidate, ['mergeSha', 'baseSha', 'headSha'], 'candidate');
  for (const [key, value] of Object.entries(candidate)) {
    invariant(shaPattern.test(value), `candidate.${key} must be a full lowercase SHA`);
  }
}

function verifySyntheticMergeCheckout(candidate) {
  const current = gitLines(['rev-parse', 'HEAD'])[0];
  invariant(current === candidate.mergeSha, 'checked-out commit does not match candidate.mergeSha');
  const parents = gitLines(['rev-list', '--parents', '-n', '1', 'HEAD'])[0].split(' ');
  invariant(parents.length === 3, 'PR truth collection requires a two-parent synthetic merge');
  invariant(
    parents[1] === candidate.baseSha,
    'synthetic merge first parent does not match baseSha',
  );
  invariant(
    parents[2] === candidate.headSha,
    'synthetic merge second parent does not match headSha',
  );
  invariant(
    spawnSync('git', ['diff', '--quiet'], { cwd: repoRoot }).status === 0 &&
      spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: repoRoot }).status === 0,
    'PR truth collection requires a clean checkout',
  );
}

function relativeTestFile(name, step) {
  const absolute = isAbsolute(name) ? resolve(name) : resolve(repoRoot, step.cwd, name);
  const file = relative(repoRoot, absolute).replaceAll('\\', '/');
  safeRepoFile(file, 'Vitest result file');
  return file;
}

export function normalizeVitestReport(raw, { step, exitCode, rawDigest }) {
  invariant(
    raw !== null && typeof raw === 'object' && !Array.isArray(raw),
    'Vitest report invalid',
  );
  invariant(Array.isArray(raw.testResults), 'Vitest report testResults missing');
  const testCases = [];
  const ids = new Set();
  const collectedFiles = [];
  const zeroCaseFiles = [];
  for (const fileResult of raw.testResults) {
    invariant(Array.isArray(fileResult.assertionResults), 'Vitest assertionResults missing');
    const file = relativeTestFile(fileResult.name, step);
    invariant(!collectedFiles.includes(file), `duplicate Vitest result file: ${file}`);
    collectedFiles.push(file);
    if (fileResult.assertionResults.length === 0) zeroCaseFiles.push(file);
    for (const assertion of fileResult.assertionResults) {
      const fullName = assertion.fullName;
      nonEmptyString(fullName, 'Vitest fullName');
      const status = assertion.status;
      invariant(
        ['passed', 'failed', 'pending', 'todo', 'skipped'].includes(status),
        `unsupported Vitest assertion status: ${status}`,
      );
      const id = `vitest:${file}:${fullName}`;
      invariant(!ids.has(id), `duplicate test case id: ${id}`);
      ids.add(id);
      testCases.push({
        id,
        file,
        name: fullName,
        status:
          status === 'passed'
            ? 'PASS'
            : status === 'failed'
              ? 'FAIL'
              : status === 'todo'
                ? 'TODO'
                : 'SKIPPED',
        durationMs:
          typeof assertion.duration === 'number' && assertion.duration >= 0
            ? assertion.duration
            : null,
      });
    }
  }
  const counts = {
    tests: testCases.length,
    passed: testCases.filter((item) => item.status === 'PASS').length,
    failed: testCases.filter((item) => item.status === 'FAIL').length,
    cancelled: 0,
    skipped: testCases.filter((item) => item.status === 'SKIPPED').length,
    todo: testCases.filter((item) => item.status === 'TODO').length,
    commands: 0,
  };
  if (Number.isSafeInteger(raw.numTotalTests)) {
    invariant(
      raw.numTotalTests === counts.tests,
      'Vitest total count disagrees with assertion results',
    );
  }
  const reasonCodes = [];
  if (exitCode !== 0) reasonCodes.push('COMMAND_EXIT_NONZERO');
  if (counts.tests === 0) reasonCodes.push('ZERO_TESTS_EXECUTED');
  if (zeroCaseFiles.length > 0) reasonCodes.push('ZERO_TESTS_IN_SELECTED_FILE');
  if (counts.failed > 0) reasonCodes.push('TEST_FAILURE');
  if (counts.skipped > 0 || counts.todo > 0) reasonCodes.push('UNEXPECTED_SKIP');
  collectedFiles.sort();
  const expectedFiles = step.argv.map((argument) => selectorPath(step, argument)).sort();
  if (JSON.stringify(collectedFiles) !== JSON.stringify(expectedFiles)) {
    reasonCodes.push('COLLECTED_FILE_MISMATCH');
  }
  reasonCodes.sort();
  return {
    status: reasonCodes.length === 0 ? 'PASS' : 'FAIL',
    reasonCodes,
    counts,
    testCases,
    collectedFiles,
    rawReportSha256: rawDigest,
  };
}

function validateNodeSummary(summary, label) {
  invariant(
    summary !== null && typeof summary === 'object' && !Array.isArray(summary),
    `${label} invalid`,
  );
  invariant(
    summary.counts !== null && typeof summary.counts === 'object' && !Array.isArray(summary.counts),
    `${label} counts invalid`,
  );
  for (const name of [
    'tests',
    'passed',
    'failed',
    'cancelled',
    'skipped',
    'todo',
    'topLevel',
    'suites',
  ]) {
    invariant(
      Number.isSafeInteger(summary.counts[name]) && summary.counts[name] >= 0,
      `${label} ${name} count invalid`,
    );
  }
}

export function normalizeNodeTestReport(events, { step, exitCode, rawDigest }) {
  invariant(Array.isArray(events) && events.length > 0, 'Node test event report invalid');
  const globalSummaries = events.filter(
    (event) => event?.type === 'test:summary' && event.data?.file === undefined,
  );
  invariant(globalSummaries.length === 1, 'Node test global summary missing or duplicated');
  const summary = globalSummaries[0].data;
  validateNodeSummary(summary, 'Node test global summary');

  const expectedFiles = step.argv.map((argument) => selectorPath(step, argument)).sort();
  const perFileSummaries = events.filter(
    (event) => event?.type === 'test:summary' && typeof event.data?.file === 'string',
  );
  const summaryFiles = [];
  const perFileTotals = {
    tests: 0,
    passed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  };
  for (const event of perFileSummaries) {
    const file = relativeTestFile(event.data.file, step);
    invariant(!summaryFiles.includes(file), `duplicate Node test file summary: ${file}`);
    validateNodeSummary(event.data, `Node test file summary ${file}`);
    invariant(event.data.counts.tests > 0, `Node test file executed zero cases: ${file}`);
    summaryFiles.push(file);
    for (const name of Object.keys(perFileTotals)) {
      perFileTotals[name] += event.data.counts[name];
    }
  }
  summaryFiles.sort();
  invariant(
    JSON.stringify(summaryFiles) === JSON.stringify(expectedFiles),
    'Node test per-file summary inventory mismatch',
  );
  for (const [name, value] of Object.entries(perFileTotals)) {
    invariant(
      value === summary.counts[name],
      `Node test ${name} file totals disagree with summary`,
    );
  }

  const ids = new Set();
  const testCases = [];
  for (const event of events) {
    if (event?.type !== 'test:pass' && event?.type !== 'test:fail') continue;
    const data = event.data;
    if (data?.details?.type === 'suite') continue;
    invariant(data?.details?.type === 'test', 'Node test completion type invalid');
    const file = relativeTestFile(data.file, step);
    nonEmptyString(data.name, 'Node test name');
    invariant(
      Number.isSafeInteger(data.testNumber) && data.testNumber > 0,
      'Node test number invalid',
    );
    const id = `node:${file}:${data.testNumber}:${data.name}`;
    invariant(!ids.has(id), `duplicate test case id: ${id}`);
    ids.add(id);
    const status =
      event.type === 'test:fail'
        ? 'FAIL'
        : data.todo !== null && data.todo !== undefined && data.todo !== false
          ? 'TODO'
          : data.skip !== null && data.skip !== undefined && data.skip !== false
            ? 'SKIPPED'
            : 'PASS';
    testCases.push({
      id,
      file,
      name: data.name,
      status,
      durationMs:
        typeof data.details.duration_ms === 'number' && data.details.duration_ms >= 0
          ? data.details.duration_ms
          : null,
    });
  }
  const counts = {
    tests: summary.counts.tests,
    passed: summary.counts.passed,
    failed: summary.counts.failed,
    cancelled: summary.counts.cancelled,
    skipped: summary.counts.skipped,
    todo: summary.counts.todo,
    commands: 0,
  };
  invariant(testCases.length === counts.tests, 'Node test case inventory disagrees with summary');
  if (counts.cancelled === 0) {
    invariant(
      testCases.filter((item) => item.status === 'PASS').length === counts.passed,
      'Node test passed events disagree with summary',
    );
    invariant(
      testCases.filter((item) => item.status === 'FAIL').length === counts.failed,
      'Node test failed events disagree with summary',
    );
    invariant(
      testCases.filter((item) => item.status === 'SKIPPED').length === counts.skipped,
      'Node test skipped events disagree with summary',
    );
    invariant(
      testCases.filter((item) => item.status === 'TODO').length === counts.todo,
      'Node test todo events disagree with summary',
    );
  }

  const reasonCodes = [];
  if (exitCode !== 0) reasonCodes.push('COMMAND_EXIT_NONZERO');
  if (counts.tests === 0) reasonCodes.push('ZERO_TESTS_EXECUTED');
  if (counts.failed > 0) reasonCodes.push('TEST_FAILURE');
  if (counts.cancelled > 0) reasonCodes.push('TEST_CANCELLED');
  if (counts.skipped > 0 || counts.todo > 0) reasonCodes.push('UNEXPECTED_SKIP');
  const collectedFiles = [...new Set(testCases.map((item) => item.file))].sort();
  if (JSON.stringify(collectedFiles) !== JSON.stringify(expectedFiles)) {
    reasonCodes.push('COLLECTED_FILE_MISMATCH');
  }
  reasonCodes.sort();
  return {
    status: reasonCodes.length === 0 ? 'PASS' : 'FAIL',
    reasonCodes,
    counts,
    testCases,
    collectedFiles,
    rawReportSha256: rawDigest,
  };
}

function emptyCounts() {
  return {
    tests: 0,
    passed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    commands: 0,
  };
}

function addCounts(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
}

function requiredEnvMissing(step) {
  return step.requiredEnvNames.filter((name) => !process.env[name]);
}

function commandForStep(step) {
  if (step.kind === 'VITEST') {
    return ['pnpm', '--dir', step.cwd, 'exec', 'vitest', 'run', ...step.argv];
  }
  if (step.kind === 'NODE_TEST') return ['node', '--test', ...step.argv];
  return step.argv;
}

function commandDigestForStep(step) {
  return sha256(JSON.stringify({ cwd: step.cwd, argv: commandForStep(step) }));
}

function runStep(suite, step, index, resultsDirectory, candidate) {
  const startedAt = new Date().toISOString();
  const commandDigest = commandDigestForStep(step);
  const missing = requiredEnvMissing(step);
  if (missing.length > 0) {
    return {
      index,
      kind: step.kind,
      commandDigest,
      status: 'BLOCKED',
      reasonCodes: ['MISSING_REQUIRED_ENV'],
      missingRequiredEnvNames: missing,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      counts: emptyCounts(),
      testCases: [],
      collectedFiles: [],
      machineReportRef: null,
      machineReportSha256: null,
    };
  }

  let execution;
  let normalized;
  if (step.kind === 'VITEST') {
    const rawDirectory = join(resultsDirectory, '.raw');
    mkdirSync(rawDirectory, { recursive: true });
    const rawPath = join(rawDirectory, `${suite.id}-${index}.json`);
    const args = [
      '--dir',
      step.cwd,
      'exec',
      'vitest',
      'run',
      ...step.argv,
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${rawPath}`,
    ];
    execution = spawnSync('pnpm', args, {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
      timeout: step.timeoutSeconds * 1000,
    });
    if (!existsSync(rawPath)) {
      normalized = {
        status: 'FAIL',
        reasonCodes: ['MISSING_MACHINE_REPORT'],
        counts: emptyCounts(),
        testCases: [],
        collectedFiles: [],
        rawReportSha256: null,
      };
    } else {
      const rawSource = readFileSync(rawPath, 'utf8');
      try {
        normalized = normalizeVitestReport(JSON.parse(rawSource), {
          step,
          exitCode: execution.status,
          rawDigest: sha256(rawSource),
        });
      } catch (error) {
        normalized = {
          status: 'FAIL',
          reasonCodes: ['MALFORMED_MACHINE_REPORT'],
          counts: emptyCounts(),
          testCases: [],
          collectedFiles: [],
          rawReportSha256: sha256(rawSource),
          normalizationError: error.message,
        };
      }
    }
  } else if (step.kind === 'NODE_TEST') {
    const rawDirectory = join(resultsDirectory, '.raw');
    mkdirSync(rawDirectory, { recursive: true });
    const rawPath = join(rawDirectory, `${suite.id}-${index}.ndjson`);
    execution = spawnSync(
      'node',
      [
        '--test',
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        `--test-reporter=${nodeTruthReporterPath}`,
        `--test-reporter-destination=${rawPath}`,
        ...step.argv,
      ],
      {
        cwd: resolve(repoRoot, step.cwd),
        env: process.env,
        stdio: 'inherit',
        timeout: step.timeoutSeconds * 1000,
      },
    );
    if (!existsSync(rawPath)) {
      normalized = {
        status: 'FAIL',
        reasonCodes: ['MISSING_MACHINE_REPORT'],
        counts: emptyCounts(),
        testCases: [],
        collectedFiles: [],
        rawReportSha256: null,
      };
    } else {
      const rawSource = readFileSync(rawPath, 'utf8');
      try {
        const events = rawSource
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        normalized = normalizeNodeTestReport(events, {
          step,
          exitCode: execution.status,
          rawDigest: sha256(rawSource),
        });
      } catch (error) {
        normalized = {
          status: 'FAIL',
          reasonCodes: ['MALFORMED_MACHINE_REPORT'],
          counts: emptyCounts(),
          testCases: [],
          collectedFiles: [],
          rawReportSha256: sha256(rawSource),
          normalizationError: error.message,
        };
      }
    }
  } else {
    execution = spawnSync(step.argv[0], step.argv.slice(1), {
      cwd: resolve(repoRoot, step.cwd),
      env: process.env,
      stdio: 'inherit',
      timeout: step.timeoutSeconds * 1000,
    });
    normalized = {
      status: execution.status === 0 ? 'PASS' : 'FAIL',
      reasonCodes: execution.status === 0 ? [] : ['COMMAND_EXIT_NONZERO'],
      counts: { ...emptyCounts(), commands: 1 },
      testCases: [],
      collectedFiles: [],
      rawReportSha256: null,
    };
  }
  let machineReportRef = null;
  let machineReportSha256 = null;
  if (step.kind === 'VITEST' || step.kind === 'NODE_TEST') {
    machineReportRef = `${suite.id}-${index}.machine.json`;
    const machineReport = {
      protocol: machineReportProtocol,
      schemaVersion: 1,
      suiteId: suite.id,
      stepIndex: index,
      framework: step.kind,
      candidate,
      commandDigest,
      status: normalized.status,
      reasonCodes: normalized.reasonCodes,
      counts: normalized.counts,
      testCases: normalized.testCases,
      collectedFiles: normalized.collectedFiles,
    };
    const machineReportSource = canonicalJson(machineReport);
    machineReportSha256 = sha256(machineReportSource);
    writeFileSync(join(resultsDirectory, machineReportRef), machineReportSource, { mode: 0o600 });
  }
  return {
    index,
    kind: step.kind,
    commandDigest,
    status: normalized.status,
    reasonCodes: normalized.reasonCodes,
    missingRequiredEnvNames: [],
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: execution.status,
    signal: execution.signal ?? null,
    counts: normalized.counts,
    testCases: normalized.testCases,
    collectedFiles: normalized.collectedFiles,
    machineReportRef,
    machineReportSha256,
    ...(normalized.normalizationError ? { normalizationError: normalized.normalizationError } : {}),
  };
}

function runSuite({ suite, target, candidate, manifestSha256, resultsDirectory }) {
  const startedAt = new Date().toISOString();
  const steps = suite.runner.steps.map((step, index) =>
    runStep(suite, step, index, resultsDirectory, candidate),
  );
  const counts = emptyCounts();
  for (const step of steps) addCounts(counts, step.counts);
  const reasonCodes = [...new Set(steps.flatMap((step) => step.reasonCodes))].sort();
  const status = steps.some((step) => step.status === 'FAIL')
    ? 'FAIL'
    : steps.some((step) => step.status === 'BLOCKED')
      ? 'BLOCKED'
      : 'PASS';
  const result = {
    protocol: resultProtocol,
    schemaVersion: 1,
    suiteId: suite.id,
    layer: suite.layer,
    target,
    source: suite.resultSource,
    candidate,
    manifestSha256,
    status,
    reasonCodes,
    startedAt,
    finishedAt: new Date().toISOString(),
    counts,
    steps,
    provenClaimIds: status === 'PASS' ? suite.proves.map((claim) => claim.id) : [],
  };
  const resultPath = join(resultsDirectory, `${suite.id}.result.json`);
  writeJson(resultPath, result);
  return result;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalJson(value), { mode: 0o600 });
}

export {
  acceptanceFixedArrays,
  acceptanceGateDefinitions,
  addCounts,
  allowedStatuses,
  commandDigestForStep,
  emptyCounts,
  exactKeys,
  invariant,
  machineReportProtocol,
  nonEmptyString,
  parseCanonicalJson,
  reportProtocol,
  resultProtocol,
  runSuite,
  selectorPath,
  sha256,
  shaPattern,
  validateCandidate,
  verifySyntheticMergeCheckout,
  writeJson,
};
