import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { URL, URLSearchParams } from 'node:url';
import {
  GOAL_B_ACCEPTANCE_CHECKS,
  GOAL_B_UPLOAD_PARTS,
  buildAcceptanceEvidence,
  consumeUiSnapshot,
  isAllowedAcceptanceRequest,
  isAllowedAcceptanceWebSocket,
  isExpectedReleaseMetadata,
  isExpectedTestReleaseMetadata,
  parseAcceptanceArgs,
  parseProductionCredentials,
  serializeAcceptanceEvidence,
  settleOwnedAcceptanceTurn,
  validateProductionAuthorizeUrl,
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
    { environment: 'test', revision: REVISION, webOrigin: ORIGIN, output },
  );
  assert.deepEqual(
    parseAcceptanceArgs([
      '--environment',
      'production',
      '--revision',
      REVISION,
      '--web-origin',
      'https://buildwithcombo.com',
      '--output',
      output,
    ]),
    {
      environment: 'production',
      revision: REVISION,
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
      '--web-origin',
      'https://review.43-160-242-46.sslip.io',
      '--output',
      output,
    ]),
    {
      environment: 'preview',
      revision: REVISION,
      webOrigin: 'https://review.43-160-242-46.sslip.io',
      output,
    },
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
    [
      '--environment',
      'preview',
      '--revision',
      REVISION,
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
      '--web-origin',
      'https://www.buildwithcombo.com',
      '--output',
      output,
    ],
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
  assert.equal(
    isAllowedAcceptanceRequest(
      'https://andkzt.logto.app/oidc/auth',
      'https://buildwithcombo.com',
      'https://andkzt.logto.app',
    ),
    true,
  );
  assert.equal(
    isAllowedAcceptanceRequest(
      'https://example.com/oidc/auth',
      'https://buildwithcombo.com',
      'https://andkzt.logto.app',
    ),
    false,
  );
});

test('Production credentials accept exactly two distinct bounded stdin identities', () => {
  assert.deepEqual(
    parseProductionCredentials(
      'creator@example.com\ncorrect horse battery staple\nreviewer@example.com\nanother correct horse\n',
    ),
    {
      primary: {
        email: 'creator@example.com',
        password: 'correct horse battery staple',
      },
      secondary: {
        email: 'reviewer@example.com',
        password: 'another correct horse',
      },
    },
  );
  for (const raw of [
    '',
    'creator@example.com\n',
    'creator@example.com\nshort\nreviewer@example.com\nvalid-password\n',
    'creator@example.com\nvalid-password\nreviewer@example.com\nvalid-password\nextra\n',
    'creator@example.com\r\nvalid-password\nreviewer@example.com\nvalid-password\n',
    'PRODUCTION_ACCEPTANCE_EMAIL=creator@example.com\nvalid-password\nreviewer@example.com\nvalid-password\n',
    'placeholder@example.com\nvalid-password\nreviewer@example.com\nvalid-password\n',
    'creator@example.com\nplaceholder-password\nreviewer@example.com\nvalid-password\n',
    ' creator@example.com\nvalid-password\nreviewer@example.com\nvalid-password\n',
    'creator@@example.com\nvalid-password\nreviewer@example.com\nvalid-password\n',
    'creator@example.com\n        \nreviewer@example.com\nvalid-password\n',
    'creator@example.com\nvalid\tpassword\nreviewer@example.com\nvalid-password\n',
    'creator@example.com\nvalid-password\ncreator@example.com\nanother-password\n',
    'Creator@example.com\nvalid-password\ncreator@EXAMPLE.com\nanother-password\n',
    `${'a'.repeat(2049)}\nvalid-password\nreviewer@example.com\nvalid-password\n`,
  ]) {
    assert.throws(() => parseProductionCredentials(raw));
  }
});

