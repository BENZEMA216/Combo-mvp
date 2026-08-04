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
  classifyAcceptanceMessageProtocol,
  classifyStudioTurnDetail,
  consumeUiSnapshot,
  diagnoseTimedOutStudioMessage,
  fetchAcceptanceRequest,
  isAllowedAcceptanceRequest,
  isAllowedAcceptanceWebSocket,
  isExpectedReleaseMetadata,
  isExpectedTestReleaseMetadata,
  parseAcceptanceArgs,
  postRuntimeMessageCompat,
  serializeAcceptanceEvidence,
  settleOwnedAcceptanceTurn,
  waitForAcceptanceUrl,
  writeAcceptanceEvidence,
} from './goal-b-test-acceptance.mjs';

const REVISION = 'a'.repeat(40);
const ORIGIN = 'https://test.43-160-242-46.sslip.io';
const RUN_ID = '30123456789';
const RUN_ATTEMPT = '2';
const WORKFLOW_RUN = {
  workflowRunId: Number(RUN_ID),
  workflowRunAttempt: Number(RUN_ATTEMPT),
};
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

test('trusted Runtime message compatibility sends at most one accepted request', async () => {
  const usageId = '41982e62-6d6e-7f4d-8fe8-b55f62720b5b';
  const path = '/api/v1/runtime/sessions/session/messages';
  const text = 'compatibility probe';
  const turn = { message: { turnId: UUIDS.studioSessionId } };

  const modernCalls = [];
  const modern = {
    json: async (...args) => {
      modernCalls.push(args);
      return { status: 202, data: { data: turn } };
    },
  };
  const modernResult = await postRuntimeMessageCompat(
    modern,
    'runtime_current_ui_consume',
    path,
    text,
    usageId,
  );
  assert.deepEqual(modernResult, { status: 202, data: turn });
  assert.equal(modernCalls.length, 1);
  assert.deepEqual(modernCalls[0][2].data, { text, usageId });

  const legacyCalls = [];
  const legacy = {
    json: async (...args) => {
      legacyCalls.push(args);
      if (legacyCalls.length === 1) {
        return {
          status: 400,
          data: {
            error: {
              userMessage: '输入有点问题，改一下再试。',
              action: 'change_input',
              retriable: false,
            },
          },
        };
      }
      return { status: 202, data: turn };
    },
  };
  const legacyResult = await postRuntimeMessageCompat(
    legacy,
    'runtime_current_ui_consume',
    path,
    text,
    usageId,
  );
  assert.deepEqual(legacyResult, { status: 202, data: turn });
  assert.equal(legacyCalls.length, 2);
  assert.deepEqual(legacyCalls[0][2].data, { text, usageId });
  assert.deepEqual(legacyCalls[1][2].data, { text });

  const unsafeCalls = [];
  const unsafe = {
    json: async (...args) => {
      unsafeCalls.push(args);
      return {
        status: 400,
        data: {
          error: { userMessage: 'different failure', action: 'change_input', retriable: false },
        },
      };
    },
  };
  await assert.rejects(
    postRuntimeMessageCompat(unsafe, 'runtime_current_ui_consume', path, text, usageId),
    AcceptanceFailure,
  );
  assert.equal(unsafeCalls.length, 1);

  let networkCalls = 0;
  const networkFailure = new Error('unknown request outcome');
  await assert.rejects(
    postRuntimeMessageCompat(
      {
        json: async () => {
          networkCalls += 1;
          throw networkFailure;
        },
      },
      'runtime_current_ui_consume',
      path,
      text,
      usageId,
    ),
    (error) => error === networkFailure,
  );
  assert.equal(networkCalls, 1);
});

test('live browser retries only idempotent GET transport failures once', async () => {
  const transient = new Error('transient transport failure');
  const response = { status: () => 200 };
  const getCalls = [];
  const getContext = {
    request: {
      fetch: async (...args) => {
        getCalls.push(args);
        if (getCalls.length === 1) throw transient;
        return response;
      },
    },
  };
  assert.equal(
    await fetchAcceptanceRequest(getContext, `${ORIGIN}/detail`, {
      method: 'GET',
    }),
    response,
  );
  assert.equal(getCalls.length, 2);

  let postCalls = 0;
  await assert.rejects(
    fetchAcceptanceRequest(
      {
        request: {
          fetch: async () => {
            postCalls += 1;
            throw transient;
          },
        },
      },
      `${ORIGIN}/messages`,
      { method: 'POST' },
    ),
    (error) => error === transient,
  );
  assert.equal(postCalls, 1);
});

