import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { VNEXT_G0_SUITE } from './run-vnext-g0.mjs';

const script = new URL('./vnext-t0-evidence.mjs', import.meta.url);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const testedSha = 'a'.repeat(40);

function evidenceEnvironment(overrides = {}) {
  return {
    ...process.env,
    VNEXT_T0_SOURCE_SHA: testedSha,
    VNEXT_T0_TREE_SHA: 'b'.repeat(40),
    VNEXT_T0_CLEAN: 'true',
    VNEXT_T0_DISPOSITION: 'FORMAL',
    VNEXT_T0_REPOSITORY: 'dangdang-tech/Combo',
    VNEXT_T0_CALLER_WORKFLOW_NAME: 'Release build',
    VNEXT_T0_CALLER_WORKFLOW_PATH: '.github/workflows/ci.yml',
    VNEXT_T0_TOP_LEVEL_WORKFLOW_NAME: 'Release build',
    VNEXT_T0_TOP_LEVEL_WORKFLOW_REF: 'dangdang-tech/Combo/.github/workflows/ci.yml@refs/heads/main',
    VNEXT_T0_TOP_LEVEL_WORKFLOW_SHA: testedSha,
    VNEXT_T0_JOB_CONTEXT_JSON: JSON.stringify({
      status: 'success',
      workflow_ref: 'dangdang-tech/Combo/.github/workflows/vnext-t0.yml@refs/heads/main',
      workflow_sha: testedSha,
      workflow_repository: 'dangdang-tech/Combo',
      workflow_file_path: '.github/workflows/vnext-t0.yml',
    }),
    VNEXT_T0_EVENT_NAME: 'push',
    VNEXT_T0_GIT_REF: 'refs/heads/main',
    VNEXT_T0_REF_PROTECTED: 'true',
    VNEXT_T0_RUN_ID: '123456789',
    VNEXT_T0_RUN_ATTEMPT: '1',
    VNEXT_T0_JOB: 'g0',
    VNEXT_T0_BASE_SHA: '',
    VNEXT_T0_HEAD_SHA: '',
    VNEXT_T0_MERGE_SHA: '',
    VNEXT_T0_RUNNER_OS: 'Linux',
    VNEXT_T0_RUNNER_ARCH: 'X64',
    VNEXT_T0_RUNNER_IMAGE_OS: 'ubuntu24',
    VNEXT_T0_RUNNER_IMAGE_VERSION: '20260810.1',
    VNEXT_T0_NODE_VERSION: 'v24.7.0',
    VNEXT_T0_PNPM_VERSION: '11.0.9',
    VNEXT_T0_STARTED_AT: '2026-08-18T00:00:00.000Z',
    VNEXT_T0_FINISHED_AT: '2026-08-18T00:01:00.000Z',
    VNEXT_T0_COMMAND_EXECUTED: 'true',
    VNEXT_T0_COMMAND_EXIT_CODE: '0',
    ...overrides,
  };
}

