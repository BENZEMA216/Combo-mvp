#!/usr/bin/env node
/* global HTMLButtonElement, document, setTimeout, window */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { chromium } from 'playwright-core';
import {
  acceptanceEmailAddress,
  takeAcceptanceResendApiKey,
  waitForDeliveredAcceptanceOtp,
} from './resend-sent-email.mjs';

export const GOAL_B_ACCEPTANCE_CHECKS = Object.freeze([
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

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ZERO_SOURCE_SHA = '0'.repeat(40);
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|credential|email|otp|pairing|password|resend|secret|token)/i;
const SENSITIVE_VALUE_PATTERN =
  /(?:bearer\s+[a-z0-9._~-]+|(?:__Host-)?cb_session=|s1\.[A-Za-z0-9_-]{43}|@resend\.dev|set-cookie|pairingCode)/i;
const OTP_VALUE_PATTERN = /^[0-9]{6}$/;
const CHROME_EXECUTABLE = '/usr/bin/google-chrome';
// Runtime 的 index route 会整页返回创作端；不存在的 Session 是稳定、只读且不写业务数据的探针。
const RUNTIME_BADGE_PROBE_PAGE = '/try/session/00000000-0000-4000-8000-000000000000';
const TEST_ORIGIN = 'https://test.43-160-242-46.sslip.io';
const PRODUCTION_ORIGIN = 'https://buildwithcombo.com';
const TASK_TIMEOUT_MS = 15 * 60_000;
const TURN_TIMEOUT_MS = 12 * 60_000;
const POLL_INTERVAL_MS = 1_000;
const MESSAGE_DIAGNOSTIC_TIMEOUT_MS = 5_000;
const TURN_DIAGNOSTIC_CODES = Object.freeze([
  'TURN_ABANDONED',
  'TURN_HISTORY_LOAD_FAILED',
  'TURN_AGENT_UNAVAILABLE',
  'TURN_IDLE_TIMEOUT',
  'TURN_PROMPT_FAILED',
  'TURN_RUNTIME_ERROR',
  'TURN_PERSIST_FAILED',
  'TURN_INTERRUPTED',
  'TURN_SHUTDOWN',
  'TURN_STUDIO_ARTIFACT_MISSING',
  'TURN_FAILED',
  'TURN_COMPLETED_WITHOUT_ARTIFACT',
  'TURN_DETAIL_INVARIANT',
]);
const MESSAGE_SUBMIT_DIAGNOSTIC_CODES = Object.freeze([
  'MESSAGE_REQUEST_NOT_OBSERVED',
  'MESSAGE_REQUEST_FAILED',
  'MESSAGE_REQUEST_COUNT_UNEXPECTED',
  'MESSAGE_RESPONSE_STATUS_UNEXPECTED',
  'MESSAGE_RESPONSE_TIMEOUT_DETAIL_ACTIVE_INTERRUPT_ACCEPTED',
  'MESSAGE_RESPONSE_TIMEOUT_DETAIL_ACTIVE_INTERRUPT_REJECTED',
  'MESSAGE_RESPONSE_TIMEOUT_DETAIL_MESSAGE_COMMITTED',
  'MESSAGE_RESPONSE_TIMEOUT_DETAIL_ABSENT',
  'MESSAGE_RESPONSE_TIMEOUT_DETAIL_CLIENT_REJECTED',
  'MESSAGE_RESPONSE_TIMEOUT_DETAIL_SERVER_REJECTED',
  'MESSAGE_RESPONSE_TIMEOUT_DETAIL_UNEXPECTED_STATUS',
  'MESSAGE_RESPONSE_TIMEOUT_DETAIL_INVALID',
  'MESSAGE_RESPONSE_TIMEOUT_DETAIL_TIMEOUT',
  'MESSAGE_RESPONSE_TIMEOUT_DETAIL_FAILED',
]);
const ACCEPTANCE_DIAGNOSTIC_CODES = Object.freeze([
  ...TURN_DIAGNOSTIC_CODES,
  ...MESSAGE_SUBMIT_DIAGNOSTIC_CODES,
]);
const RELEASE_METADATA_KEYS = Object.freeze([
  'builtAt',
  'environment',
  'releaseId',
  'releaseManifestDigest',
  'schemaVersion',
  'sourceSha',
  'webAssetManifest',
]);

function claudeJsonl(messages, timestamp) {
  return messages
    .map(({ role, text }, index) =>
      JSON.stringify({
        type: role,
        message: { role, content: [{ type: 'text', text }] },
        timestamp: new Date(Date.parse(timestamp) + index * 1_000).toISOString(),
        cwd: '/workspace/goal-b-weekly-report',
      }),
    )
    .join('\n');
}

/** Two complete Claude JSONL sessions; each upload part is independently sniffable and parseable. */
export const GOAL_B_UPLOAD_PARTS = Object.freeze([
  claudeJsonl(
    [
      { role: 'user', text: '每周五我需要把项目进展整理成周报。' },
      {
        role: 'assistant',
        text: '我会收集完成事项、风险、下周计划和待决策事项，再按固定结构输出。',
      },
      { role: 'user', text: '请务必核对负责人、截止日期和风险等级。' },
    ],
    '2026-07-18T09:00:00.000Z',
  ),
  claudeJsonl(
    [
      { role: 'user', text: '又到周五了，请按相同流程整理本周项目进展。' },
      {
        role: 'assistant',
        text: '我会先检查输入，再去重合并进展，标记高风险事项并生成管理层摘要。',
      },
      { role: 'user', text: '输出需要包含摘要、进展、风险、下周计划四区。' },
    ],
    '2026-07-25T09:00:00.000Z',
  ),
]);

export class AcceptanceFailure extends Error {
  constructor(check, reason, statusCode, diagnosticCode, requestCount) {
    super(`${check}:${reason}`);
    this.name = 'AcceptanceFailure';
    this.check = GOAL_B_ACCEPTANCE_CHECKS.includes(check) ? check : 'acceptance_runtime';
    this.reason = [
      'assertion',
      'browser',
      'http_status',
      'invalid_response',
      'timeout',
      'unsafe_input',
    ].includes(reason)
      ? reason
      : 'browser';
    this.statusCode = Number.isInteger(statusCode) ? statusCode : undefined;
    const allowedDiagnostic = ACCEPTANCE_DIAGNOSTIC_CODES.includes(diagnosticCode)
      ? diagnosticCode
      : undefined;
    const boundedRequestCount =
      Number.isInteger(requestCount) && requestCount >= 0 && requestCount <= 100
        ? requestCount
        : undefined;
    const isMessageDiagnostic = MESSAGE_SUBMIT_DIAGNOSTIC_CODES.includes(allowedDiagnostic);
    this.diagnosticCode =
      isMessageDiagnostic && boundedRequestCount === undefined ? undefined : allowedDiagnostic;
    this.requestCount =
      this.diagnosticCode !== undefined && isMessageDiagnostic ? boundedRequestCount : undefined;
  }
}

function fail(check, reason = 'assertion', statusCode, diagnosticCode, requestCount) {
  throw new AcceptanceFailure(check, reason, statusCode, diagnosticCode, requestCount);
}

function ensure(condition, check, reason = 'assertion') {
  if (!condition) fail(check, reason);
}

function validateWebOrigin(raw, environment) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('--web-origin must be an absolute URL');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      '--web-origin must contain only the approved scheme and host with no path, query, or credentials',
    );
  }
  if (environment === 'test') {
    if (parsed.origin !== TEST_ORIGIN) {
      throw new Error('--web-origin must use the exact Test public origin');
    }
  } else if (
    environment === 'preview' &&
    (parsed.protocol !== 'https:' ||
      parsed.hostname !== 'review.43-160-242-46.sslip.io' ||
      parsed.port)
  ) {
    throw new Error('--web-origin must use the exact Preview public origin');
  } else if (environment === 'production' && parsed.origin !== PRODUCTION_ORIGIN) {
    throw new Error('--web-origin must use the exact Production public origin');
  }
  return parsed.origin;
}

function validateOutput(raw) {
  if (!raw || raw.includes('\0')) throw new Error('--output must be a file path');
  const output = resolve(raw);
  if (output === '/' || output === dirname(output)) throw new Error('--output must name a file');
  if (existsSync(output)) throw new Error('--output must not already exist');
  return output;
}

export function parseAcceptanceArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 12) {
    throw new Error(
      'required arguments: --environment test|preview|production --revision <sha> --run-id <id> --run-attempt <attempt> --web-origin <origin> --output <file>',
    );
  }
  const values = new Map();
  const allowed = new Set([
    '--environment',
    '--revision',
    '--run-id',
    '--run-attempt',
    '--web-origin',
    '--output',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== 'string' || value.startsWith('--')) {
      throw new Error('unknown, missing, or malformed argument');
    }
    if (values.has(key)) throw new Error(`duplicate argument: ${key}`);
    values.set(key, value);
  }
  const revision = values.get('--revision');
  if (!revision || !SHA_PATTERN.test(revision)) {
    throw new Error('--revision must be a complete lowercase 40-character commit SHA');
  }
  const environment = values.get('--environment') ?? 'test';
  if (!['test', 'preview', 'production'].includes(environment)) {
    throw new Error('--environment must be test, preview, or production');
  }
  const runId = values.get('--run-id');
  const runAttempt = values.get('--run-attempt');
  if (
    typeof runId !== 'string' ||
    typeof runAttempt !== 'string' ||
    !/^[1-9][0-9]{0,19}$/u.test(runId) ||
    !/^[1-9][0-9]{0,19}$/u.test(runAttempt) ||
    !Number.isSafeInteger(Number(runId)) ||
    !Number.isSafeInteger(Number(runAttempt))
  ) {
    throw new Error('--run-id and --run-attempt must be positive safe decimal integers');
  }
  return {
    environment,
    revision,
    runId,
    runAttempt,
    webOrigin: validateWebOrigin(values.get('--web-origin'), environment),
    output: validateOutput(values.get('--output')),
  };
}

export function classifyAcceptanceMessageProtocol(usageId) {
  if (usageId === undefined) return 'legacy';
  return UUID_PATTERN.test(usageId) ? 'usage-id' : 'invalid';
}

export function isAllowedAcceptanceWebSocket(raw, webOrigin) {
  try {
    const socket = new URL(raw);
    const origin = new URL(webOrigin);
    return (
      socket.protocol === (origin.protocol === 'https:' ? 'wss:' : 'ws:') &&
      socket.hostname === origin.hostname &&
      socket.port === origin.port &&
      !socket.username &&
      !socket.password
    );
  } catch {
    return false;
  }
}

