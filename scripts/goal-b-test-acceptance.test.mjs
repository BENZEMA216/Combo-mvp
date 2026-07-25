import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';
import {
  GOAL_B_ACCEPTANCE_CHECKS,
  GOAL_B_UPLOAD_PARTS,
  buildAcceptanceEvidence,
  consumeUiSnapshot,
  isAllowedAcceptanceRequest,
  isAllowedAcceptanceWebSocket,
  isExpectedTestReleaseMetadata,
  parseAcceptanceArgs,
  serializeAcceptanceEvidence,
  writeAcceptanceEvidence,
} from './goal-b-test-acceptance.mjs';

const REVISION = 'a'.repeat(40);
const ORIGIN = 'http://127.0.0.1:18080';
const RELEASE = {
  schemaVersion: 1,
  environment: 'test',
  sourceSha: REVISION,
  releaseId: `release-${REVISION}`,
  builtAt: '2026-07-25T00:00:00.000Z',
  releaseManifestDigest: `sha256:${'c'.repeat(64)}`,
  webAssetManifest: `sha256:${'b'.repeat(64)}`,
};
const UUIDS = {
  taskId: '01982e62-6d6e-7f4d-8fe8-b55f62720b5b',
  capabilityId: '11982e62-6d6e-7f4d-8fe8-b55f62720b5b',
  studioSessionId: '21982e62-6d6e-7f4d-8fe8-b55f62720b5b',
  consumeSessionId: '31982e62-6d6e-7f4d-8fe8-b55f62720b5b',
};

test('accepts only the exact SHA, loopback origin, and fresh output arguments', () => {
  const output = join(mkdtempSync(join(tmpdir(), 'goal-b-browser-args-')), 'result.json');
  assert.deepEqual(
    parseAcceptanceArgs(['--revision', REVISION, '--web-origin', ORIGIN, '--output', output]),
    { revision: REVISION, webOrigin: ORIGIN, output },
  );

  const rejected = [
    [],
    ['--revision', REVISION, '--web-origin', ORIGIN],
    ['--revision', REVISION, '--web-origin', ORIGIN, '--cookie', 'cb_session=private'],
    ['--revision', REVISION.toUpperCase(), '--web-origin', ORIGIN, '--output', output],
    ['--revision', REVISION, '--web-origin', 'http://localhost:4173', '--output', output],
    ['--revision', REVISION, '--web-origin', 'https://127.0.0.1:4173', '--output', output],
    ['--revision', REVISION, '--web-origin', 'http://127.0.0.1:4173', '--output', output],
    ['--revision', REVISION, '--web-origin', `${ORIGIN}/path`, '--output', output],
    ['--revision', REVISION, '--revision', REVISION, '--output', output],
  ];
  for (const argv of rejected) assert.throws(() => parseAcceptanceArgs(argv));
});

test('acceptance browser allows only WebSockets on the exact loopback forward', () => {
  assert.equal(isAllowedAcceptanceWebSocket('ws://127.0.0.1:18080/events', ORIGIN), true);
  for (const value of [
    'wss://127.0.0.1:18080/events',
    'ws://localhost:18080/events',
    'ws://127.0.0.1:18081/events',
    'ws://example.com/events',
    'ws://user:pass@127.0.0.1:18080/events',
    'not-a-url',
  ]) {
    assert.equal(isAllowedAcceptanceWebSocket(value, ORIGIN), false, value);
  }
});

test('browser network gate only permits the exact loopback HTTP origin and non-network URLs', () => {
  for (const value of [
    `${ORIGIN}/tasks`,
    `${ORIGIN}/try/assets/app.js`,
    'about:blank',
    'blob:http://127.0.0.1:18080/01982e62-6d6e-7f4d-8fe8-b55f62720b5b',
    'data:text/plain,local',
  ]) {
    assert.equal(isAllowedAcceptanceRequest(value, ORIGIN), true, value);
  }
  for (const value of [
    'http://127.0.0.1:18081/tasks',
    'http://localhost:18080/tasks',
    'https://127.0.0.1:18080/tasks',
    'http://169.254.169.254/latest/meta-data',
    'https://example.com/',
    'file:///etc/passwd',
    'not-a-url',
  ]) {
    assert.equal(isAllowedAcceptanceRequest(value, ORIGIN), false, value);
  }
});

