import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';
import {
  AcceptanceFailure,
  GOAL_B_ACCEPTANCE_CHECKS,
  GOAL_B_UPLOAD_PARTS,
  buildAcceptanceEvidence,
  classifyStudioTurnDetail,
  consumeUiSnapshot,
  isAllowedAcceptanceRequest,
  isAllowedAcceptanceWebSocket,
  isExpectedReleaseMetadata,
  isExpectedTestReleaseMetadata,
  parseAcceptanceArgs,
  serializeAcceptanceEvidence,
  settleOwnedAcceptanceTurn,
  writeAcceptanceEvidence,
} from './goal-b-test-acceptance.mjs';

const REVISION = 'a'.repeat(40);
const ORIGIN = 'http://127.0.0.1:18080';
const RUN_ID = '30123456789';
const RUN_ATTEMPT = '2';
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
    parseAcceptanceArgs([
      '--environment',
      'test',
      '--revision',
      REVISION,
      '--run-id',
      RUN_ID,
      '--run-attempt',
      RUN_ATTEMPT,
      '--web-origin',
      ORIGIN,
      '--output',
      output,
    ]),
    {
      environment: 'test',
      revision: REVISION,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      webOrigin: ORIGIN,
      output,
    },
  );
  assert.deepEqual(
    parseAcceptanceArgs([
      '--environment',
      'production',
      '--revision',
      REVISION,
      '--run-id',
      RUN_ID,
      '--run-attempt',
      RUN_ATTEMPT,
      '--web-origin',
      'https://buildwithcombo.com',
      '--output',
      output,
    ]),
    {
      environment: 'production',
      revision: REVISION,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      webOrigin: 'https://buildwithcombo.com',
      output,
    },
  );
  assert.deepEqual(
    parseAcceptanceArgs([
      '--environment',
      'preview',
      '--revision',
      REVISION,
      '--run-id',
      RUN_ID,
      '--run-attempt',
      RUN_ATTEMPT,
      '--web-origin',
      'https://review.43-160-242-46.sslip.io',
      '--output',
      output,
    ]),
    {
      environment: 'preview',
      revision: REVISION,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      webOrigin: 'https://review.43-160-242-46.sslip.io',
      output,
    },
  );

  const rejected = [
    [],
    ['--revision', REVISION, '--web-origin', ORIGIN],
    [
      '--environment',
      'test',
      '--revision',
      REVISION,
      '--run-id',
      RUN_ID,
      '--run-attempt',
      RUN_ATTEMPT,
      '--web-origin',
      ORIGIN,
      '--cookie',
      'private',
    ],
    [
      '--environment',
      'test',
      '--revision',
      REVISION.toUpperCase(),
      '--run-id',
      RUN_ID,
      '--run-attempt',
      RUN_ATTEMPT,
      '--web-origin',
      ORIGIN,
      '--output',
      output,
    ],
    [
      '--environment',
      'test',
      '--revision',
      REVISION,
      '--run-id',
      '0',
      '--run-attempt',
      RUN_ATTEMPT,
      '--web-origin',
      ORIGIN,
      '--output',
      output,
    ],
    [
      '--environment',
      'preview',
      '--revision',
      REVISION,
      '--run-id',
      RUN_ID,
      '--run-attempt',
      RUN_ATTEMPT,
      '--web-origin',
      'https://example.com',
      '--output',
      output,
    ],
    [
      '--environment',
      'production',
      '--revision',
      REVISION,
      '--run-id',
      RUN_ID,
      '--run-attempt',
      RUN_ATTEMPT,
      '--web-origin',
      'https://www.buildwithcombo.com',
      '--output',
      output,
    ],
    [
      '--environment',
      'test',
      '--revision',
      REVISION,
      '--revision',
      REVISION,
      '--run-id',
      RUN_ID,
      '--run-attempt',
      RUN_ATTEMPT,
      '--output',
      output,
    ],
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
  assert.equal(
    isAllowedAcceptanceRequest('https://api.resend.com/emails', 'https://buildwithcombo.com'),
    false,
  );
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

test('email OTP acceptance honors the asynchronous challenge status contract', () => {
  const source = readFileSync(new URL('./goal-b-test-acceptance.mjs', import.meta.url), 'utf8');
  const helperStart = source.indexOf('async function authenticateWithEmailOtp(');
  const helperEnd = source.indexOf('\nasync function ', helperStart + 1);
  assert.ok(helperStart > 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(
    helper,
    /api\.json\(check, '\/api\/v1\/auth\/email\/challenges', \{[\s\S]*?method: 'POST',[\s\S]*?data: \{ email \},[\s\S]*?expected: \[202\],[\s\S]*?\}\)/,
  );
  assert.doesNotMatch(
    helper,
    /api\.json\(check, '\/api\/v1\/auth\/email\/challenges', \{[\s\S]*?expected: \[200\]/,
  );
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
  assert.equal(
    isExpectedReleaseMetadata({ ...RELEASE, environment: 'production' }, REVISION, 'production'),
    true,
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
  assert.doesNotThrow(() =>
    serializeAcceptanceEvidence({
      ...evidence,
      publicProofs: [
        `sha256:${'a'.repeat(20)}123456${'b'.repeat(38)}`,
        '01982e62-6d6e-7f4d-8fe8-b55f12345678',
        `a${'b'.repeat(15)}123456${'c'.repeat(18)}`,
      ],
    }),
  );
  assert.throws(
    () => serializeAcceptanceEvidence({ ...evidence, diagnostic: '123456' }),
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

test('acceptance Turn cleanup trusts terminal state across interrupt response races', async () => {
  const targetTurnId = '41982e62-6d6e-7f4d-8fe8-b55f62720b5b';
  let detailReads = 0;
  let interrupts = 0;
  const settled = await settleOwnedAcceptanceTurn({
    check: 'studio_interrupted_artifact_excluded',
    knownTurnId: targetTurnId,
    readDetail: async () => {
      detailReads += 1;
      if (detailReads === 1) return { activeTurn: { id: targetTurnId } };
      return { activeTurn: null };
    },
    interrupt: async () => {
      interrupts += 1;
      return false;
    },
    timeoutMs: 50,
    intervalMs: 0,
  });
  assert.equal(settled.activeTurn, null);
  assert.equal(interrupts, 1);
});

test('acceptance Turn cleanup recovers an unknown POST outcome without killing another Turn', async () => {
  const ownedTurnId = '51982e62-6d6e-7f4d-8fe8-b55f62720b5b';
  let activeTurn = { id: ownedTurnId };
  let interrupts = 0;
  await settleOwnedAcceptanceTurn({
    check: 'studio_interrupted_artifact_excluded',
    readDetail: async () => ({ activeTurn }),
    interrupt: async () => {
      interrupts += 1;
      activeTurn = null;
      throw new Error('response lost');
    },
    timeoutMs: 50,
    intervalMs: 0,
  });
  assert.equal(interrupts, 1);
  assert.equal(activeTurn, null);

  const otherTurnId = '61982e62-6d6e-7f4d-8fe8-b55f62720b5b';
  interrupts = 0;
  const unchanged = await settleOwnedAcceptanceTurn({
    check: 'studio_interrupted_artifact_excluded',
    knownTurnId: ownedTurnId,
    readDetail: async () => ({ activeTurn: { id: otherTurnId } }),
    interrupt: async () => {
      interrupts += 1;
      return true;
    },
    timeoutMs: 50,
    intervalMs: 0,
  });
  assert.equal(unchanged.activeTurn.id, otherTurnId);
  assert.equal(interrupts, 0);
});

test('Studio Turn classifier binds the accepted Turn and fails terminal errors without raw detail', () => {
  const turnId = '71982e62-6d6e-7f4d-8fe8-b55f62720b5b';
  const artifact = {
    id: '81982e62-6d6e-7f4d-8fe8-b55f62720b5b',
    sourceTurnId: turnId,
  };
  assert.deepEqual(
    classifyStudioTurnDetail(
      {
        activeTurn: { id: turnId },
        latestTerminalTurn: null,
        artifacts: [],
      },
      turnId,
    ),
    { state: 'pending' },
  );
  assert.deepEqual(
    classifyStudioTurnDetail(
      {
        activeTurn: null,
        latestTerminalTurn: { id: turnId, status: 'completed', errorCode: null },
        artifacts: [artifact],
      },
      turnId,
    ),
    { state: 'completed' },
  );
  assert.deepEqual(
    classifyStudioTurnDetail(
      {
        activeTurn: null,
        latestTerminalTurn: {
          id: turnId,
          status: 'failed',
          errorCode: 'TURN_PROMPT_FAILED',
        },
        artifacts: [],
      },
      turnId,
    ),
    { state: 'failed', diagnosticCode: 'TURN_PROMPT_FAILED' },
  );
  assert.deepEqual(
    classifyStudioTurnDetail(
      {
        activeTurn: null,
        latestTerminalTurn: {
          id: turnId,
          status: 'interrupted',
          errorCode: 'TURN_INTERRUPTED',
        },
        artifacts: [],
      },
      turnId,
    ),
    { state: 'failed', diagnosticCode: 'TURN_INTERRUPTED' },
  );
  assert.deepEqual(
    classifyStudioTurnDetail(
      {
        activeTurn: null,
        latestTerminalTurn: { id: turnId, status: 'completed', errorCode: null },
        artifacts: [],
      },
      turnId,
    ),
    { state: 'failed', diagnosticCode: 'TURN_COMPLETED_WITHOUT_ARTIFACT' },
  );
  assert.deepEqual(
    classifyStudioTurnDetail(
      {
        activeTurn: null,
        latestTerminalTurn: {
          id: '91982e62-6d6e-7f4d-8fe8-b55f62720b5b',
          status: 'failed',
          errorCode: 'TURN_FAILED',
        },
        artifacts: [],
      },
      turnId,
    ),
    { state: 'failed', diagnosticCode: 'TURN_DETAIL_INVARIANT' },
  );
});

test('failure evidence retains only an allowlisted Studio Turn diagnostic code', () => {
  const evidence = buildAcceptanceEvidence({
    revision: REVISION,
    webOrigin: ORIGIN,
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:01:00.000Z',
    checks: [],
    resources: {},
    metrics: {},
    failure: new AcceptanceFailure(
      'studio_first_revision',
      'invalid_response',
      undefined,
      'TURN_RUNTIME_ERROR',
    ),
  });
  assert.deepEqual(evidence.failure, {
    check: 'studio_first_revision',
    reason: 'invalid_response',
    diagnosticCode: 'TURN_RUNTIME_ERROR',
  });

  const redacted = buildAcceptanceEvidence({
    revision: REVISION,
    webOrigin: ORIGIN,
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:01:00.000Z',
    checks: [],
    resources: {},
    metrics: {},
    failure: new AcceptanceFailure(
      'studio_first_revision',
      'invalid_response',
      undefined,
      'provider returned raw error',
    ),
  });
  assert.equal(Object.hasOwn(redacted.failure, 'diagnosticCode'), false);
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
    'email_otp_login',
    'preview_identity_badge_and_copy',
    'creation_idempotency',
    'authoring_prepare',
    'authoring_resume_after_reload',
    'authoring_upload_terminal',
    'creation_capability_selection',
    'creation_publish_and_retry_fence',
    'studio_entry',
    'studio_failed_send_retains_draft',
    'studio_single_accept_and_clear',
    'studio_active_turn_reload',
    'studio_first_revision',
    'studio_element_selection',
    'runtime_sse_replay_and_terminal',
    'studio_second_revision',
    'studio_interrupted_artifact_excluded',
    'runtime_current_ui_consume',
    'studio_trial_return',
    'task_trial_return',
    'preview_gate_login_and_return_to',
    'owner_isolation',
    'session_persistence',
    'logout_revokes_session',
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
    '/stream',
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
  assert.match(source, /严格分两个独立阶段执行，禁止合并工具调用/);
  assert.match(source, /必须等待第一次工具成功回执后才能进入第二阶段/);
  assert.match(source, /artifactForTurn\(detail, interruptedTurnId\)[\s\S]*TURN_TIMEOUT_MS/);
  assert.match(source, /finally \{[\s\S]*settleOwnedAcceptanceTurn/);
  assert.match(source, /pairingCode = replay\.data\?\.pairingCode/);
  assert.match(source, /unauthenticated\.status\(\) === 401/);
  assert.match(source, /rejected\.status\(\) === 403/);
  assert.match(source, /gate\.status\(\) === 204/);
  assert.match(source, /gateCookie\?\.httpOnly === true/);
  assert.match(source, /gateCookie\.secure === true/);
  assert.match(source, /gateCookie\.sameSite === 'Strict'/);
  assert.match(source, /previewGateCookie = \{ \.\.\.gateCookie \}/);
  assert.match(
    source,
    /value: authenticationCookieValue[\s\S]*const revoked = await replayApi\.raw\('\/api\/v1\/me'\)[\s\S]*revoked\.status\(\) === 401/,
  );
  assert.match(source, /aside\[aria-label="Preview 发布身份"\]/);
  assert.match(source, /navigator\.clipboard\.readText\(\)/);
  assert.match(source, /Last-Event-ID/);
  assert.match(source, /runtime\/sessions\/\$\{sessionId\}\/stream/);
  assert.match(source, /RUN_STARTED/);
  assert.match(source, /RUN_FINISHED/);
  assert.match(source, /RUN_ERROR/);
  assert.match(source, /__review\/bootstrap\?returnTo=/);
  assert.match(source, /evil\.example/);
  assert.match(source, /选择能力「\$\{capability\.name\}」/);
  assert.match(source, /一键发布到市集 · 1 项/);
  assert.match(source, /\/api\/v1\/auth\/email\/challenges/);
  assert.match(source, /\/api\/v1\/auth\/email\/verifications/);
  assert.match(source, /waitForDeliveredAcceptanceOtp/);
  assert.match(source, /__Host-cb_session/);
  assert.doesNotMatch(source, /recordVideo|tracing\.start|page\.screenshot/);
});