function directoryWithJunit(t) {
  const directory = mkdtempSync(join(tmpdir(), 'combo-vnext-t0-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'junit'));
  VNEXT_G0_SUITE.groups.forEach((group) => {
    const tests = group.expectedJUnitFiles.length;
    const suites = group.expectedJUnitFiles
      .map(
        (file, index) =>
          `<testsuite name="${file}" tests="1" failures="0" errors="0" skipped="0"><testcase name="case-${index}" classname="${file}" time="0.001"></testcase></testsuite>`,
      )
      .join('');
    const nodeTestcases = group.expectedJUnitFiles
      .map(
        (file, index) =>
          `<testcase name="case-${index}" classname="t0-contracts" time="0.001" file="${join(repositoryRoot, file)}"></testcase>`,
      )
      .join('');
    const xml =
      group.id === 't0-contracts'
        ? `<?xml version="1.0" encoding="UTF-8"?><testsuites>${nodeTestcases}<!-- tests ${tests} --><!-- suites 0 --><!-- pass ${tests} --><!-- fail 0 --><!-- cancelled 0 --><!-- skipped 0 --><!-- todo 0 --><!-- duration_ms 1.0 --></testsuites>`
        : `<?xml version="1.0" encoding="UTF-8"?><testsuites name="${group.id}" tests="${tests}" failures="0" errors="0" skipped="0">${suites}</testsuites>`;
    writeFileSync(join(directory, group.junitPath), xml);
  });
  return directory;
}

function invoke(subcommand, directory, env, extra = []) {
  return spawnSync(
    process.execPath,
    [script.pathname, subcommand, '--directory', directory, ...extra],
    { cwd: new URL('../', import.meta.url), env, encoding: 'utf8' },
  );
}

test('creates and verifies canonical FORMAL PASS evidence with five digest-bound JUnit files', (t) => {
  const directory = directoryWithJunit(t);
  const created = invoke('create', directory, evidenceEnvironment());
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /^sha256:[a-f0-9]{64}\n$/u);

  const verified = invoke('verify', directory, evidenceEnvironment(), ['--source-sha', testedSha]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stdout, created.stdout);

  const raw = readFileSync(join(directory, 't0-evidence.json'), 'utf8');
  const evidence = JSON.parse(raw);
  assert.equal(evidence.protocol, 'combo.vnext-t0-g0-evidence/1');
  assert.equal(evidence.disposition, 'FORMAL');
  assert.equal(evidence.conclusion, 'PASS');
  assert.deepEqual(
    evidence.cases,
    Array.from({ length: 10 }, (_, index) => `SCH-${String(index + 1).padStart(3, '0')}`),
  );
  assert.equal(evidence.results.junit.length, VNEXT_G0_SUITE.groups.length);
  assert.equal(evidence.results.totals.tests, 47);
  assert.equal(evidence.results.totals.failures, 0);
  assert.equal(evidence.rawLogsIncluded, false);
  assert.equal(raw.endsWith('\n'), false);
});

test('rejects tampered JUnit bytes and a mismatched tested SHA', (t) => {
  const directory = directoryWithJunit(t);
  assert.equal(invoke('create', directory, evidenceEnvironment()).status, 0);
  const first = VNEXT_G0_SUITE.groups[0];
  writeFileSync(join(directory, first.junitPath), '<testsuites tests="1" failures="0"/>');
  const tampered = invoke('verify', directory, evidenceEnvironment(), ['--source-sha', testedSha]);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /JUnit creator-agent-protocol digest/u);

  const mismatch = invoke('verify', directory, evidenceEnvironment(), [
    '--source-sha',
    'c'.repeat(40),
  ]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /tested source SHA mismatch/u);
});

test('never upgrades pull request evidence to FORMAL', (t) => {
  const directory = directoryWithJunit(t);
  const result = invoke(
    'create',
    directory,
    evidenceEnvironment({
      VNEXT_T0_EVENT_NAME: 'pull_request',
      VNEXT_T0_GIT_REF: 'refs/pull/42/merge',
      VNEXT_T0_BASE_SHA: 'c'.repeat(40),
      VNEXT_T0_HEAD_SHA: 'd'.repeat(40),
      VNEXT_T0_MERGE_SHA: testedSha,
    }),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pull_request evidence cannot be FORMAL/u);
});