test('Test origin, Nginx allowlist, and page interception preserve one loopback boundary', () => {
  const nginx = readFileSync(
    new URL('../infra/k8s/overlays/combo-dev/apps/nginx-dev.conf', import.meta.url),
    'utf8',
  );
  const source = readFileSync(new URL('./goal-b-test-acceptance.mjs', import.meta.url), 'utf8');

  assert.match(nginx, /"http:\/\/127\.0\.0\.1:18080" 1;/);
  assert.match(source, /const messageUrl = `\$\{options\.webOrigin\}\$\{messagePath\}`/);
  assert.match(source, /page\.route\(messageUrl/);
  assert.match(source, /route\.fallback\(\)/);
  assert.doesNotMatch(source, /page\.route\(\s*`\*\*\$\{messagePath\}`/);
});

test('successful upload fixtures are independently sniffable Claude JSONL sessions', () => {
  assert.equal(GOAL_B_UPLOAD_PARTS.length, 2);
  for (const part of GOAL_B_UPLOAD_PARTS) {
    const records = part.split('\n').map((line) => JSON.parse(line));
    assert.ok(records.length >= 2);
    assert.ok(
      records.every(
        (record) =>
          record &&
          typeof record.message === 'object' &&
          ['user', 'assistant'].includes(record.message.role) &&
          Array.isArray(record.message.content) &&
          record.message.content.some(
            (block) => block?.type === 'text' && typeof block.text === 'string' && block.text,
          ),
      ),
    );
    assert.ok(records.some((record) => record.message.role === 'user'));
    assert.ok(records.some((record) => record.message.role === 'assistant'));
  }
});

test('release identity requires the exact deployed Test schema and revision', () => {
  assert.equal(isExpectedTestReleaseMetadata(RELEASE, REVISION), true);
  for (const invalid of [
    { ...RELEASE, environment: 'development' },
    { ...RELEASE, sourceSha: 'd'.repeat(40) },
    { ...RELEASE, releaseManifestDigest: 'sha256:missing' },
    { ...RELEASE, releaseManifestDigest: `sha256:${'0'.repeat(64)}` },
    { ...RELEASE, webAssetManifest: `sha256:${'0'.repeat(64)}` },
    { ...RELEASE, builtAt: '2026-07-25' },
    { ...RELEASE, unexpected: true },
  ]) {
    assert.equal(isExpectedTestReleaseMetadata(invalid, REVISION), false);
  }
  const zeroRevision = '0'.repeat(40);
  assert.equal(
    isExpectedTestReleaseMetadata(
      {
        ...RELEASE,
        sourceSha: zeroRevision,
        releaseId: `release-${zeroRevision}`,
      },
      zeroRevision,
    ),
    false,
  );
});

test('evidence allowlist drops cookies, pairing codes, tokens, and arbitrary response data', () => {
  const evidence = buildAcceptanceEvidence({
    revision: REVISION,
    webOrigin: ORIGIN,
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:01:00.000Z',
    checks: GOAL_B_ACCEPTANCE_CHECKS.map((id) => ({
      id,
      status: 'passed',
      durationMs: 1,
      responseBody: 'private',
    })),
    resources: {
      ...UUIDS,
      pairingCode: 'PAIR-PRIVATE',
      cookie: 'cb_session=private',
      shareToken: 'private-share-token',
    },
    metrics: {
      uploadParts: 2,
      completedStudioRevisions: 2,
      authorization: 'Bearer private',
    },
    release: RELEASE,
    secret: 'private',
  });
  const serialized = serializeAcceptanceEvidence(evidence);
  assert.equal(evidence.status, 'passed');
  assert.deepEqual(evidence.resources, UUIDS);
  assert.deepEqual(evidence.metrics, { uploadParts: 2, completedStudioRevisions: 2 });
  assert.doesNotMatch(
    serialized,
    /PAIR-PRIVATE|cb_session|private-share-token|Bearer private|"secret"|"responseBody"/,
  );
  assert.throws(
    () => serializeAcceptanceEvidence({ ...evidence, cookie: 'cb_session=private' }),
    /unsafe evidence key/,
  );
  assert.throws(
    () => serializeAcceptanceEvidence({ ...evidence, diagnostic: 'Bearer private' }),
    /unsafe evidence value/,
  );
});

test('passed evidence requires release identity, all resource ids, and real flow metrics', () => {
  const base = {
    revision: REVISION,
    webOrigin: ORIGIN,
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:01:00.000Z',
    checks: GOAL_B_ACCEPTANCE_CHECKS.map((id) => ({ id, status: 'passed', durationMs: 1 })),
    resources: UUIDS,
    metrics: { uploadParts: 2, completedStudioRevisions: 2 },
    release: RELEASE,
  };
  assert.equal(buildAcceptanceEvidence(base).status, 'passed');
  assert.equal(buildAcceptanceEvidence({ ...base, release: undefined }).status, 'failed');
  assert.equal(
    buildAcceptanceEvidence({
      ...base,
      release: { ...RELEASE, webAssetManifest: 'sha256:invalid' },
    }).status,
    'failed',
  );
  assert.equal(
    buildAcceptanceEvidence({
      ...base,
      resources: { ...UUIDS, consumeSessionId: undefined },
    }).status,
    'failed',
  );
  assert.equal(
    buildAcceptanceEvidence({
      ...base,
      metrics: { uploadParts: 1, completedStudioRevisions: 2 },
    }).status,
    'failed',
  );
});

test('consume current UI must point at the isolated snapshot, not null or the Studio id', () => {
  const sourceArtifactId = '41982e62-6d6e-7f4d-8fe8-b55f62720b5b';
  const snapshotId = '51982e62-6d6e-7f4d-8fe8-b55f62720b5b';
  const snapshot = {
    id: snapshotId,
    kind: 'html',
    sourceArtifactId,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
  assert.deepEqual(
    consumeUiSnapshot({ artifacts: [snapshot], currentUiArtifactId: snapshotId }, sourceArtifactId),
    snapshot,
  );
  assert.equal(
    consumeUiSnapshot({ artifacts: [snapshot], currentUiArtifactId: null }, sourceArtifactId),
    undefined,
  );
  assert.equal(
    consumeUiSnapshot(
      { artifacts: [snapshot], currentUiArtifactId: sourceArtifactId },
      sourceArtifactId,
    ),
    undefined,
  );
});

test('secure writer creates a new 0600 evidence file and refuses overwrite', () => {
  const output = join(
    mkdtempSync(join(tmpdir(), 'goal-b-browser-output-')),
    'nested',
    'result.json',
  );
  const evidence = buildAcceptanceEvidence({
    revision: REVISION,
    webOrigin: ORIGIN,
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:01:00.000Z',
    checks: [],
    resources: {},
    metrics: {},
  });
  writeAcceptanceEvidence(output, evidence);
  assert.equal(lstatSync(output).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), evidence);
  assert.throws(() => writeAcceptanceEvidence(output, evidence), /already exists/);
});

test('flow contract covers Creation, Authoring, Runtime, Studio, and both return paths', () => {
  assert.deepEqual(GOAL_B_ACCEPTANCE_CHECKS, [
    'release_identity',
    'hashed_asset_404',
    'dev_login',
    'creation_idempotency',
    'authoring_prepare',
    'authoring_resume_after_reload',
    'authoring_upload_terminal',
    'creation_publish_and_retry_fence',
    'studio_entry',
    'studio_failed_send_retains_draft',
    'studio_single_accept_and_clear',
    'studio_active_turn_reload',
    'studio_first_revision',
    'studio_element_selection',
    'studio_second_revision',
    'studio_interrupted_artifact_excluded',
    'runtime_current_ui_consume',
    'studio_trial_return',
    'task_trial_return',
    'logout_clears_session',
  ]);

  const source = readFileSync(new URL('./goal-b-test-acceptance.mjs', import.meta.url), 'utf8');
  for (const check of GOAL_B_ACCEPTANCE_CHECKS) {
    assert.ok(source.includes(`checked('${check}'`), `missing live check ${check}`);
  }
  for (const endpoint of [
    '/api/v1/connect/prepare',
    '/api/v1/connect/upload',
    '/api/v1/runtime/studio/sessions',
    '/api/v1/runtime/sessions',
    '/interrupt',
    '/publish',
  ]) {
    assert.ok(source.includes(endpoint), `missing live contract endpoint ${endpoint}`);
  }
  assert.match(source, /executablePath: CHROME_EXECUTABLE/);
  assert.match(source, /route\.abort\('blockedbyclient'\)/);
  assert.match(source, /context\.routeWebSocket\('\*\*\/\*'/);
  assert.match(source, /socket\.close\(\{ code: 1008/);
  assert.match(source, /failedTask\.id.*\/retry/s);
  assert.match(source, /artifactForTurn\(activeCandidate, interruptedTurnId\)/);
  assert.match(source, /pairingCode = replay\.data\?\.pairingCode/);
});