test('second Studio revision validates the detail message collection before lookup', () => {
  const source = readFileSync(new URL('./goal-b-test-acceptance.mjs', import.meta.url), 'utf8');
  const checkStart = source.indexOf("await checked('studio_second_revision'");
  const checkEnd = source.indexOf(
    "await checked('studio_interrupted_artifact_excluded'",
    checkStart,
  );
  assert.ok(checkStart > 0 && checkEnd > checkStart);
  const check = source.slice(checkStart, checkEnd);

  assert.match(
    check,
    /ensure\(Array\.isArray\(secondDetail\.messages\), activeCheck, 'invalid_response'\)/,
  );
});

test('live browser resolves a billing-aware unknown write before changing task', () => {
  const source = readFileSync(new URL('./goal-b-test-acceptance.mjs', import.meta.url), 'utf8');
  const checkStart = source.indexOf("await checked('studio_failed_send_retains_draft'");
  const checkEnd = source.indexOf("await checked('studio_single_accept_and_clear'", checkStart);
  assert.ok(checkStart > 0 && checkEnd > checkStart);
  const check = source.slice(checkStart, checkEnd);

  assert.match(check, /status: 503/);
  assert.match(check, /status: 400/);
  assert.match(check, /name: '重试原任务'/);
  assert.match(check, /let injectedPhase = 'reject-503'/);
  assert.match(check, /injectedPhase = 'reject-400'/);
  assert.match(check, /unexpectedInjectedRequests \+= 1[\s\S]*status: 409/);
  assert.doesNotMatch(check, /\{ times: 1 \}/);
  assert.match(
    check,
    /studioMessageProtocol = classifyAcceptanceMessageProtocol\(uncertainUsageId\)/,
  );
  assert.match(check, /if \(studioMessageProtocol === 'usage-id'\)/);
  assert.match(check, /retryButton\.waitFor\(\{ state: 'visible', timeout: 10_000 \}\)/);
  assert.match(check, /ensure\(!\(await retryButton\.isVisible\(\)\)/);
  assert.match(check, /retryUsageId === resolvedUncertainUsageId &&\s+retryText === uncertainText/);
  assert.match(check, /retryButton\.waitFor\(\{ state: 'hidden', timeout: 10_000 \}\)/);
  assert.match(check, /page\.unrouteAll\(\{ behavior: 'wait' \}\)/);
});

test('message protocol classification is exact for legacy and usageId clients', () => {
  assert.equal(classifyAcceptanceMessageProtocol(undefined), 'legacy');
  assert.equal(
    classifyAcceptanceMessageProtocol('41982e62-6d6e-4f4d-8fe8-b55f62720b5b'),
    'usage-id',
  );
  for (const value of [null, '', 'not-a-uuid', '41982e62-6d6e-0f4d-8fe8-b55f62720b5b']) {
    assert.equal(classifyAcceptanceMessageProtocol(value), 'invalid');
  }
});

test('live Studio submit passively observes the real request after draining injected routes', () => {
  const source = readFileSync(new URL('./goal-b-test-acceptance.mjs', import.meta.url), 'utf8');
  const checkStart = source.indexOf("await checked('studio_single_accept_and_clear'");
  const checkEnd = source.indexOf("await checked('studio_active_turn_reload'", checkStart);
  assert.ok(checkStart > 0 && checkEnd > checkStart);
  const check = source.slice(checkStart, checkEnd);

  assert.match(check, /page\.on\('request', countMessageRequest\)/);
  assert.match(check, /requestCount = Math\.min\(100, requestCount \+ 1\)/);
  assert.match(check, /page\.waitForRequest\(/);
  assert.match(check, /await sendButton\.evaluate/);
  assert.equal(check.match(/button\.click\(\);/g)?.length, 2);
  assert.match(check, /page\.off\('request', countMessageRequest\)/);
  assert.match(check, /submittedUsageId !== resolvedUncertainUsageId/);
  assert.doesNotMatch(check, /page\.route\(|route\.fallback\(/);
});

test('timed-out Studio submit only interrupts its exact active Turn', async () => {
  const detailPath = '/api/v1/runtime/sessions/session';
  const interruptPath = `${detailPath}/interrupt`;
  const text = 'bounded diagnostic read';
  const activeTurnId = '41982e62-6d6e-4f4d-8fe8-b55f62720b5b';
  const calls = [];
  const exact = {
    raw: async (path, options) => {
      calls.push([path, options]);
      if (path === interruptPath) return { status: () => 200 };
      return {
        status: () => 200,
        json: async () => ({
          data: {
            messages: [
              {
                role: 'user',
                status: 'completed',
                turnId: activeTurnId,
                content: [{ type: 'text', text }],
              },
            ],
            activeTurn: { id: activeTurnId },
          },
        }),
      };
    },
  };
  assert.equal(
    await diagnoseTimedOutStudioMessage(exact, detailPath, interruptPath, text),
    'MESSAGE_RESPONSE_TIMEOUT_DETAIL_ACTIVE_INTERRUPT_ACCEPTED',
  );
  assert.deepEqual(calls, [
    [detailPath, { timeout: 5_000 }],
    [interruptPath, { method: 'POST', data: {}, timeout: 5_000 }],
  ]);

  for (const [messageText, activeId, expected] of [
    ['another prompt', activeTurnId, 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_ABSENT'],
    [
      text,
      '11111111-1111-4111-8111-111111111111',
      'MESSAGE_RESPONSE_TIMEOUT_DETAIL_MESSAGE_COMMITTED',
    ],
  ]) {
    let interruptCalls = 0;
    const diagnostic = await diagnoseTimedOutStudioMessage(
      {
        raw: async (path) => {
          if (path === interruptPath) {
            interruptCalls += 1;
            return { status: () => 200 };
          }
          return {
            status: () => 200,
            json: async () => ({
              data: {
                messages: [
                  {
                    role: 'user',
                    status: 'completed',
                    turnId: activeTurnId,
                    content: [{ type: 'text', text: messageText }],
                  },
                ],
                activeTurn: { id: activeId },
              },
            }),
          };
        },
      },
      detailPath,
      interruptPath,
      text,
    );
    assert.equal(diagnostic, expected);
    assert.equal(interruptCalls, 0);
  }

  assert.equal(
    await diagnoseTimedOutStudioMessage(
      {
        raw: async () => ({
          status: () => 200,
          json: async () => ({ data: { messages: null } }),
        }),
      },
      detailPath,
      interruptPath,
      text,
    ),
    'MESSAGE_RESPONSE_TIMEOUT_DETAIL_INVALID',
  );
  assert.equal(
    await diagnoseTimedOutStudioMessage(
      {
        raw: async (path) =>
          path === interruptPath
            ? { status: () => 503 }
            : {
                status: () => 200,
                json: async () => ({
                  data: {
                    messages: [
                      {
                        role: 'user',
                        status: 'completed',
                        turnId: activeTurnId,
                        content: [{ type: 'text', text }],
                      },
                    ],
                    activeTurn: { id: activeTurnId },
                  },
                }),
              },
      },
      detailPath,
      interruptPath,
      text,
    ),
    'MESSAGE_RESPONSE_TIMEOUT_DETAIL_ACTIVE_INTERRUPT_REJECTED',
  );

  for (const [status, expected] of [
    [404, 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_CLIENT_REJECTED'],
    [503, 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_SERVER_REJECTED'],
    [204, 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_UNEXPECTED_STATUS'],
  ]) {
    assert.equal(
      await diagnoseTimedOutStudioMessage(
        { raw: async () => ({ status: () => status }) },
        detailPath,
        interruptPath,
        text,
      ),
      expected,
    );
  }

  const timeout = new Error('must not enter evidence');
  timeout.name = 'TimeoutError';
  assert.equal(
    await diagnoseTimedOutStudioMessage(
      {
        raw: async () => {
          throw timeout;
        },
      },
      detailPath,
      interruptPath,
      text,
    ),
    'MESSAGE_RESPONSE_TIMEOUT_DETAIL_TIMEOUT',
  );
  assert.equal(
    await diagnoseTimedOutStudioMessage(
      {
        raw: async () => {
          throw new Error('must not enter evidence either');
        },
      },
      detailPath,
      interruptPath,
      text,
    ),
    'MESSAGE_RESPONSE_TIMEOUT_DETAIL_FAILED',
  );
});

test('browser URL waits poll same-document location without a lifecycle wait', async () => {
  const expectation = {
    origin: 'https://review.example',
    pathnamePattern: '^/try/session/[0-9a-f-]+$',
    searchParams: { returnTo: '/tasks/task-1' },
  };
  const calls = [];
  const page = {
    waitForFunction: async (...args) => calls.push(args),
  };

  await waitForAcceptanceUrl(page, expectation);

  assert.equal(calls.length, 1);
  const [predicate, argument, options] = calls[0];
  assert.deepEqual(argument, expectation);
  assert.deepEqual(options, { timeout: 30_000 });

  const originalWindow = globalThis.window;
  try {
    globalThis.window = {
      location: {
        href: 'https://review.example/try/session/ABC-123?returnTo=%2Ftasks%2Ftask-1',
      },
    };
    assert.equal(predicate(argument), true);
    globalThis.window.location.href =
      'https://review.example/try/session/ABC-123?returnTo=%2Ftasks%2Fother';
    assert.equal(predicate(argument), false);
    globalThis.window.location.href =
      'https://other.example/try/session/ABC-123?returnTo=%2Ftasks%2Ftask-1';
    assert.equal(predicate(argument), false);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});

test('accepts only the exact SHA, public Test origin, and fresh output arguments', () => {
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
      'test',
      '--revision',
      REVISION,
      '--run-id',
      String(Number.MAX_SAFE_INTEGER + 1),
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
      'test',
      '--revision',
      REVISION,
      '--run-id',
      RUN_ID,
      '--run-attempt',
      RUN_ATTEMPT,
      '--web-origin',
      'http://127.0.0.1:18080',
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

test('acceptance browser allows only WebSockets on the exact public Test origin', () => {
  assert.equal(
    isAllowedAcceptanceWebSocket('wss://test.43-160-242-46.sslip.io/events', ORIGIN),
    true,
  );
  for (const value of [
    'ws://test.43-160-242-46.sslip.io/events',
    'wss://localhost/events',
    'wss://test.43-160-242-46.sslip.io:444/events',
    'ws://example.com/events',
    'wss://user:pass@test.43-160-242-46.sslip.io/events',
    'not-a-url',
  ]) {
    assert.equal(isAllowedAcceptanceWebSocket(value, ORIGIN), false, value);
  }
});

test('browser network gate only permits the exact public HTTPS origin and non-network URLs', () => {
  for (const value of [
    `${ORIGIN}/tasks`,
    `${ORIGIN}/try/assets/app.js`,
    'about:blank',
    `blob:${ORIGIN}/01982e62-6d6e-7f4d-8fe8-b55f62720b5b`,
    'data:text/plain,local',
  ]) {
    assert.equal(isAllowedAcceptanceRequest(value, ORIGIN), true, value);
  }
  for (const value of [
    'http://test.43-160-242-46.sslip.io/tasks',
    'https://localhost/tasks',
    'https://test.43-160-242-46.sslip.io:444/tasks',
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

test('Test origin, Nginx allowlist, and page interception preserve one public boundary', () => {
  const nginx = readFileSync(
    new URL('../infra/k8s/overlays/combo-dev/apps/nginx-dev.conf', import.meta.url),
    'utf8',
  );
  const source = readFileSync(new URL('./goal-b-test-acceptance.mjs', import.meta.url), 'utf8');

  assert.match(nginx, /"https:\/\/test\.43-160-242-46\.sslip\.io" 1;/);
  assert.doesNotMatch(nginx, /"http:\/\/127\.0\.0\.1:18080" 1;/);
  assert.equal(
    nginx.match(/proxy_set_header X-Forwarded-Proto \$http_x_forwarded_proto;/g)?.length,
    4,
  );
  assert.doesNotMatch(nginx, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  assert.match(source, /const messageUrl = `\$\{options\.webOrigin\}\$\{messagePath\}`/);
  assert.match(source, /page\.route\(\s*messageUrl/);
  assert.match(source, /page\.waitForRequest\([\s\S]*request\.url\(\) === messageUrl/);
  assert.match(source, /page\.unrouteAll\(\{ behavior: 'wait' \}\)/);
  assert.doesNotMatch(source, /route\.fallback\(\)/);
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
    ...WORKFLOW_RUN,
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
  assert.equal(evidence.workflowRunId, Number(RUN_ID));
  assert.equal(evidence.workflowRunAttempt, Number(RUN_ATTEMPT));
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
    ...WORKFLOW_RUN,
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
  assert.equal(
    buildAcceptanceEvidence({ ...base, workflowRunAttempt: undefined }).status,
    'failed',
  );
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
    ...WORKFLOW_RUN,
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
    ...WORKFLOW_RUN,
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

test('message submit evidence retains only allowlisted diagnostics and bounded request count', () => {
  const base = {
    ...WORKFLOW_RUN,
    revision: REVISION,
    webOrigin: ORIGIN,
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:01:00.000Z',
    checks: [],
    resources: {},
    metrics: {},
  };
  const evidence = buildAcceptanceEvidence({
    ...base,
    failure: new AcceptanceFailure(
      'studio_single_accept_and_clear',
      'timeout',
      undefined,
      'MESSAGE_RESPONSE_TIMEOUT_DETAIL_TIMEOUT',
      1,
    ),
  });
  assert.deepEqual(evidence.failure, {
    check: 'studio_single_accept_and_clear',
    reason: 'timeout',
    diagnosticCode: 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_TIMEOUT',
    requestCount: 1,
  });

  const redacted = buildAcceptanceEvidence({
    ...base,
    failure: new AcceptanceFailure(
      'studio_single_accept_and_clear',
      'timeout',
      undefined,
      'MESSAGE_RESPONSE_TIMEOUT_DETAIL_TIMEOUT',
      101,
    ),
  });
  assert.deepEqual(redacted.failure, {
    check: 'studio_single_accept_and_clear',
    reason: 'timeout',
  });
});

test('secure writer creates a new 0600 evidence file and refuses overwrite', () => {
  const output = join(
    mkdtempSync(join(tmpdir(), 'goal-b-browser-output-')),
    'nested',
    'result.json',
  );
  const evidence = buildAcceptanceEvidence({
    ...WORKFLOW_RUN,
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
    'preview_auth_entry_and_return_to',
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
  assert.match(source, /postRuntimeMessageCompat\([\s\S]*interruptedPrompt/);
  assert.match(source, /artifactForTurn\(detail, interruptedTurnId\)[\s\S]*TURN_TIMEOUT_MS/);
  assert.match(source, /finally \{[\s\S]*settleOwnedAcceptanceTurn/);
  assert.match(source, /pairingCode = replay\.data\?\.pairingCode/);
  assert.match(source, /unauthenticatedVersion\.status\(\) === 200/);
  assert.match(source, /unauthenticatedPage\.status\(\) === 200/);
  assert.match(source, /unauthenticatedApi\.status\(\) === 401/);
  assert.doesNotMatch(source, /COMBO_REVIEW_ACCESS_TOKEN|REVIEW_ACCESS_TOKEN/);
  assert.doesNotMatch(source, /__review\/(?:access|bootstrap|enter)/);
  assert.match(
    source,
    /const navigation = await page\.goto\(path,[\s\S]*navigation\?\.status\(\) !== 200[\s\S]*fail\(activeCheck, 'http_status', navigation\?\.status\(\)\)/,
  );
  assert.match(
    source,
    /RUNTIME_BADGE_PROBE_PAGE =\s*'\/try\/session\/00000000-0000-4000-8000-000000000000'/,
  );
  assert.match(source, /\.cb-shell, \.cb-auth-gate/);
  assert.match(source, /\.rt-shell, \.rt-auth-gate/);
  assert.match(source, /new URL\(page\.url\(\)\)\.pathname === expectedPage/);
  assert.doesNotMatch(source, /'\/try\/\?acceptance=hidden#secret'/);
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
  const authEntryStart = source.indexOf("await checked('preview_auth_entry_and_return_to'");
  const authEntryEnd = source.indexOf("await checked('owner_isolation'", authEntryStart);
  assert.ok(authEntryStart >= 0 && authEntryEnd > authEntryStart);
  const authEntryFlow = source.slice(authEntryStart, authEntryEnd);
  assert.match(
    authEntryFlow,
    /recoveryPage\.goto\(recoveryPath[\s\S]*anonymousMe\.status\(\) === 401[\s\S]*waitForAcceptanceUrl\(recoveryPage,[\s\S]*pathname: '\/login'[\s\S]*searchParams: \{ returnTo: recoveryPath \}[\s\S]*name: '使用邮箱登录'[\s\S]*name: '邮箱'/,
  );
  assert.doesNotMatch(authEntryFlow, /name: '去登录'|loginButton/);
  const logoutStart = source.indexOf("await checked('logout_revokes_session'");
  const logoutEnd = source.indexOf('\n    ensure(\n      GOAL_B_ACCEPTANCE_CHECKS', logoutStart);
  assert.ok(logoutStart >= 0 && logoutEnd > logoutStart);
  const logoutFlow = source.slice(logoutStart, logoutEnd);
  assert.match(
    logoutFlow,
    /const loggedOutReturnTo = `\/tasks\/\$\{task\.id\}`[\s\S]*page\.goto\(loggedOutReturnTo[\s\S]*waitForAcceptanceUrl\(page,[\s\S]*pathname: '\/login'[\s\S]*searchParams: \{ returnTo: loggedOutReturnTo \}[\s\S]*name: '使用邮箱登录'/,
  );
  assert.doesNotMatch(logoutFlow, /name: '去登录'|loginButton/);
  assert.doesNotMatch(source, /name: '去登录'/);
  const selectionStart = source.indexOf("await checked('creation_capability_selection'");
  const publishStart = source.indexOf("await checked('creation_publish_and_retry_fence'");
  const studioStart = source.indexOf("await checked('studio_entry'", publishStart);
  assert.ok(selectionStart >= 0 && publishStart > selectionStart && studioStart > publishStart);
  const selectionFlow = source.slice(selectionStart, publishStart);
  assert.match(selectionFlow, /Agent 已准备好，先选一个真实试用/);
  assert.match(selectionFlow, /name: 'Agent 提取结果'/);
  assert.match(selectionFlow, /continueLink\.waitFor\(\{ state: 'visible', timeout: 30_000 \}\)/);
  assert.match(selectionFlow, /a\[href=.+releasePricingPath/);
  assert.match(selectionFlow, /includes\('继续完善'\)/);
  assert.match(selectionFlow, /release\/pricing/);
  assert.doesNotMatch(selectionFlow, /一键发布|选择能力|publishResponse/);
  const publishFlow = source.slice(publishStart, studioStart);
  assert.match(publishFlow, /name: \/单次定价\//);
  assert.match(publishFlow, /name: '每次使用价格'/);
  assert.match(publishFlow, /name: \/下一步：命名\//);
  assert.match(publishFlow, /name: '自定义子域名'/);
  assert.match(publishFlow, /name: \/下一步：确认发布\//);
  assert.match(publishFlow, /name: \/定价与域名仍只是本机草稿\//);
  assert.match(publishFlow, /name: '开放试用并保存草稿 →'/);
  assert.match(publishFlow, /Agent 已开放试用，可以继续迭代/);
  assert.match(publishFlow, /published\.data\?\.published === true/);
  assert.match(publishFlow, /\/tasks\/\$\{task\.id\}\/retry/);
  assert.match(source, /\/api\/v1\/auth\/email\/challenges/);
  assert.match(source, /\/api\/v1\/auth\/email\/verifications/);
  assert.match(source, /waitForDeliveredAcceptanceOtp/);
  assert.match(source, /__Host-cb_session/);
  assert.match(
    source,
    /async function waitForAcceptanceUrl\(page, expectation\) \{[\s\S]*page\.waitForFunction\([\s\S]*window\.location\.href[\s\S]*expectation,[\s\S]*timeout: 30_000/,
  );
  assert.equal(
    source.match(/\.waitForURL\(/g)?.length ?? 0,
    0,
    'same-document route assertions must not wait for a document lifecycle event',
  );
  assert.match(
    source,
    /await checked\('studio_trial_return',[\s\S]*studioReturnTo = `\/try\/session\/\$\{studioSession\.id\}\?mode=studio&returnTo=\$\{encodeURIComponent\('\/capabilities'\)\}`[\s\S]*searchParams: \{ returnTo: studioReturnTo \}[\s\S]*name: '返回 UI 设计',[\s\S]*exact: true[\s\S]*searchParams: \{ mode: 'studio', returnTo: '\/capabilities' \}[\s\S]*name: 'UI 设计对话'/,
  );
  assert.match(
    source,
    /await checked\('task_trial_return',[\s\S]*waitForAcceptanceUrl\([\s\S]*name: '返回发布流程',[\s\S]*exact: true[\s\S]*waitForAcceptanceUrl\([\s\S]*name: 'Agent 已准备好，先选一个真实试用',[\s\S]*exact: true/,
  );
  assert.doesNotMatch(source, /recordVideo|tracing\.start|page\.screenshot/);
});