test('Production credential-only CLI reuses the parser without echoing values', () => {
  const script = new URL('./goal-b-test-acceptance.mjs', import.meta.url);
  const valid =
    'creator@example.com\ncorrect horse battery staple\nreviewer@example.com\nanother correct horse\n';
  const accepted = spawnSync(
    process.execPath,
    [script.pathname, '--validate-production-credentials'],
    {
      encoding: 'utf8',
      input: valid,
    },
  );
  assert.equal(accepted.status, 0);
  assert.equal(accepted.stdout, '');
  assert.equal(accepted.stderr, '');

  const invalid = 'placeholder@example.com\nvalid-password\nreviewer@example.com\nvalid-password\n';
  const rejected = spawnSync(
    process.execPath,
    [script.pathname, '--validate-production-credentials'],
    {
      encoding: 'utf8',
      input: invalid,
    },
  );
  assert.equal(rejected.status, 2);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /failed validation/);
  assert.doesNotMatch(rejected.stderr, /placeholder|valid-password|reviewer@example/u);
});

test('Production OIDC authorization is exact PKCE S256 with the formal callback', () => {
  const query = new URLSearchParams({
    client_id: 'combo-production',
    code_challenge: 'A'.repeat(43),
    code_challenge_method: 'S256',
    nonce: 'n'.repeat(43),
    prompt: 'login consent',
    redirect_uri: 'https://buildwithcombo.com/api/v1/auth/callback',
    resource: 'https://api.agora.local/',
    response_type: 'code',
    scope: 'openid offline_access profile email roles',
    state: 's'.repeat(43),
  });
  const authorize = `https://andkzt.logto.app/oidc/auth?${query}`;
  assert.equal(validateProductionAuthorizeUrl(authorize), authorize);
  for (const invalid of [
    authorize.replace('andkzt.logto.app', 'evil.example'),
    authorize.replace('code_challenge_method=S256', 'code_challenge_method=plain'),
    authorize.replace(
      encodeURIComponent('https://buildwithcombo.com/api/v1/auth/callback'),
      encodeURIComponent('https://evil.example/callback'),
    ),
    `${authorize}&state=duplicate`,
    `${authorize}&unexpected=value`,
  ]) {
    assert.throws(() => validateProductionAuthorizeUrl(invalid));
  }
});

test('Production login targets the visible Logto action and named consent button', () => {
  const source = readFileSync(new URL('./goal-b-test-acceptance.mjs', import.meta.url), 'utf8');
  assert.match(source, /button\[type="submit"\]:visible/);
  assert.doesNotMatch(source, /form\.locator\('input\[type="submit"\]'\)/);
  assert.match(source, /name: \/\^Authorize\$\/u/);
  assert.match(source, /locale: 'en-US'/);
  assert.doesNotMatch(source, /const consentForm = page\.locator\('form'\)/);
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
    'authentication_login',
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
    'preview_gate_bootstrap_and_return_to',
    'owner_isolation',
    'authentication_refresh',
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
  assert.match(source, /aside\[aria-label="Preview 发布身份"\]/);
  assert.match(source, /navigator\.clipboard\.readText\(\)/);
  assert.match(source, /Last-Event-ID/);
  assert.match(source, /runtime\/sessions\/\$\{sessionId\}\/stream/);
  assert.match(source, /RUN_STARTED/);
  assert.match(source, /RUN_FINISHED/);
  assert.match(source, /RUN_ERROR/);
  assert.match(source, /恢复预览会话/);
  assert.match(source, /__review\/bootstrap\?returnTo=/);
  assert.match(source, /evil\.example/);
  assert.match(source, /选择能力「\$\{capability\.name\}」/);
  assert.match(source, /一键发布到市集 · 1 项/);
  assert.match(source, /disabledDevLogin\.status\(\) === 404/);
  assert.match(source, /code_challenge_method/);
  assert.match(source, /PRODUCTION_OIDC_ISSUER/);
  assert.match(source, /input\[name="identifier"\]\[type="email"\]/);
  assert.match(source, /input\[name="password"\]\[type="password"\]/);
  assert.doesNotMatch(source, /recordVideo|tracing\.start|page\.screenshot/);
});