test('creates an ADVISORY_ONLY pull request tuple without confusing merge and head SHAs', (t) => {
  const directory = directoryWithJunit(t);
  const environment = evidenceEnvironment({
    VNEXT_T0_DISPOSITION: 'ADVISORY_ONLY',
    VNEXT_T0_CALLER_WORKFLOW_NAME: 'PR checks',
    VNEXT_T0_CALLER_WORKFLOW_PATH: '.github/workflows/pr-ci.yml',
    VNEXT_T0_TOP_LEVEL_WORKFLOW_NAME: 'PR checks',
    VNEXT_T0_TOP_LEVEL_WORKFLOW_REF:
      'dangdang-tech/Combo/.github/workflows/pr-ci.yml@refs/pull/42/merge',
    VNEXT_T0_TOP_LEVEL_WORKFLOW_SHA: 'd'.repeat(40),
    VNEXT_T0_JOB_CONTEXT_JSON: JSON.stringify({
      status: 'success',
      workflow_ref: 'dangdang-tech/Combo/.github/workflows/vnext-t0.yml@refs/pull/42/merge',
      workflow_sha: testedSha,
      workflow_repository: 'dangdang-tech/Combo',
      workflow_file_path: '.github/workflows/vnext-t0.yml',
    }),
    VNEXT_T0_EVENT_NAME: 'pull_request',
    VNEXT_T0_GIT_REF: 'refs/pull/42/merge',
    VNEXT_T0_REF_PROTECTED: 'false',
    VNEXT_T0_BASE_SHA: 'c'.repeat(40),
    VNEXT_T0_HEAD_SHA: 'd'.repeat(40),
    VNEXT_T0_MERGE_SHA: testedSha,
  });
  const created = invoke('create', directory, environment);
  assert.equal(created.status, 0, created.stderr);
  const verified = invoke('verify', directory, environment, ['--source-sha', testedSha]);
  assert.equal(verified.status, 0, verified.stderr);
  const evidence = JSON.parse(readFileSync(join(directory, 't0-evidence.json'), 'utf8'));
  assert.equal(evidence.disposition, 'ADVISORY_ONLY');
  assert.equal(evidence.source.testedSha, testedSha);
  assert.equal(evidence.source.mergeSha, testedSha);
  assert.equal(evidence.source.headSha, 'd'.repeat(40));
  assert.notEqual(evidence.source.testedSha, evidence.source.headSha);
});

test('PASS requires every JUnit file while FAIL preserves an explicit NOT_PRODUCED record', (t) => {
  const passDirectory = directoryWithJunit(t);
  unlinkSync(join(passDirectory, VNEXT_G0_SUITE.groups.at(-1).junitPath));
  const invalidPass = invoke('create', passDirectory, evidenceEnvironment());
  assert.notEqual(invalidPass.status, 0);
  assert.match(invalidPass.stderr, /PASS requires all five non-empty JUnit artifacts/u);

  const failDirectory = mkdtempSync(join(tmpdir(), 'combo-vnext-t0-failure-'));
  t.after(() => rmSync(failDirectory, { recursive: true, force: true }));
  mkdirSync(join(failDirectory, 'junit'));
  const failed = invoke(
    'create',
    failDirectory,
    evidenceEnvironment({ VNEXT_T0_COMMAND_EXIT_CODE: '1' }),
  );
  assert.equal(failed.status, 0, failed.stderr);
  const verified = invoke('verify', failDirectory, evidenceEnvironment(), [
    '--source-sha',
    testedSha,
  ]);
  assert.equal(verified.status, 0, verified.stderr);
  const evidence = JSON.parse(readFileSync(join(failDirectory, 't0-evidence.json'), 'utf8'));
  assert.equal(evidence.conclusion, 'FAIL');
  assert.ok(evidence.results.junit.every(({ status }) => status === 'NOT_PRODUCED'));
});

test('rejects unknown evidence files instead of uploading an ambiguous bundle', (t) => {
  const directory = directoryWithJunit(t);
  assert.equal(invoke('create', directory, evidenceEnvironment()).status, 0);
  writeFileSync(join(directory, 'unexpected.txt'), 'not allowed');
  const result = invoke('verify', directory, evidenceEnvironment(), ['--source-sha', testedSha]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected evidence files/u);
});