export function isAllowedAcceptanceRequest(raw, webOrigin) {
  try {
    const target = new URL(raw);
    if (['http:', 'https:'].includes(target.protocol)) {
      return target.origin === webOrigin;
    }
    // These schemes do not perform an outbound network request. Blob/data documents remain
    // sandboxed by the browser context; every HTTP(S) subrequest is evaluated again by this gate.
    return ['about:', 'blob:', 'data:'].includes(target.protocol);
  } catch {
    return false;
  }
}

function assertSafeEvidence(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeEvidence(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) throw new Error(`unsafe evidence key at ${path}`);
      assertSafeEvidence(nested, `${path}.${key}`);
    }
    return;
  }
  if (
    typeof value === 'string' &&
    (SENSITIVE_VALUE_PATTERN.test(value) || OTP_VALUE_PATTERN.test(value))
  ) {
    throw new Error(`unsafe evidence value at ${path}`);
  }
}

function optionalUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : undefined;
}

export function isExpectedTestReleaseMetadata(value, revision) {
  return isExpectedReleaseMetadata(value, revision, 'test');
}

export function isExpectedReleaseMetadata(value, revision, environment) {
  if (
    !value ||
    typeof value !== 'object' ||
    !SHA_PATTERN.test(revision ?? '') ||
    revision === ZERO_SOURCE_SHA
  ) {
    return false;
  }
  const keys = Object.keys(value).sort();
  const builtAt = typeof value.builtAt === 'string' ? new Date(value.builtAt) : undefined;
  return (
    JSON.stringify(keys) === JSON.stringify(RELEASE_METADATA_KEYS) &&
    value.schemaVersion === 1 &&
    ['test', 'preview', 'production'].includes(environment) &&
    value.environment === environment &&
    value.sourceSha === revision &&
    value.releaseId === `release-${revision}` &&
    builtAt !== undefined &&
    Number.isFinite(builtAt.getTime()) &&
    builtAt.toISOString() === value.builtAt &&
    DIGEST_PATTERN.test(value.releaseManifestDigest ?? '') &&
    value.releaseManifestDigest !== ZERO_DIGEST &&
    DIGEST_PATTERN.test(value.webAssetManifest ?? '') &&
    value.webAssetManifest !== ZERO_DIGEST
  );
}

function safeRelease(value, revision, environment) {
  if (!isExpectedReleaseMetadata(value, revision, environment)) return undefined;
  const release = {
    environment: value.environment,
    sourceSha: value.sourceSha,
    releaseId: value.releaseId,
    builtAt: value.builtAt,
    releaseManifestDigest: value.releaseManifestDigest,
    webAssetManifest: value.webAssetManifest,
  };
  return release;
}

export function consumeUiSnapshot(detail, sourceArtifactId) {
  if (!detail || !Array.isArray(detail.artifacts) || !UUID_PATTERN.test(sourceArtifactId ?? '')) {
    return undefined;
  }
  const matches = detail.artifacts.filter(
    (artifact) =>
      artifact?.sourceArtifactId === sourceArtifactId && UUID_PATTERN.test(artifact.id ?? ''),
  );
  if (matches.length !== 1 || detail.currentUiArtifactId !== matches[0].id) return undefined;
  return matches[0];
}

export function buildAcceptanceEvidence(state) {
  const checks = Array.isArray(state.checks)
    ? state.checks
        .filter(
          (check) =>
            check &&
            GOAL_B_ACCEPTANCE_CHECKS.includes(check.id) &&
            check.status === 'passed' &&
            Number.isInteger(check.durationMs) &&
            check.durationMs >= 0,
        )
        .map((check) => ({ id: check.id, status: 'passed', durationMs: check.durationMs }))
    : [];
  const resources = Object.fromEntries(
    [
      ['taskId', optionalUuid(state.resources?.taskId)],
      ['capabilityId', optionalUuid(state.resources?.capabilityId)],
      ['studioSessionId', optionalUuid(state.resources?.studioSessionId)],
      ['consumeSessionId', optionalUuid(state.resources?.consumeSessionId)],
    ].filter(([, value]) => value !== undefined),
  );
  const metrics = {
    uploadParts:
      Number.isInteger(state.metrics?.uploadParts) && state.metrics.uploadParts >= 0
        ? state.metrics.uploadParts
        : 0,
    completedStudioRevisions:
      Number.isInteger(state.metrics?.completedStudioRevisions) &&
      state.metrics.completedStudioRevisions >= 0
        ? state.metrics.completedStudioRevisions
        : 0,
  };
  const failure =
    state.failure instanceof AcceptanceFailure
      ? {
          check: state.failure.check,
          reason: state.failure.reason,
          ...(state.failure.statusCode === undefined
            ? {}
            : { statusCode: state.failure.statusCode }),
          ...(state.failure.diagnosticCode === undefined
            ? {}
            : { diagnosticCode: state.failure.diagnosticCode }),
          ...(state.failure.requestCount === undefined
            ? {}
            : { requestCount: state.failure.requestCount }),
        }
      : undefined;
  const release = safeRelease(state.release, state.revision, state.environment ?? 'test');
  const hasAllResources = [
    resources.taskId,
    resources.capabilityId,
    resources.studioSessionId,
    resources.consumeSessionId,
  ].every((value) => typeof value === 'string');
  const evidence = {
    schemaVersion: 1,
    suite: `goal-b-${state.environment ?? 'test'}-browser`,
    environment: state.environment ?? 'test',
    revision: state.revision,
    webOrigin: state.webOrigin,
    workflowRunId: state.workflowRunId,
    workflowRunAttempt: state.workflowRunAttempt,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    status:
      !failure &&
      SHA_PATTERN.test(state.revision ?? '') &&
      Number.isSafeInteger(state.workflowRunId) &&
      state.workflowRunId > 0 &&
      Number.isSafeInteger(state.workflowRunAttempt) &&
      state.workflowRunAttempt > 0 &&
      release !== undefined &&
      hasAllResources &&
      metrics.uploadParts === GOAL_B_UPLOAD_PARTS.length &&
      metrics.completedStudioRevisions >= 2 &&
      checks.length === GOAL_B_ACCEPTANCE_CHECKS.length &&
      GOAL_B_ACCEPTANCE_CHECKS.every((id, index) => checks[index]?.id === id)
        ? 'passed'
        : 'failed',
    checks,
    resources,
    metrics,
    ...(release ? { release } : {}),
    ...(failure ? { failure } : {}),
  };
  assertSafeEvidence(evidence);
  return evidence;
}

export function serializeAcceptanceEvidence(evidence) {
  assertSafeEvidence(evidence);
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

export function writeAcceptanceEvidence(output, evidence) {
  const absolute = isAbsolute(output) ? output : resolve(output);
  if (existsSync(absolute)) throw new Error('evidence output already exists');
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(
      temporary,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, serializeAcceptanceEvidence(evidence), { encoding: 'utf8' });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, absolute);
    unlinkSync(temporary);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function responseData(body, check) {
  if (!body || typeof body !== 'object' || !('data' in body)) fail(check, 'invalid_response');
  return body.data;
}

export async function fetchAcceptanceRequest(context, url, request) {
  try {
    return await context.request.fetch(url, request);
  } catch (error) {
    // A failed GET has no unknown write outcome. Retry exactly once so a
    // transient socket reset cannot discard an otherwise completed Test run.
    // Mutating requests remain single-shot and keep their dedicated recovery.
    if (request.method !== 'GET') throw error;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    return context.request.fetch(url, request);
  }
}

class BrowserApi {
  constructor(context, origin) {
    this.context = context;
    this.origin = origin;
  }

  safeUrl(path) {
    ensure(
      typeof path === 'string' && path.startsWith('/') && !path.startsWith('//'),
      'acceptance_runtime',
      'unsafe_input',
    );
    const url = new URL(path, this.origin);
    ensure(url.origin === this.origin, 'acceptance_runtime', 'unsafe_input');
    return url.href;
  }

  async raw(path, options = {}) {
    const method = options.method ?? 'GET';
    const request = {
      method,
      ...(options.data === undefined ? {} : { data: options.data }),
      failOnStatusCode: false,
      maxRedirects: options.maxRedirects ?? 0,
      timeout: options.timeout ?? 30_000,
      headers: { Accept: options.accept ?? 'application/json', Origin: this.origin },
    };
    const url = this.safeUrl(path);
    return fetchAcceptanceRequest(this.context, url, request);
  }

  async json(check, path, options = {}) {
    const response = await this.raw(path, options);
    if (!(options.expected ?? [200]).includes(response.status())) {
      fail(check, 'http_status', response.status());
    }
    let body;
    try {
      body = await response.json();
    } catch {
      fail(check, 'invalid_response');
    }
    return {
      status: response.status(),
      data: options.envelope === false ? body : responseData(body, check),
    };
  }
}

export async function postRuntimeMessageCompat(api, check, path, text, usageId = randomUUID()) {
  let started = await api.json(check, path, {
    method: 'POST',
    data: { text, usageId },
    expected: [202, 400],
    envelope: false,
  });
  if (started.status === 400) {
    ensure(
      started.data?.error?.userMessage === '输入有点问题，改一下再试。' &&
        started.data?.error?.action === 'change_input' &&
        started.data?.error?.retriable === false,
      check,
      'invalid_response',
    );
    return api.json(check, path, {
      method: 'POST',
      data: { text },
      expected: [202],
    });
  }
  started = { ...started, data: responseData(started.data, check) };
  return started;
}

/**
 * A timed-out browser POST has an unknown write outcome. Inspect only the
 * authenticated Session detail. If that exact prompt owns the active Turn,
 * make one bounded interrupt attempt so a failed acceptance does not leave
 * model work running. Retain no request or response material.
 */
export async function diagnoseTimedOutStudioMessage(api, detailPath, interruptPath, text) {
  try {
    const response = await api.raw(detailPath, { timeout: MESSAGE_DIAGNOSTIC_TIMEOUT_MS });
    const status = response.status();
    if (status >= 400 && status < 500) {
      return 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_CLIENT_REJECTED';
    }
    if (status >= 500 && status < 600) {
      return 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_SERVER_REJECTED';
    }
    if (status !== 200) return 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_UNEXPECTED_STATUS';
    let body;
    try {
      body = await response.json();
    } catch {
      return 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_INVALID';
    }
    const detail = body && typeof body === 'object' ? body.data : undefined;
    if (!detail || !Array.isArray(detail.messages)) {
      return 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_INVALID';
    }
    const acceptedMessage = detail.messages.findLast(
      (message) =>
        message?.role === 'user' &&
        message?.status === 'completed' &&
        textFromMessage(message) === text,
    );
    if (!acceptedMessage) return 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_ABSENT';
    if (
      !UUID_PATTERN.test(acceptedMessage.turnId ?? '') ||
      detail.activeTurn?.id !== acceptedMessage.turnId
    ) {
      return 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_MESSAGE_COMMITTED';
    }
    try {
      const interrupted = await api.raw(interruptPath, {
        method: 'POST',
        data: {},
        timeout: MESSAGE_DIAGNOSTIC_TIMEOUT_MS,
      });
      return interrupted.status() >= 200 && interrupted.status() < 300
        ? 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_ACTIVE_INTERRUPT_ACCEPTED'
        : 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_ACTIVE_INTERRUPT_REJECTED';
    } catch {
      return 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_ACTIVE_INTERRUPT_REJECTED';
    }
  } catch (error) {
    return error?.name === 'TimeoutError'
      ? 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_TIMEOUT'
      : 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_FAILED';
  }
}

async function poll(check, read, accept, timeoutMs, intervalMs = POLL_INTERVAL_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }
  fail(check, 'timeout');
}

/**
 * Runtime 的同文档路由使用 history API 更新地址，不会触发新的文档生命周期事件。
 * 验收器直接轮询当前文档地址，再由后续可见元素和 API 断言验证真实业务状态。
 */
export async function waitForAcceptanceUrl(page, expectation) {
  await page.waitForFunction(
    ({ origin, pathname, pathnamePattern, searchParams = {} }) => {
      const current = new URL(window.location.href);
      return (
        (origin === undefined || current.origin === origin) &&
        (pathname === undefined || current.pathname === pathname) &&
        (pathnamePattern === undefined ||
          new RegExp(pathnamePattern, 'i').test(current.pathname)) &&
        Object.entries(searchParams).every(
          ([name, value]) => current.searchParams.get(name) === value,
        )
      );
    },
    expectation,
    { timeout: 30_000 },
  );
}

export async function settleOwnedAcceptanceTurn({
  check,
  knownTurnId,
  readDetail,
  interrupt,
  timeoutMs = 30_000,
  intervalMs = POLL_INTERVAL_MS,
}) {
  const initial = await readDetail();
  const activeTurnId = initial?.activeTurn?.id;
  const targetTurnId = UUID_PATTERN.test(knownTurnId ?? '') ? knownTurnId : activeTurnId;
  if (!UUID_PATTERN.test(targetTurnId ?? '')) {
    ensure(activeTurnId === null || activeTurnId === undefined, check);
    return initial;
  }
  if (activeTurnId !== targetTurnId) return initial;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // The response can be lost after the server accepted the interrupt. The database state,
    // rather than the response body, is therefore the cleanup authority.
    await interrupt().catch(() => undefined);
    try {
      return await poll(
        check,
        readDetail,
        (detail) => detail?.activeTurn?.id !== targetTurnId,
        timeoutMs,
        intervalMs,
      );
    } catch (error) {
      const latest = await readDetail();
      if (latest?.activeTurn?.id !== targetTurnId) return latest;
      if (attempt === 1) throw error;
    }
  }
  fail(check, 'timeout');
}

function compareRedisStreamIds(left, right) {
  const parse = (value) => {
    if (!/^[0-9]+-[0-9]+$/u.test(value ?? '')) return undefined;
    const [milliseconds, sequence] = value.split('-').map((part) => BigInt(part));
    return { milliseconds, sequence };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  if (a.milliseconds !== b.milliseconds) return a.milliseconds > b.milliseconds ? 1 : -1;
  if (a.sequence !== b.sequence) return a.sequence > b.sequence ? 1 : -1;
  return 0;
}

async function readRuntimeStreamFrame(page, { sessionId, runId, afterId, terminal }) {
  return page.evaluate(
    async ({ path, expectedRunId, resumeAfter, requireTerminal, timeoutMs }) => {
      const controller = new globalThis.AbortController();
      const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await globalThis.fetch(path, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            Accept: 'text/event-stream',
            ...(resumeAfter ? { 'Last-Event-ID': resumeAfter } : {}),
          },
          signal: controller.signal,
        });
        const contentType = response.headers.get('content-type') ?? '';
        if (response.status !== 200 || !contentType.startsWith('text/event-stream')) {
          return { status: response.status, contentType, id: '', eventType: '', runId: '' };
        }
        if (!response.body) {
          return { status: response.status, contentType, id: '', eventType: '', runId: '' };
        }
        const reader = response.body.getReader();
        const decoder = new globalThis.TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const boundary = /\r?\n\r?\n/u.exec(buffer);
            if (!boundary || boundary.index === undefined) break;
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            let id = '';
            let eventName = '';
            const data = [];
            for (const line of frame.split(/\r?\n/u)) {
              if (line.startsWith('id:')) id = line.slice(3).trim();
              else if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            }
            if (!id || data.length === 0) continue;
            let event;
            try {
              event = JSON.parse(data.join('\n'));
            } catch {
              continue;
            }
            const eventType =
              typeof event?.type === 'string'
                ? event.type
                : typeof eventName === 'string'
                  ? eventName
                  : '';
            const eventRunId = typeof event?.runId === 'string' ? event.runId : '';
            const isTerminal = eventType === 'RUN_FINISHED' || eventType === 'RUN_ERROR';
            if (
              eventRunId === expectedRunId &&
              (requireTerminal ? isTerminal : eventType === 'RUN_STARTED')
            ) {
              await reader.cancel();
              return {
                status: response.status,
                contentType,
                id,
                eventType,
                runId: eventRunId,
              };
            }
          }
        }
        return { status: response.status, contentType, id: '', eventType: '', runId: '' };
      } catch {
        return { status: 0, contentType: '', id: '', eventType: '', runId: '' };
      } finally {
        globalThis.clearTimeout(timeout);
      }
    },
    {
      path: `/api/v1/runtime/sessions/${sessionId}/stream`,
      expectedRunId: runId,
      resumeAfter: afterId,
      requireTerminal: terminal,
      timeoutMs: TURN_TIMEOUT_MS,
    },
  );
}

function artifactForTurn(detail, turnId) {
  return Array.isArray(detail?.artifacts)
    ? detail.artifacts.find((artifact) => artifact?.sourceTurnId === turnId)
    : undefined;
}

/**
 * Classify one accepted Studio Turn only from owner-scoped, sanitized SessionDetail state.
 * No provider/model response or persisted last_error.message is accepted by this boundary.
 */
export function classifyStudioTurnDetail(detail, turnId) {
  if (
    !detail ||
    typeof detail !== 'object' ||
    !UUID_PATTERN.test(turnId ?? '') ||
    !Object.hasOwn(detail, 'latestTerminalTurn') ||
    !Array.isArray(detail.artifacts)
  ) {
    return { state: 'failed', diagnosticCode: 'TURN_DETAIL_INVARIANT' };
  }
  const artifact = artifactForTurn(detail, turnId);
  const activeTurn = detail.activeTurn;
  if (activeTurn !== null) {
    if (
      !activeTurn ||
      typeof activeTurn !== 'object' ||
      !UUID_PATTERN.test(activeTurn.id ?? '') ||
      activeTurn.id !== turnId
    ) {
      return { state: 'failed', diagnosticCode: 'TURN_DETAIL_INVARIANT' };
    }
    return { state: 'pending' };
  }

  const terminal = detail.latestTerminalTurn;
  if (
    !terminal ||
    typeof terminal !== 'object' ||
    terminal.id !== turnId ||
    !['completed', 'failed', 'interrupted'].includes(terminal.status)
  ) {
    return { state: 'failed', diagnosticCode: 'TURN_DETAIL_INVARIANT' };
  }
  if (terminal.status === 'completed') {
    if (terminal.errorCode !== null) {
      return { state: 'failed', diagnosticCode: 'TURN_DETAIL_INVARIANT' };
    }
    return artifact
      ? { state: 'completed' }
      : { state: 'failed', diagnosticCode: 'TURN_COMPLETED_WITHOUT_ARTIFACT' };
  }
  if (!TURN_DIAGNOSTIC_CODES.includes(terminal.errorCode)) {
    return { state: 'failed', diagnosticCode: 'TURN_DETAIL_INVARIANT' };
  }
  return { state: 'failed', diagnosticCode: terminal.errorCode };
}

function requireSafeStudioTurnClassification(check, detail, turnId) {
  const classification = classifyStudioTurnDetail(detail, turnId);
  if (classification.state === 'failed') {
    fail(check, 'invalid_response', undefined, classification.diagnosticCode);
  }
  return classification;
}

async function waitForStudioRevision(check, turnId, readDetail) {
  return poll(
    check,
    readDetail,
    (detail) => {
      const classification = requireSafeStudioTurnClassification(check, detail, turnId);
      return classification.state === 'completed';
    },
    TURN_TIMEOUT_MS,
  );
}

function sortedChronologically(artifacts) {
  return artifacts.every((artifact, index) => {
    if (index === 0) return Number.isFinite(Date.parse(artifact.createdAt));
    return (
      Number.isFinite(Date.parse(artifact.createdAt)) &&
      Date.parse(artifact.createdAt) >= Date.parse(artifacts[index - 1].createdAt)
    );
  });
}