test('rejects skipped, empty, malformed, incomplete, and internally inconsistent JUnit PASS inputs', (t) => {
  const variants = [
    {
      mutate(xml) {
        return xml
          .replace('skipped="0"', 'skipped="1"')
          .replace('skipped="0"', 'skipped="1"')
          .replace('</testcase>', '<skipped></skipped></testcase>');
      },
      error: /zero failures\/errors\/skips/u,
    },
    {
      mutate(xml) {
        return xml
          .replace(/tests="[0-9]+"/gu, 'tests="0"')
          .replace(/<testcase\b[^>]*><\/testcase>/gu, '');
      },
      error: /empty expected suite/u,
    },
    {
      mutate() {
        return '<testsuites><testcase></testsuites>';
      },
      error: /malformed XML/u,
    },
    {
      mutate(xml) {
        return xml.replace(' failures="0"', '');
      },
      error: /failures must occur exactly once/u,
    },
    {
      mutate(xml) {
        return xml.replace(/tests="[0-9]+"/u, 'tests="999"');
      },
      error: /aggregate\/child totals/u,
    },
    {
      mutate(xml) {
        return xml
          .replaceAll('tests="2"', 'tests="3"')
          .replace('</testsuite>', '<!-- <testcase name="spoof"></testcase> --></testsuite>');
      },
      error: /forbidden XML construct/u,
    },
    {
      mutate(xml) {
        return xml
          .replaceAll('tests="2"', 'tests="3"')
          .replace('</testsuite>', '<![CDATA[<testcase name="spoof"></testcase>]]></testsuite>');
      },
      error: /forbidden XML construct/u,
    },
    {
      mutate(xml) {
        return xml
          .replace('<testsuites ', '<wrapper><testsuites ')
          .replace('</testsuites>', '</testsuites></wrapper>');
      },
      error: /JUnit document shape/u,
    },
    {
      mutate() {
        return '<?xml version="1.0"?><testsuites tests="1" failures="0" errors="0"><testsuite tests="1" failures="0" errors="0" skipped="0"><testcase/></testsuite></testsuites>';
      },
      error: /JUnit testcase shape/u,
    },
    {
      mutate(xml) {
        return xml
          .replace('tests="36"', 'tests="35"')
          .replace('tests="1"', 'tests="0"')
          .replace(/<testcase\b[^>]*><\/testcase>/u, '');
      },
      error: /empty expected suite/u,
    },
    {
      mutate() {
        return '<?xml version="1.0"?><testsuites tests="1" failures="0" errors="0"><testsuite tests="1" failures="0" errors="0" skipped="0"><testcase>primitive</testcase></testsuite></testsuites>';
      },
      error: /JUnit testcase shape/u,
    },
  ];

  for (const variant of variants) {
    const directory = directoryWithJunit(t);
    const first = VNEXT_G0_SUITE.groups[0];
    const junitPath = join(directory, first.junitPath);
    writeFileSync(junitPath, variant.mutate(readFileSync(junitPath, 'utf8')));
    const result = invoke('create', directory, evidenceEnvironment());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, variant.error);
  }
});

test('rejects unknown evidence keys and symlink entries during verification', (t) => {
  const unknownDirectory = directoryWithJunit(t);
  assert.equal(invoke('create', unknownDirectory, evidenceEnvironment()).status, 0);
  const evidencePath = join(unknownDirectory, 't0-evidence.json');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  writeFileSync(evidencePath, JSON.stringify({ ...evidence, unexpected: true }));
  const unknown = invoke('verify', unknownDirectory, evidenceEnvironment(), [
    '--source-sha',
    testedSha,
  ]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /evidence keys/u);

  const symlinkDirectory = directoryWithJunit(t);
  assert.equal(invoke('create', symlinkDirectory, evidenceEnvironment()).status, 0);
  symlinkSync('t0-evidence.json', join(symlinkDirectory, 'unexpected-link'));
  const symlinked = invoke('verify', symlinkDirectory, evidenceEnvironment(), [
    '--source-sha',
    testedSha,
  ]);
  assert.notEqual(symlinked.status, 0);
  assert.match(symlinked.stderr, /contains a symlink/u);
});