function textFromMessage(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && typeof block === 'object' && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

async function authenticateWithEmailOtp({
  api,
  context,
  email,
  returnTo,
  resendApiKey,
  secureCookie,
  check,
}) {
  const requestedAt = new Date();
  const challenge = await api.json(check, '/api/v1/auth/email/challenges', {
    method: 'POST',
    data: { email },
    expected: [202],
  });
  ensure(
    challenge.data?.accepted === true &&
      challenge.data?.expiresInSeconds === 300 &&
      challenge.data?.resendAfterSeconds === 60,
    check,
    'invalid_response',
  );
  let code = await waitForDeliveredAcceptanceOtp({
    apiKey: resendApiKey,
    recipient: email,
    notBefore: requestedAt,
  });
  let verification;
  try {
    verification = await api.json(check, '/api/v1/auth/email/verifications', {
      method: 'POST',
      data: { email, code, returnTo },
    });
  } finally {
    code = undefined;
  }
  ensure(
    verification.data?.returnTo === returnTo &&
      UUID_PATTERN.test(verification.data?.user?.id ?? '') &&
      verification.data?.user?.email?.toLowerCase() === email.toLowerCase() &&
      JSON.stringify(verification.data?.user?.roles) === '["creator"]',
    check,
    'invalid_response',
  );
  const me = await api.json(check, '/api/v1/me');
  ensure(
    me.data?.id === verification.data.user.id &&
      me.data?.email?.toLowerCase() === email.toLowerCase() &&
      JSON.stringify(me.data?.roles) === '["creator"]',
    check,
  );
  const expectedCookieName = secureCookie ? '__Host-cb_session' : 'cb_session';
  const cookies = await context.cookies();
  const sessionCookie = cookies.find((candidate) => candidate.name === expectedCookieName);
  ensure(
    sessionCookie?.httpOnly === true &&
      sessionCookie.secure === secureCookie &&
      sessionCookie.sameSite === 'Lax' &&
      typeof sessionCookie.value === 'string' &&
      /^s1\.[A-Za-z0-9_-]{43}$/u.test(sessionCookie.value),
    check,
  );
  ensure(
    !cookies.some((cookie) =>
      ['cb_refresh', 'cb_auth_tx', secureCookie ? 'cb_session' : '__Host-cb_session'].includes(
        cookie.name,
      ),
    ),
    check,
  );
  return {
    identity: { id: me.data.id, email: me.data.email },
    sessionCookie: sessionCookie.value,
  };
}

async function runAcceptance(options) {
  const secureCookie = new URL(options.webOrigin).protocol === 'https:';
  const state = {
    environment: options.environment,
    revision: options.revision,
    webOrigin: options.webOrigin,
    workflowRunId: Number(options.runId),
    workflowRunAttempt: Number(options.runAttempt),
    startedAt: new Date().toISOString(),
    completedAt: '',
    checks: [],
    resources: {},
    metrics: { uploadParts: 0, completedStudioRevisions: 0 },
    release: undefined,
    failure: undefined,
  };
  let activeCheck = 'acceptance_runtime';
  let browser;
  let resendApiKey;
  let authenticatedIdentity;
  let authenticationCookieValue;
  const checked = async (id, operation) => {
    activeCheck = id;
    const started = Date.now();
    await operation();
    state.checks.push({ id, status: 'passed', durationMs: Date.now() - started });
    process.stdout.write(`PASS ${id}\n`);
  };

  try {
    resendApiKey = takeAcceptanceResendApiKey();
    ensure(existsSync(CHROME_EXECUTABLE), activeCheck, 'browser');
    browser = await chromium.launch({ executablePath: CHROME_EXECUTABLE, headless: true });
    const context = await browser.newContext({
      baseURL: options.webOrigin,
      acceptDownloads: false,
      serviceWorkers: 'block',
      ...(options.environment === 'production' ? { locale: 'en-US' } : {}),
    });
    if (options.environment === 'preview') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: options.webOrigin,
      });
      const unauthenticatedVersion = await context.request.get(
        `${options.webOrigin}/version.json`,
        {
          failOnStatusCode: false,
          maxRedirects: 0,
        },
      );
      ensure(unauthenticatedVersion.status() === 200, activeCheck, 'http_status');
      const unauthenticatedPage = await context.request.get(`${options.webOrigin}/capabilities`, {
        headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' },
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      ensure(unauthenticatedPage.status() === 200, activeCheck, 'http_status');
      ensure(
        unauthenticatedPage.headers()['content-type']?.includes('text/html') === true &&
          (await unauthenticatedPage.text()).includes('id="root"'),
        activeCheck,
        'invalid_response',
      );
      const unauthenticatedApi = await context.request.get(`${options.webOrigin}/api/v1/me`, {
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      ensure(unauthenticatedApi.status() === 401, activeCheck, 'http_status');
      ensure(
        !(await context.cookies(options.webOrigin)).some(
          (cookie) => cookie.name === 'combo_review_access',
        ),
        activeCheck,
      );
    }
    await context.route('**/*', async (route) => {
      if (isAllowedAcceptanceRequest(route.request().url(), options.webOrigin)) {
        await route.continue();
      } else {
        await route.abort('blockedbyclient');
      }
    });
    await context.routeWebSocket('**/*', async (socket) => {
      if (isAllowedAcceptanceWebSocket(socket.url(), options.webOrigin)) {
        socket.connectToServer();
      } else {
        await socket.close({ code: 1008, reason: 'acceptance origin boundary' });
      }
    });
    const page = await context.newPage();
    const api = new BrowserApi(context, options.webOrigin);

    await checked('release_identity', async () => {
      const root = await api.json('release_identity', '/runtime-config.json', { envelope: false });
      const runtime = await api.json('release_identity', '/try/runtime-config.json', {
        envelope: false,
      });
      const version = await api.json('release_identity', '/version.json', { envelope: false });
      for (const metadata of [root.data, runtime.data, version.data]) {
        ensure(
          isExpectedReleaseMetadata(metadata, options.revision, options.environment),
          'release_identity',
        );
      }
      ensure(JSON.stringify(root.data) === JSON.stringify(runtime.data), 'release_identity');
      ensure(JSON.stringify(root.data) === JSON.stringify(version.data), 'release_identity');
      state.release = root.data;
    });

    await checked('hashed_asset_404', async () => {
      for (const prefix of ['/assets/', '/try/assets/']) {
        const response = await api.raw(
          `${prefix}goal-b-missing-${options.revision.slice(0, 12)}.js`,
          { accept: '*/*' },
        );
        ensure(response.status() === 404, 'hashed_asset_404', 'http_status');
      }
    });

    await checked('email_otp_login', async () => {
      for (const [path, method] of [
        ['/api/v1/auth/login', 'GET'],
        ['/api/v1/auth/callback', 'GET'],
        ['/api/v1/auth/refresh', 'POST'],
        ['/api/v1/auth/dev-login', 'POST'],
      ]) {
        const legacy = await api.raw(path, { method, ...(method === 'POST' ? { data: {} } : {}) });
        ensure(legacy.status() === 404, activeCheck, 'http_status');
      }
      const authenticated = await authenticateWithEmailOtp({
        api,
        context,
        email: acceptanceEmailAddress(
          options.environment,
          options.revision,
          options.runId,
          options.runAttempt,
          'primary',
        ),
        returnTo: '/tasks',
        resendApiKey,
        secureCookie,
        check: activeCheck,
      });
      authenticatedIdentity = authenticated.identity;
      authenticationCookieValue = authenticated.sessionCookie;
    });

    await checked('preview_identity_badge_and_copy', async () => {
      const verifyBadge = async (path, contextHeading, expectedPage, mountedSelector) => {
        const navigation = await page.goto(path, { waitUntil: 'domcontentloaded' });
        if (navigation?.status() !== 200) {
          fail(activeCheck, 'http_status', navigation?.status());
        }
        await page.locator(mountedSelector).first().waitFor({
          state: 'visible',
          timeout: 30_000,
        });
        ensure(new URL(page.url()).pathname === expectedPage, activeCheck);
        const badge = page.locator('aside[aria-label="Preview 发布身份"]');
        if (options.environment !== 'preview') {
          ensure((await badge.count()) === 0, activeCheck);
          return;
        }
        await badge.waitFor({ state: 'visible', timeout: 30_000 });
        const trigger = badge.locator('button[aria-controls]');
        ensure(
          (await trigger.count()) === 1 &&
            (await trigger.getAttribute('aria-expanded')) === 'false' &&
            (await trigger.textContent())?.includes(options.revision.slice(0, 8)),
          activeCheck,
        );
        await trigger.click();
        const panel = page.getByRole('region', { name: 'Preview 发布详情' });
        await panel.waitFor({ state: 'visible', timeout: 10_000 });
        const panelText = (await panel.textContent()) ?? '';
        ensure(
          panelText.includes('preview') &&
            panelText.includes(options.revision) &&
            panelText.includes(state.release.releaseId) &&
            panelText.includes(state.release.webAssetManifest),
          activeCheck,
        );
        await panel.getByRole('button', { name: '复制验收上下文' }).click();
        await panel.getByRole('status').filter({ hasText: '验收上下文已复制' }).waitFor({
          state: 'visible',
          timeout: 10_000,
        });
        const copied = await page.evaluate(() => globalThis.navigator.clipboard.readText());
        ensure(
          copied.startsWith(contextHeading) &&
            copied.includes('environment=preview') &&
            copied.includes(`sourceSha=${options.revision}`) &&
            copied.includes(`releaseId=${state.release.releaseId}`) &&
            copied.includes(`releaseManifestDigest=${state.release.releaseManifestDigest}`) &&
            copied.includes(`webAssetManifest=${state.release.webAssetManifest}`) &&
            copied.includes(`page=${options.webOrigin}${expectedPage}`) &&
            !copied.includes('acceptance=hidden') &&
            !copied.includes('#secret'),
          activeCheck,
        );
      };
      await verifyBadge(
        '/tasks?acceptance=hidden#secret',
        'Combo Preview acceptance context',
        '/tasks',
        '.cb-shell, .cb-auth-gate',
      );
      await verifyBadge(
        `${RUNTIME_BADGE_PROBE_PAGE}?acceptance=hidden#secret`,
        'Combo Runtime Preview acceptance context',
        RUNTIME_BADGE_PROBE_PAGE,
        '.rt-shell, .rt-auth-gate',
      );
      await page.goto('/tasks', { waitUntil: 'domcontentloaded' });
    });

    const idempotencyKey = `goal-b-${options.revision}-${Date.now()}`;
    let task;
    let pairingCode;
    await checked('creation_idempotency', async () => {
      const body = {
        idempotencyKey,
        description: `Goal B Test ${options.revision.slice(0, 12)}`,
      };
      const first = await api.json('creation_idempotency', '/api/v1/tasks', {
        method: 'POST',
        data: body,
        expected: [201],
      });
      const replay = await api.json('creation_idempotency', '/api/v1/tasks', {
        method: 'POST',
        data: body,
        expected: [200],
      });
      task = first.data?.task;
      const initialPairingCode = first.data?.pairingCode;
      ensure(UUID_PATTERN.test(task?.id ?? ''), 'creation_idempotency');
      ensure(replay.data?.task?.id === task.id, 'creation_idempotency');
      pairingCode = replay.data?.pairingCode;
      ensure(
        typeof initialPairingCode === 'string' &&
          initialPairingCode.length > 0 &&
          typeof pairingCode === 'string' &&
          pairingCode.length > 0 &&
          pairingCode !== initialPairingCode,
        'creation_idempotency',
      );
      state.resources.taskId = task.id;
    });

    const uploadParts = GOAL_B_UPLOAD_PARTS;
    const bundleId = createHash('sha256').update(uploadParts.join('\n')).digest('hex');
    await checked('authoring_prepare', async () => {
      const prepared = await api.json('authoring_prepare', '/api/v1/connect/prepare', {
        method: 'POST',
        data: {
          pairingCode,
          protocolVersion: 2,
          bundleId,
          totalParts: uploadParts.length,
          replaceExisting: false,
        },
      });
      ensure(
        prepared.data?.complete === false &&
          Array.isArray(prepared.data?.landedParts) &&
          prepared.data.landedParts.length === 0,
        'authoring_prepare',
      );
      const firstPart = await api.json('authoring_prepare', '/api/v1/connect/upload', {
        method: 'POST',
        data: {
          pairingCode,
          bundleId,
          partIndex: 0,
          totalParts: uploadParts.length,
          content: uploadParts[0],
        },
      });
      ensure(firstPart.data?.landed === 1 && firstPart.data?.complete === false, activeCheck);
    });

    await checked('authoring_resume_after_reload', async () => {
      const resumed = await api.json(activeCheck, '/api/v1/connect/prepare', {
        method: 'POST',
        data: {
          pairingCode,
          protocolVersion: 2,
          bundleId,
          totalParts: uploadParts.length,
          replaceExisting: false,
        },
      });
      ensure(
        resumed.data?.complete === false && JSON.stringify(resumed.data?.landedParts) === '[0]',
        activeCheck,
      );
      await page.goto(`/tasks/${task.id}`, { waitUntil: 'domcontentloaded' });
      const waitForProgress = () =>
        page.waitForFunction(
          ({ expectedPath }) =>
            window.location.pathname === expectedPath && document.body.innerText.includes('1 / 2'),
          { expectedPath: `/tasks/${task.id}` },
          { timeout: 30_000 },
        );
      await waitForProgress();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForProgress();
    });

    let capability;
    await checked('authoring_upload_terminal', async () => {
      const finalPart = await api.json(activeCheck, '/api/v1/connect/upload', {
        method: 'POST',
        data: {
          pairingCode,
          bundleId,
          partIndex: 1,
          totalParts: uploadParts.length,
          content: uploadParts[1],
        },
      });
      pairingCode = undefined;
      ensure(finalPart.data?.landed === 2 && finalPart.data?.complete === true, activeCheck);
      state.metrics.uploadParts = uploadParts.length;
      task = await poll(
        activeCheck,
        async () => (await api.json(activeCheck, `/api/v1/tasks/${task.id}`)).data,
        (candidate) => candidate?.status === 'succeeded' || candidate?.status === 'failed',
        TASK_TIMEOUT_MS,
      );
      ensure(
        task.status === 'succeeded' &&
          task.currentStep === 'extract' &&
          task.upload?.status === 'processed' &&
          task.upload?.partsExpected === 2 &&
          task.upload?.partsLanded === 2,
        activeCheck,
      );
      const capabilities = await api.json(
        activeCheck,
        `/api/v1/capabilities?taskId=${encodeURIComponent(task.id)}&limit=100`,
      );
      ensure(Array.isArray(capabilities.data) && capabilities.data.length > 0, activeCheck);
      capability = capabilities.data.find((candidate) => candidate?.published === false);
      ensure(
        UUID_PATTERN.test(capability?.id ?? '') &&
          typeof capability?.name === 'string' &&
          capability.name.length > 0,
        activeCheck,
      );
      state.resources.capabilityId = capability.id;
    });

    await checked('creation_capability_selection', async () => {
      await page.goto(`/tasks/${task.id}`, { waitUntil: 'domcontentloaded' });
      await page
        .getByRole('heading', { name: 'Agent 已准备好，先选一个真实试用', exact: true })
        .waitFor({
          state: 'visible',
          timeout: 30_000,
        });
      const list = page.getByRole('list', { name: 'Agent 提取结果' });
      const releasePricingPath = `/capabilities/${encodeURIComponent(capability.id)}/release/pricing`;
      const continueLink = page.locator(`a[href="${releasePricingPath}"]`);
      await continueLink.waitFor({ state: 'visible', timeout: 30_000 });
      ensure((await continueLink.count()) === 1, activeCheck);
      const row = list.locator('li.cb-cap-card').filter({ has: continueLink });
      await row.waitFor({ state: 'visible', timeout: 30_000 });
      ensure(
        (await row.count()) === 1 &&
          (await row.getAttribute('data-status')) === 'ready' &&
          (await row.getByText(capability.name, { exact: true }).count()) === 1 &&
          ((await continueLink.textContent()) ?? '').includes('继续完善') &&
          (await row.getByRole('checkbox').count()) === 0,
        activeCheck,
      );
      await continueLink.click();
      await waitForAcceptanceUrl(page, {
        pathname: `/capabilities/${capability.id}/release/pricing`,
      });
      await page
        .getByRole('heading', { name: '这个 Agent 如何收费？', exact: true })
        .waitFor({ state: 'visible', timeout: 30_000 });
    });

    await checked('creation_publish_and_retry_fence', async () => {
      const releaseHandle = `goal-b-${capability.id.replaceAll('-', '').slice(0, 12)}`;
      ensure(
        releaseHandle.length <= 32 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(releaseHandle),
        activeCheck,
        'unsafe_input',
      );

      await page.getByRole('radio', { name: /单次定价/ }).check();
      await page.getByRole('spinbutton', { name: '每次使用价格' }).fill('9.9');
      await page.getByRole('button', { name: /下一步：命名/ }).click();
      await waitForAcceptanceUrl(page, {
        pathname: `/capabilities/${capability.id}/release/identity`,
      });
      await page
        .getByRole('heading', { name: '给 Agent 一个容易分享的名字', exact: true })
        .waitFor({ state: 'visible', timeout: 30_000 });
      await page.getByRole('textbox', { name: '自定义子域名' }).fill(releaseHandle);
      await page.getByRole('button', { name: /下一步：确认发布/ }).click();
      await waitForAcceptanceUrl(page, {
        pathname: `/capabilities/${capability.id}/release/review`,
      });
      await page
        .getByRole('heading', { name: '确认后开放 Agent 试用', exact: true })
        .waitFor({ state: 'visible', timeout: 30_000 });
      await page.getByRole('checkbox', { name: /定价与域名仍只是本机草稿/ }).check();
      const publishResponse = page.waitForResponse(
        (response) =>
          response.url() ===
            `${options.webOrigin}/api/v1/capabilities/${encodeURIComponent(capability.id)}/publish` &&
          response.request().method() === 'POST',
        { timeout: 30_000 },
      );
      await page.getByRole('button', { name: '开放试用并保存草稿 →', exact: true }).click();
      const response = await publishResponse;
      ensure(response.status() === 200, activeCheck, 'http_status');
      let body;
      try {
        body = await response.json();
      } catch {
        fail(activeCheck, 'invalid_response');
      }
      ensure(
        responseData(body, activeCheck)?.id === capability.id &&
          responseData(body, activeCheck)?.published === true,
        activeCheck,
      );
      await waitForAcceptanceUrl(page, {
        pathname: `/capabilities/${capability.id}/release/success`,
      });
      await page
        .getByRole('heading', {
          name: 'Agent 已开放试用，可以继续迭代',
          exact: true,
        })
        .waitFor({ state: 'visible', timeout: 30_000 });

      const published = await api.json(activeCheck, `/api/v1/capabilities/${capability.id}`);
      ensure(
        published.data?.id === capability.id && published.data?.published === true,
        activeCheck,
      );
      const retry = await api.raw(`/api/v1/tasks/${task.id}/retry`, { method: 'POST' });
      ensure(retry.status() === 409, activeCheck, 'http_status');

      const failedTaskResponse = await api.json(activeCheck, '/api/v1/tasks', {
        method: 'POST',
        data: {
          idempotencyKey: `goal-b-retry-${options.revision}-${Date.now()}`,
          description: `Goal B retry ${options.revision.slice(0, 12)}`,
        },
        expected: [201],
      });
      const failedTask = failedTaskResponse.data?.task;
      let failedPairingCode = failedTaskResponse.data?.pairingCode;
      ensure(
        UUID_PATTERN.test(failedTask?.id ?? '') &&
          typeof failedPairingCode === 'string' &&
          failedPairingCode.length > 0,
        activeCheck,
      );
      const emptyContent = ' ';
      const failedBundleId = createHash('sha256').update(emptyContent).digest('hex');
      await api.json(activeCheck, '/api/v1/connect/prepare', {
        method: 'POST',
        data: {
          pairingCode: failedPairingCode,
          protocolVersion: 2,
          bundleId: failedBundleId,
          totalParts: 1,
          replaceExisting: false,
        },
      });
      await api.json(activeCheck, '/api/v1/connect/upload', {
        method: 'POST',
        data: {
          pairingCode: failedPairingCode,
          bundleId: failedBundleId,
          partIndex: 0,
          totalParts: 1,
          content: emptyContent,
        },
      });
      failedPairingCode = undefined;
      const firstFailure = await poll(
        activeCheck,
        async () => (await api.json(activeCheck, `/api/v1/tasks/${failedTask.id}`)).data,
        (candidate) => candidate?.status === 'failed',
        TASK_TIMEOUT_MS,
      );
      ensure(firstFailure.currentStep === 'extract' && firstFailure.retryCount === 0, activeCheck);
      const acceptedRetry = await api.json(activeCheck, `/api/v1/tasks/${failedTask.id}/retry`, {
        method: 'POST',
      });
      ensure(
        acceptedRetry.data?.status === 'running' && acceptedRetry.data?.retryCount === 1,
        activeCheck,
      );
      const secondFailure = await poll(
        activeCheck,
        async () => (await api.json(activeCheck, `/api/v1/tasks/${failedTask.id}`)).data,
        (candidate) => candidate?.status === 'failed' && candidate?.retryCount === 1,
        TASK_TIMEOUT_MS,
      );
      ensure(secondFailure.currentStep === 'extract', activeCheck);

      await page.goto(`/tasks/${task.id}`, { waitUntil: 'domcontentloaded' });
      await page
        .getByRole('heading', { name: 'Agent 已准备好，先选一个真实试用', exact: true })
        .waitFor({ state: 'visible', timeout: 30_000 });
    });

    let studioSession;
    await checked('studio_entry', async () => {
      const created = await api.json(activeCheck, '/api/v1/runtime/studio/sessions', {
        method: 'POST',
        data: { capabilityId: capability.id },
      });
      studioSession = created.data?.session;
      ensure(
        UUID_PATTERN.test(studioSession?.id ?? '') && studioSession?.mode === 'studio',
        activeCheck,
      );
      state.resources.studioSessionId = studioSession.id;
      await page.goto(`/try/session/${studioSession.id}?mode=studio`, {
        waitUntil: 'domcontentloaded',
      });
      await page.getByRole('complementary', { name: 'UI 设计对话' }).waitFor({
        state: 'visible',
        timeout: 30_000,
      });
    });

    const composer = page.locator('.rt-conversation-composer textarea');
    const messagePath = `/api/v1/runtime/sessions/${studioSession.id}/messages`;
    const messageUrl = `${options.webOrigin}${messagePath}`;
    let studioMessageProtocol;
    let resolvedUncertainUsageId;
    await checked('studio_failed_send_retains_draft', async () => {
      const draft = 'Goal B 网络失败后必须保留的草稿';
      let uncertainUsageId;
      let uncertainText;
      let retryUsageId;
      let retryText;
      let injectedPhase = 'reject-503';
      let unexpectedInjectedRequests = 0;
      await composer.fill(draft);
      // Keep one route for the complete injected-failure sequence. It catches
      // unexpected duplicate retries instead of letting them reach Runtime.
      await page.route(messageUrl, async (route) => {
        let submitted;
        try {
          submitted = route.request().postDataJSON();
        } catch {
          submitted = undefined;
        }
        if (injectedPhase === 'reject-503') {
          injectedPhase = 'await-retry';
          uncertainUsageId = submitted?.usageId;
          uncertainText = submitted?.text;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'DEPENDENCY_UNAVAILABLE', userMessage: '暂时不可用' },
            }),
          });
          return;
        }
        if (injectedPhase === 'reject-400') {
          injectedPhase = 'done';
          retryUsageId = submitted?.usageId;
          retryText = submitted?.text;
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'VALIDATION_ERROR',
                userMessage: '输入有点问题，改一下再试。',
                action: 'change_input',
                retriable: false,
              },
            }),
          });
          return;
        }
        unexpectedInjectedRequests += 1;
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'IDEMPOTENCY_CONFLICT', userMessage: '请求状态冲突。' },
          }),
        });
      });
      const rejectedResponse = page.waitForResponse(
        (response) => response.url() === messageUrl && response.request().method() === 'POST',
        { timeout: 30_000 },
      );
      await page.getByRole('button', { name: '生成第一版 UI' }).click();
      ensure((await rejectedResponse).status() === 503, activeCheck, 'http_status');
      await page.getByRole('alert').filter({ hasText: '暂时不可用' }).waitFor({
        state: 'visible',
        timeout: 10_000,
      });
      ensure((await composer.inputValue()) === draft, activeCheck);
      ensure(
        injectedPhase === 'await-retry' && uncertainText === draft,
        activeCheck,
        'invalid_response',
      );

      // Billing-aware clients keep an unknown-write usageId after a 5xx and
      // intentionally block a different task. Resolve that exact retry with a
      // definitive validation response before the shared acceptance continues.
      // Legacy clients do not expose this recovery action, so the same trusted
      // controller remains compatible with the current main release.
      const retryButton = page.getByRole('button', { name: '重试原任务' });
      studioMessageProtocol = classifyAcceptanceMessageProtocol(uncertainUsageId);
      ensure(studioMessageProtocol !== 'invalid', activeCheck, 'invalid_response');
      resolvedUncertainUsageId = uncertainUsageId;
      if (studioMessageProtocol === 'usage-id') {
        await retryButton.waitFor({ state: 'visible', timeout: 10_000 });
        injectedPhase = 'reject-400';
        const retryResponse = page.waitForResponse(
          (response) => response.url() === messageUrl && response.request().method() === 'POST',
          { timeout: 30_000 },
        );
        await retryButton.click();
        ensure((await retryResponse).status() === 400, activeCheck, 'http_status');
        await page.getByRole('alert').filter({ hasText: '输入有点问题' }).waitFor({
          state: 'visible',
          timeout: 10_000,
        });
        await retryButton.waitFor({ state: 'hidden', timeout: 10_000 });
        ensure((await composer.inputValue()) === draft, activeCheck);
        ensure(
          injectedPhase === 'done' &&
            retryUsageId === resolvedUncertainUsageId &&
            retryText === uncertainText,
          activeCheck,
          'invalid_response',
        );
      } else {
        ensure(!(await retryButton.isVisible()), activeCheck, 'invalid_response');
      }
      await page.unrouteAll({ behavior: 'wait' });
      ensure(unexpectedInjectedRequests === 0, activeCheck, 'invalid_response');
    });

    let firstTurnId;
    await checked('studio_single_accept_and_clear', async () => {
      const prompt = [
        '生成一个完整、可直接运行的单页 HTML 项目周报工作台。',
        '必须使用 upsert_artifact 保存 kind=html 的完整 HTML 文档。',
        '页面至少有一个 h1 和一个 button，并分别设置 data-combo-key="report-title" 与 data-combo-key="report-action"。',
        '界面需要有摘要、进展、风险、下周计划四区，不加载任何外部资源。',
      ].join('\n');
      await composer.fill(prompt);
      let requestCount = 0;
      let targetRequestFailed = false;
      let submittedText;
      let submittedUsageId;
      const countMessageRequest = (request) => {
        if (request.url() === messageUrl && request.method() === 'POST') {
          requestCount = Math.min(100, requestCount + 1);
        }
      };
      const observeMessageRequestFailure = (request) => {
        if (request.url() === messageUrl && request.method() === 'POST') {
          // Do not retain Playwright's raw failure text: it can contain transport
          // details outside the evidence allowlist.
          targetRequestFailed = true;
        }
      };
      page.on('request', countMessageRequest);
      page.on('requestfailed', observeMessageRequestFailure);
      try {
        // Observe the real request without intercepting it. This avoids a route
        // update race after the injected failure and cannot delay the Runtime.
        const sendButton = page.getByRole('button', { name: '生成第一版 UI' });
        await page.waitForFunction(
          () => {
            const button = document.querySelector('button[aria-label="生成第一版 UI"]');
            return button instanceof HTMLButtonElement && !button.disabled;
          },
          undefined,
          { timeout: 10_000 },
        );
        const requestPromise = page.waitForRequest(
          (request) => request.url() === messageUrl && request.method() === 'POST',
          { timeout: 10_000 },
        );
        const responsePromise = page.waitForResponse(
          (response) => response.url() === messageUrl && response.request().method() === 'POST',
          { timeout: 30_000 },
        );
        await sendButton.evaluate((button) => {
          if (!(button instanceof HTMLButtonElement)) throw new Error('missing send button');
          button.click();
          button.click();
        });
        let observedRequest;
        try {
          observedRequest = await requestPromise;
        } catch (error) {
          if (error?.name === 'TimeoutError') {
            void responsePromise.catch(() => undefined);
            throw new AcceptanceFailure(
              activeCheck,
              'timeout',
              undefined,
              'MESSAGE_REQUEST_NOT_OBSERVED',
              requestCount,
            );
          }
          throw error;
        }
        try {
          const submitted = observedRequest.postDataJSON();
          submittedText = submitted?.text;
          submittedUsageId = submitted?.usageId;
        } catch {
          submittedText = undefined;
          submittedUsageId = undefined;
        }
        ensure(
          submittedText === prompt &&
            (studioMessageProtocol === 'legacy'
              ? submittedUsageId === undefined
              : studioMessageProtocol === 'usage-id' &&
                UUID_PATTERN.test(submittedUsageId ?? '') &&
                submittedUsageId !== resolvedUncertainUsageId),
          activeCheck,
          'invalid_response',
        );
        let response;
        try {
          response = await responsePromise;
        } catch (error) {
          if (error?.name !== 'TimeoutError') throw error;
          const detailDiagnostic = await diagnoseTimedOutStudioMessage(
            api,
            `/api/v1/runtime/sessions/${studioSession.id}`,
            `/api/v1/runtime/sessions/${studioSession.id}/interrupt`,
            submittedText,
          );
          throw new AcceptanceFailure(
            activeCheck,
            'timeout',
            undefined,
            targetRequestFailed ? 'MESSAGE_REQUEST_FAILED' : detailDiagnostic,
            requestCount,
          );
        }
        if (response.status() !== 202) {
          throw new AcceptanceFailure(
            activeCheck,
            'http_status',
            response.status(),
            'MESSAGE_RESPONSE_STATUS_UNEXPECTED',
            requestCount,
          );
        }
        let body;
        try {
          body = await response.json();
        } catch {
          fail(activeCheck, 'invalid_response');
        }
        firstTurnId = responseData(body, activeCheck)?.message?.turnId;
        ensure(UUID_PATTERN.test(firstTurnId ?? ''), activeCheck);
        await page.waitForFunction(
          () => document.querySelector('.rt-conversation-composer textarea')?.value === '',
          undefined,
          { timeout: 10_000 },
        );
        await page.waitForTimeout(250);
        if (requestCount !== 1) {
          throw new AcceptanceFailure(
            activeCheck,
            'invalid_response',
            undefined,
            'MESSAGE_REQUEST_COUNT_UNEXPECTED',
            requestCount,
          );
        }
      } finally {
        page.off('request', countMessageRequest);
        page.off('requestfailed', observeMessageRequestFailure);
      }
    });

    await checked('studio_active_turn_reload', async () => {
      const observed = await poll(
        activeCheck,
        async () =>
          (await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`)).data,
        (detail) => {
          const classification = requireSafeStudioTurnClassification(
            activeCheck,
            detail,
            firstTurnId,
          );
          return classification.state === 'pending' || classification.state === 'completed';
        },
        20_000,
      );
      ensure(
        observed.activeTurn?.id === firstTurnId || Boolean(artifactForTurn(observed, firstTurnId)),
        activeCheck,
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      const restored = await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`);
      requireSafeStudioTurnClassification(activeCheck, restored.data, firstTurnId);
      await page.getByRole('complementary', { name: 'UI 设计对话' }).waitFor({
        state: 'visible',
        timeout: 30_000,
      });
      await poll(
        activeCheck,
        async () => ({
          detail: (await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`))
            .data,
          uiShowsRunning: await page.getByRole('button', { name: '停止当前修改' }).isVisible(),
          uiShowsArtifact: await page.locator('iframe.rt-artifact__frame').isVisible(),
        }),
        ({ detail, uiShowsRunning, uiShowsArtifact }) => {
          const classification = requireSafeStudioTurnClassification(
            activeCheck,
            detail,
            firstTurnId,
          );
          return classification.state === 'pending'
            ? uiShowsRunning
            : uiShowsArtifact && Boolean(artifactForTurn(detail, firstTurnId));
        },
        30_000,
      );
    });

    let firstArtifact;
    let firstDetail;
    await checked('studio_first_revision', async () => {
      firstDetail = await waitForStudioRevision(
        activeCheck,
        firstTurnId,
        async () =>
          (await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`)).data,
      );
      firstArtifact = artifactForTurn(firstDetail, firstTurnId);
      ensure(firstArtifact?.kind === 'html', activeCheck);
      ensure(firstDetail.currentUiArtifactId === firstArtifact.id, activeCheck);
      ensure(sortedChronologically(firstDetail.artifacts), activeCheck);
    });

    await checked('studio_element_selection', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const selectionButton = page.getByRole('button', { name: '选择页面元素' });
      await selectionButton.waitFor({ state: 'visible', timeout: 30_000 });
      await selectionButton.click();
      await page.waitForFunction(() => document.body.innerText.includes('个可选元素'), undefined, {
        timeout: 30_000,
      });
      const artifactFrame = page.locator('iframe.rt-artifact__frame');
      await artifactFrame.waitFor({ state: 'visible', timeout: 15_000 });
      const target = artifactFrame
        .contentFrame()
        .locator('[data-combo-key="report-title"]')
        .first();
      await target.waitFor({ state: 'visible', timeout: 15_000 });
      await target.click();
      await page.waitForFunction(() => document.body.innerText.includes('已选「'), undefined, {
        timeout: 10_000,
      });
      ensure(
        (await page.locator('.rt-studio-tools__selection').textContent())?.includes('已选「'),
        activeCheck,
      );
    });

    let secondTurnId;
    let secondArtifact;
    let secondDetail;
    await checked('runtime_sse_replay_and_terminal', async () => {
      await composer.fill('只把这个元素改成更清晰的标题，并保持其它区域和交互不变。');
      const responsePromise = page.waitForResponse(
        (response) => response.url() === messageUrl && response.request().method() === 'POST',
        { timeout: 30_000 },
      );
      await page.getByRole('button', { name: '发送修改' }).click();
      const response = await responsePromise;
      ensure(response.status() === 202, activeCheck, 'http_status');
      let body;
      try {
        body = await response.json();
      } catch {
        fail(activeCheck, 'invalid_response');
      }
      secondTurnId = responseData(body, activeCheck)?.message?.turnId;
      ensure(UUID_PATTERN.test(secondTurnId ?? ''), activeCheck);
      const started = await readRuntimeStreamFrame(page, {
        sessionId: studioSession.id,
        runId: secondTurnId,
        afterId: undefined,
        terminal: false,
      });
      ensure(
        started.status === 200 &&
          started.contentType.startsWith('text/event-stream') &&
          started.eventType === 'RUN_STARTED' &&
          started.runId === secondTurnId &&
          compareRedisStreamIds(started.id, '0-0') === 1,
        activeCheck,
      );
      const terminal = await readRuntimeStreamFrame(page, {
        sessionId: studioSession.id,
        runId: secondTurnId,
        afterId: started.id,
        terminal: true,
      });
      ensure(
        terminal.status === 200 &&
          terminal.contentType.startsWith('text/event-stream') &&
          terminal.runId === secondTurnId &&
          compareRedisStreamIds(terminal.id, started.id) === 1,
        activeCheck,
      );
      if (terminal.eventType === 'RUN_ERROR') {
        const failedDetail = await api.json(
          activeCheck,
          `/api/v1/runtime/sessions/${studioSession.id}`,
        );
        requireSafeStudioTurnClassification(activeCheck, failedDetail.data, secondTurnId);
        fail(activeCheck, 'invalid_response', undefined, 'TURN_DETAIL_INVARIANT');
      }
      ensure(terminal.eventType === 'RUN_FINISHED', activeCheck);
      const replayedTerminal = await readRuntimeStreamFrame(page, {
        sessionId: studioSession.id,
        runId: secondTurnId,
        afterId: started.id,
        terminal: true,
      });
      ensure(
        replayedTerminal.status === 200 &&
          replayedTerminal.eventType === terminal.eventType &&
          replayedTerminal.runId === secondTurnId &&
          replayedTerminal.id === terminal.id,
        activeCheck,
      );
    });

    await checked('studio_second_revision', async () => {
      secondDetail = await waitForStudioRevision(
        activeCheck,
        secondTurnId,
        async () =>
          (await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`)).data,
      );
      secondArtifact = artifactForTurn(secondDetail, secondTurnId);
      ensure(secondArtifact?.kind === 'html', activeCheck);
      ensure(secondDetail.currentUiArtifactId === secondArtifact.id, activeCheck);
      ensure(
        secondArtifact.id !== firstArtifact.id &&
          secondDetail.artifacts.some(
            (artifact) => artifact.id === firstArtifact.id && artifact.sourceTurnId === firstTurnId,
          ) &&
          sortedChronologically(secondDetail.artifacts),
        activeCheck,
      );
      ensure(Array.isArray(secondDetail.messages), activeCheck, 'invalid_response');
      const userMessage = secondDetail.messages.find(
        (message) => message.role === 'user' && message.turnId === secondTurnId,
      );
      const acceptedText = textFromMessage(userMessage);
      ensure(
        acceptedText.includes('请只围绕当前选中的页面元素') &&
          acceptedText.includes('data-combo-key') &&
          acceptedText.includes('report-title') &&
          acceptedText.includes('只把这个元素改成更清晰的标题'),
        activeCheck,
      );
      state.metrics.completedStudioRevisions = secondDetail.artifacts.filter(
        (artifact) => artifact.sourceTurnId,
      ).length;
      ensure(state.metrics.completedStudioRevisions >= 2, activeCheck);
    });

    await checked('studio_interrupted_artifact_excluded', async () => {
      const beforeIds = secondDetail.artifacts.map((artifact) => artifact.id);
      const currentUiBefore = secondDetail.currentUiArtifactId;
      let interruptedTurnId;
      try {
        const interruptedPrompt =
          '严格分两个独立阶段执行，禁止合并工具调用。第一阶段不要先分析或重设计，只在当前页面基础上做一个极小、可见且不改变业务与交互的标题调整，立即省略 artifactId 调用 upsert_artifact 保存完整合法 HTML；必须等待第一次工具成功回执后才能进入第二阶段。第二阶段收到回执后，再开始逐区补充整个页面的大量细节，完成后另行省略 artifactId 调用 upsert_artifact；第二阶段结束前不要给最终答复。';
        const started = await postRuntimeMessageCompat(
          api,
          activeCheck,
          `/api/v1/runtime/sessions/${studioSession.id}/messages`,
          interruptedPrompt,
        );
        interruptedTurnId = started.data?.message?.turnId;
        ensure(UUID_PATTERN.test(interruptedTurnId ?? ''), activeCheck);
        const interruptedRunStarted = await readRuntimeStreamFrame(page, {
          sessionId: studioSession.id,
          runId: interruptedTurnId,
          afterId: undefined,
          terminal: false,
        });
        ensure(
          interruptedRunStarted.status === 200 &&
            interruptedRunStarted.eventType === 'RUN_STARTED' &&
            interruptedRunStarted.runId === interruptedTurnId &&
            compareRedisStreamIds(interruptedRunStarted.id, '0-0') === 1,
          activeCheck,
        );
        const activeCandidate = await poll(
          activeCheck,
          async () => {
            const detail = (
              await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`)
            ).data;
            ensure(detail?.activeTurn?.id === interruptedTurnId, activeCheck);
            return detail;
          },
          (detail) => Boolean(artifactForTurn(detail, interruptedTurnId)),
          TURN_TIMEOUT_MS,
        );
        const interruptedArtifactId = artifactForTurn(activeCandidate, interruptedTurnId)?.id;
        ensure(UUID_PATTERN.test(interruptedArtifactId ?? ''), activeCheck);
        ensure(activeCandidate.currentUiArtifactId === currentUiBefore, activeCheck);
        const interrupted = await api.json(
          activeCheck,
          `/api/v1/runtime/sessions/${studioSession.id}/interrupt`,
          { method: 'POST' },
        );
        ensure(interrupted.data?.interrupted === true, activeCheck);
        const interruptedTerminal = await readRuntimeStreamFrame(page, {
          sessionId: studioSession.id,
          runId: interruptedTurnId,
          afterId: interruptedRunStarted.id,
          terminal: true,
        });
        ensure(
          interruptedTerminal.status === 200 &&
            interruptedTerminal.eventType === 'RUN_ERROR' &&
            interruptedTerminal.runId === interruptedTurnId &&
            compareRedisStreamIds(interruptedTerminal.id, interruptedRunStarted.id) === 1,
          activeCheck,
        );
        const after = await poll(
          activeCheck,
          async () =>
            (await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`)).data,
          (detail) => detail?.activeTurn === null,
          30_000,
        );
        ensure(!artifactForTurn(after, interruptedTurnId), activeCheck);
        ensure(
          after.messages.some(
            (message) =>
              message.turnId === interruptedTurnId &&
              message.role === 'assistant' &&
              message.status === 'failed',
          ),
          activeCheck,
        );
        ensure(
          !after.artifacts.some((artifact) => artifact.id === interruptedArtifactId),
          activeCheck,
        );
        ensure(
          JSON.stringify(after.artifacts.map((artifact) => artifact.id)) ===
            JSON.stringify(beforeIds),
          activeCheck,
        );
        ensure(after.currentUiArtifactId === currentUiBefore, activeCheck);
      } finally {
        await settleOwnedAcceptanceTurn({
          check: activeCheck,
          knownTurnId: interruptedTurnId,
          readDetail: async () =>
            (await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`)).data,
          interrupt: async () =>
            (
              await api.json(
                activeCheck,
                `/api/v1/runtime/sessions/${studioSession.id}/interrupt`,
                { method: 'POST' },
              )
            ).data?.interrupted,
        });
      }
    });

    let consumeSessionId;
    await checked('runtime_current_ui_consume', async () => {
      const created = await api.json(activeCheck, '/api/v1/runtime/sessions', {
        method: 'POST',
        data: { capabilityId: capability.id },
        expected: [201],
      });
      consumeSessionId = created.data?.id;
      ensure(UUID_PATTERN.test(consumeSessionId ?? ''), activeCheck);
      const detail = await api.json(activeCheck, `/api/v1/runtime/sessions/${consumeSessionId}`);
      const snapshot = consumeUiSnapshot(detail.data, secondArtifact.id);
      ensure(
        detail.data?.session?.mode === 'consume' &&
          snapshot?.kind === 'html' &&
          snapshot.id !== secondArtifact.id &&
          snapshot.sourceTurnId === undefined,
        activeCheck,
      );
      state.resources.consumeSessionId = consumeSessionId;
    });

    await checked('studio_trial_return', async () => {
      await page.goto(`/try/session/${studioSession.id}`, { waitUntil: 'domcontentloaded' });
      const trialButton = page.getByRole('button', { name: '试用当前 UI' });
      await trialButton.waitFor({ state: 'visible', timeout: 30_000 });
      await trialButton.click();
      await waitForAcceptanceUrl(page, {
        pathnamePattern: '^/try/session/[0-9a-f-]+$',
        searchParams: { returnTo: `/try/session/${studioSession.id}` },
      });
      const studioReturnButton = page.getByRole('button', {
        name: '返回 UI 设计',
        exact: true,
      });
      await studioReturnButton.waitFor({ state: 'visible', timeout: 30_000 });
      await studioReturnButton.click();
      await waitForAcceptanceUrl(page, { pathname: `/try/session/${studioSession.id}` });
      await page
        .getByRole('complementary', { name: 'UI 设计对话' })
        .waitFor({ state: 'visible', timeout: 30_000 });
    });

    await checked('task_trial_return', async () => {
      const returnTo = `/tasks/${task.id}`;
      await page.goto(`/try/c/${capability.id}?returnTo=${encodeURIComponent(returnTo)}`, {
        waitUntil: 'domcontentloaded',
      });
      await waitForAcceptanceUrl(page, {
        pathnamePattern: '^/try/session/[0-9a-f-]+$',
        searchParams: { returnTo },
      });
      const taskReturnButton = page.getByRole('button', {
        name: '返回发布流程',
        exact: true,
      });
      await taskReturnButton.waitFor({ state: 'visible', timeout: 30_000 });
      await taskReturnButton.click();
      await waitForAcceptanceUrl(page, { pathname: returnTo });
      await page
        .getByRole('heading', {
          name: 'Agent 已准备好，先选一个真实试用',
          exact: true,
        })
        .waitFor({ state: 'visible', timeout: 30_000 });
    });

    await checked('preview_auth_entry_and_return_to', async () => {
      if (options.environment !== 'preview') {
        return;
      }
      const unauthenticated = await browser.newContext({
        baseURL: options.webOrigin,
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
      try {
        const recoveryPage = await unauthenticated.newPage();
        const recoveryPath = `/tasks/${task.id}?acceptance=recovered`;
        const navigation = await recoveryPage.goto(recoveryPath, {
          waitUntil: 'domcontentloaded',
        });
        ensure(navigation?.status() === 200, activeCheck, 'http_status');
        const anonymousMe = await unauthenticated.request.get(`${options.webOrigin}/api/v1/me`, {
          failOnStatusCode: false,
          maxRedirects: 0,
        });
        ensure(anonymousMe.status() === 401, activeCheck, 'http_status');
        // RequireAuth 对匿名深链直接 replace 到公开登录页；这里验证当前路由契约，
        // 不再兼容已经删除的中间登录门板和“去登录”按钮。
        await waitForAcceptanceUrl(recoveryPage, {
          origin: options.webOrigin,
          pathname: '/login',
          searchParams: { returnTo: recoveryPath },
        });
        await recoveryPage
          .getByRole('heading', { name: '使用邮箱登录' })
          .waitFor({ state: 'visible', timeout: 30_000 });
        await recoveryPage
          .getByRole('textbox', { name: '邮箱' })
          .waitFor({ state: 'visible', timeout: 30_000 });
      } finally {
        await unauthenticated.close();
      }
    });

    await checked('owner_isolation', async () => {
      const isolated = await browser.newContext({
        baseURL: options.webOrigin,
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
      try {
        await isolated.route('**/*', async (route) => {
          if (isAllowedAcceptanceRequest(route.request().url(), options.webOrigin)) {
            await route.continue();
          } else {
            await route.abort('blockedbyclient');
          }
        });
        await isolated.routeWebSocket('**/*', async (socket) => {
          if (isAllowedAcceptanceWebSocket(socket.url(), options.webOrigin)) {
            socket.connectToServer();
          } else {
            await socket.close({ code: 1008, reason: 'acceptance origin boundary' });
          }
        });
        const isolatedApi = new BrowserApi(isolated, options.webOrigin);
        const secondary = await authenticateWithEmailOtp({
          api: isolatedApi,
          context: isolated,
          email: acceptanceEmailAddress(
            options.environment,
            options.revision,
            options.runId,
            options.runAttempt,
            'secondary',
          ),
          returnTo: '/tasks',
          resendApiKey,
          secureCookie,
          check: activeCheck,
        });
        ensure(secondary.identity.id !== authenticatedIdentity.id, activeCheck);
        secondary.sessionCookie = undefined;
        for (const path of [
          `/api/v1/tasks/${task.id}`,
          `/api/v1/capabilities/${capability.id}`,
          `/api/v1/runtime/sessions/${studioSession.id}`,
        ]) {
          const response = await isolatedApi.raw(path);
          ensure([403, 404].includes(response.status()), activeCheck, 'http_status');
        }
      } finally {
        await isolated.close();
      }
    });

    await checked('session_persistence', async () => {
      ensure(UUID_PATTERN.test(authenticatedIdentity?.id ?? ''), activeCheck);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const me = await api.json(activeCheck, '/api/v1/me');
      ensure(
        me.data?.id === authenticatedIdentity.id &&
          me.data?.email === authenticatedIdentity.email &&
          JSON.stringify(me.data?.roles) === '["creator"]',
        activeCheck,
      );
      const expectedCookieName = secureCookie ? '__Host-cb_session' : 'cb_session';
      const cookies = await context.cookies();
      const persisted = cookies.find((cookie) => cookie.name === expectedCookieName);
      ensure(
        persisted?.value === authenticationCookieValue &&
          !cookies.some((cookie) => ['cb_refresh', 'cb_auth_tx'].includes(cookie.name)),
        activeCheck,
      );
    });

    await checked('logout_revokes_session', async () => {
      const logout = await api.json(activeCheck, '/api/v1/auth/logout', {
        method: 'POST',
        data: {},
      });
      ensure(logout.data?.loggedOut === true && Object.keys(logout.data).length === 1, activeCheck);
      const me = await api.raw('/api/v1/me');
      ensure(me.status() === 401, activeCheck, 'http_status');
      const remainingCookieNames = (await context.cookies()).map((cookie) => cookie.name);
      ensure(
        !remainingCookieNames.includes('cb_session') &&
          !remainingCookieNames.includes('__Host-cb_session') &&
          !remainingCookieNames.includes('cb_refresh') &&
          !remainingCookieNames.includes('cb_auth_tx') &&
          !remainingCookieNames.includes('combo_review_access'),
        activeCheck,
      );
      const replay = await browser.newContext({
        baseURL: options.webOrigin,
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
      try {
        ensure(
          typeof authenticationCookieValue === 'string' &&
            /^s1\.[A-Za-z0-9_-]{43}$/u.test(authenticationCookieValue),
          activeCheck,
        );
        const expectedCookieName = secureCookie ? '__Host-cb_session' : 'cb_session';
        await replay.addCookies([
          {
            name: expectedCookieName,
            value: authenticationCookieValue,
            url: options.webOrigin,
            httpOnly: true,
            secure: secureCookie,
            sameSite: 'Lax',
          },
        ]);
        const replayApi = new BrowserApi(replay, options.webOrigin);
        const revoked = await replayApi.raw('/api/v1/me');
        ensure(revoked.status() === 401, activeCheck, 'http_status');
      } finally {
        await replay.close();
      }
      authenticationCookieValue = undefined;
      const loggedOutReturnTo = `/tasks/${task.id}`;
      await page.goto(loggedOutReturnTo, { waitUntil: 'domcontentloaded' });
      await waitForAcceptanceUrl(page, {
        origin: options.webOrigin,
        pathname: '/login',
        searchParams: { returnTo: loggedOutReturnTo },
      });
      await page
        .getByRole('heading', { name: '使用邮箱登录' })
        .waitFor({ state: 'visible', timeout: 30_000 });
    });

    ensure(
      GOAL_B_ACCEPTANCE_CHECKS.every((id, index) => state.checks[index]?.id === id),
      activeCheck,
    );
    await context.close();
  } catch (error) {
    state.failure =
      error instanceof AcceptanceFailure
        ? error
        : new AcceptanceFailure(
            activeCheck,
            error?.name === 'TimeoutError' ? 'timeout' : 'browser',
          );
  } finally {
    resendApiKey = undefined;
    authenticatedIdentity = undefined;
    authenticationCookieValue = undefined;
    delete process.env.ACCEPTANCE_RESEND_API_KEY;
    if (browser) await browser.close().catch(() => undefined);
    state.completedAt = new Date().toISOString();
  }
  return state;
}

async function main() {
  let options;
  try {
    options = parseAcceptanceArgs(process.argv.slice(2));
  } catch {
    process.stderr.write(
      'Goal B Test browser acceptance rejected unsafe or incomplete arguments.\n',
    );
    process.exitCode = 2;
    return;
  }
  const evidence = buildAcceptanceEvidence(await runAcceptance(options));
  try {
    writeAcceptanceEvidence(options.output, evidence);
  } catch {
    process.stderr.write('Goal B Test browser acceptance could not write secure evidence.\n');
    process.exitCode = 2;
    return;
  }
  if (evidence.status !== 'passed') {
    process.stderr.write(
      'Goal B Test browser acceptance failed; inspect the sanitized evidence.\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`PASS goal_b_${options.environment}_browser ${options.revision}\n`);
}

if ((process.argv[1] ? resolve(process.argv[1]) : '') === fileURLToPath(import.meta.url)) {
  await main();
}