test('source-integrity failure and an unexecuted command produce BLOCKED without a fake exit code', (t) => {
  const dirtyDirectory = directoryWithJunit(t);
  const dirty = invoke('create', dirtyDirectory, evidenceEnvironment({ VNEXT_T0_CLEAN: 'false' }));
  assert.equal(dirty.status, 0, dirty.stderr);
  const dirtyEvidence = JSON.parse(readFileSync(join(dirtyDirectory, 't0-evidence.json'), 'utf8'));
  assert.equal(dirtyEvidence.conclusion, 'BLOCKED');
  assert.equal(dirtyEvidence.source.clean, false);
  assert.equal(dirtyEvidence.command.executed, true);
  assert.equal(dirtyEvidence.command.exitCode, 0);
  assert.ok(dirtyEvidence.results.junit.every(({ status }) => status === 'NOT_PRODUCED'));

  const notRunDirectory = directoryWithJunit(t);
  const notRun = invoke(
    'create',
    notRunDirectory,
    evidenceEnvironment({
      VNEXT_T0_COMMAND_EXECUTED: 'false',
      VNEXT_T0_COMMAND_EXIT_CODE: '',
    }),
  );
  assert.equal(notRun.status, 0, notRun.stderr);
  const notRunEvidence = JSON.parse(
    readFileSync(join(notRunDirectory, 't0-evidence.json'), 'utf8'),
  );
  assert.equal(notRunEvidence.conclusion, 'BLOCKED');
  assert.equal(notRunEvidence.command.executed, false);
  assert.equal(notRunEvidence.command.exitCode, null);
  assert.ok(notRunEvidence.results.junit.every(({ status }) => status === 'NOT_PRODUCED'));
});

test('FORMAL evidence requires both a protected main ref and the actual reusable job identity', (t) => {
  const unprotectedDirectory = directoryWithJunit(t);
  const unprotected = invoke(
    'create',
    unprotectedDirectory,
    evidenceEnvironment({ VNEXT_T0_REF_PROTECTED: 'false' }),
  );
  assert.notEqual(unprotected.status, 0);
  assert.match(unprotected.stderr, /protected main push workflow/u);

  const wrongJobDirectory = directoryWithJunit(t);
  const wrongJobContext = JSON.parse(evidenceEnvironment().VNEXT_T0_JOB_CONTEXT_JSON);
  const wrongJob = invoke(
    'create',
    wrongJobDirectory,
    evidenceEnvironment({
      VNEXT_T0_JOB_CONTEXT_JSON: JSON.stringify({
        ...wrongJobContext,
        workflow_file_path: '.github/workflows/ci.yml',
      }),
    }),
  );
  assert.notEqual(wrongJob.status, 0);
  assert.match(wrongJob.stderr, /called job workflow authority/u);
});

test('accepts only the fixed Node summary comments and rejects covert/empty testcase nodes', (t) => {
  const commentDirectory = directoryWithJunit(t);
  const contractGroup = VNEXT_G0_SUITE.groups.find(({ id }) => id === 't0-contracts');
  const commentPath = join(commentDirectory, contractGroup.junitPath);
  writeFileSync(
    commentPath,
    readFileSync(commentPath, 'utf8').replace(
      '</testsuites>',
      '<!-- <testcase name="spoof"></testcase> --></testsuites>',
    ),
  );
  const comment = invoke('create', commentDirectory, evidenceEnvironment());
  assert.notEqual(comment.status, 0);
  assert.match(comment.stderr, /summary comments/u);

  const cdataDirectory = directoryWithJunit(t);
  const cdataPath = join(cdataDirectory, contractGroup.junitPath);
  writeFileSync(
    cdataPath,
    readFileSync(cdataPath, 'utf8').replace(
      '</testsuites>',
      '<![CDATA[<testcase name="spoof"></testcase>]]></testsuites>',
    ),
  );
  const cdata = invoke('create', cdataDirectory, evidenceEnvironment());
  assert.notEqual(cdata.status, 0);
  assert.match(cdata.stderr, /forbidden XML construct/u);

  for (const testcase of ['<testcase/>', '<testcase>primitive</testcase>']) {
    const invalidDirectory = directoryWithJunit(t);
    writeFileSync(
      join(invalidDirectory, contractGroup.junitPath),
      `<?xml version="1.0"?><testsuites>${testcase}<!-- tests 1 --><!-- suites 0 --><!-- pass 1 --><!-- fail 0 --><!-- cancelled 0 --><!-- skipped 0 --><!-- todo 0 --><!-- duration_ms 1.0 --></testsuites>`,
    );
    const invalid = invoke('create', invalidDirectory, evidenceEnvironment());
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /t0-contracts JUnit testcase shape/u);
  }
});
