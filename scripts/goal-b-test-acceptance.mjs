#!/usr/bin/env node
/* global HTMLButtonElement, document, setTimeout, window */

import { createHash, randomBytes } from 'node:crypto';
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

export const GOAL_B_ACCEPTANCE_CHECKS = Object.freeze([
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

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ZERO_SOURCE_SHA = '0'.repeat(40);
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|credential|pairing|password|secret|token)/i;
const SENSITIVE_VALUE_PATTERN =
  /(?:bearer\s+[a-z0-9._~-]+|cb_(?:session|refresh)=|set-cookie|pairingCode)/i;
const CHROME_EXECUTABLE = '/usr/bin/google-chrome';
const TASK_TIMEOUT_MS = 15 * 60_000;
const TURN_TIMEOUT_MS = 12 * 60_000;
const POLL_INTERVAL_MS = 1_000;
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

class AcceptanceFailure extends Error {
  constructor(check, reason, statusCode) {
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
  }
}

function fail(check, reason = 'assertion', statusCode) {
  throw new AcceptanceFailure(check, reason, statusCode);
}

function ensure(condition, check, reason = 'assertion') {
  if (!condition) fail(check, reason);
}

function validateWebOrigin(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('--web-origin must be an absolute URL');
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      '--web-origin must be exactly http://127.0.0.1:<port> with no path, query, or credentials',
    );
  }
  const port = Number(parsed.port);
  if (port !== 18_080) {
    throw new Error('--web-origin must use the Test loopback forward port 18080');
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
  if (!Array.isArray(argv) || argv.length !== 6) {
    throw new Error('required arguments: --revision <sha> --web-origin <origin> --output <file>');
  }
  const values = new Map();
  const allowed = new Set(['--revision', '--web-origin', '--output']);
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
  return {
    revision,
    webOrigin: validateWebOrigin(values.get('--web-origin')),
    output: validateOutput(values.get('--output')),
  };
}

export function isAllowedAcceptanceWebSocket(raw, webOrigin) {
  try {
    const socket = new URL(raw);
    const origin = new URL(webOrigin);
    return (
      socket.protocol === 'ws:' &&
      origin.protocol === 'http:' &&
      socket.hostname === '127.0.0.1' &&
      origin.hostname === '127.0.0.1' &&
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
    if (target.protocol === 'http:') return target.origin === webOrigin;
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
  if (typeof value === 'string' && SENSITIVE_VALUE_PATTERN.test(value)) {
    throw new Error(`unsafe evidence value at ${path}`);
  }
}

function optionalUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : undefined;
}

export function isExpectedTestReleaseMetadata(value, revision) {
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
    value.environment === 'test' &&
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

function safeRelease(value, revision) {
  if (!isExpectedTestReleaseMetadata(value, revision)) return undefined;
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
        }
      : undefined;
  const release = safeRelease(state.release, state.revision);
  const hasAllResources = [
    resources.taskId,
    resources.capabilityId,
    resources.studioSessionId,
    resources.consumeSessionId,
  ].every((value) => typeof value === 'string');
  const evidence = {
    schemaVersion: 1,
    suite: 'goal-b-test-browser',
    revision: state.revision,
    webOrigin: state.webOrigin,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    status:
      !failure &&
      SHA_PATTERN.test(state.revision ?? '') &&
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
    return this.context.request.fetch(this.safeUrl(path), {
      method: options.method ?? 'GET',
      ...(options.data === undefined ? {} : { data: options.data }),
      failOnStatusCode: false,
      maxRedirects: options.maxRedirects ?? 0,
      timeout: options.timeout ?? 30_000,
      headers: { Accept: options.accept ?? 'application/json', Origin: this.origin },
    });
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

async function poll(check, read, accept, timeoutMs, intervalMs = POLL_INTERVAL_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }
  fail(check, 'timeout');
}

function artifactForTurn(detail, turnId) {
  return detail.artifacts.find((artifact) => artifact.sourceTurnId === turnId);
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

async function runAcceptance(options) {
  const state = {
    revision: options.revision,
    webOrigin: options.webOrigin,
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
  const checked = async (id, operation) => {
    activeCheck = id;
    const started = Date.now();
    await operation();
    state.checks.push({ id, status: 'passed', durationMs: Date.now() - started });
    process.stdout.write(`PASS ${id}\n`);
  };

  try {
    ensure(existsSync(CHROME_EXECUTABLE), activeCheck, 'browser');
    browser = await chromium.launch({ executablePath: CHROME_EXECUTABLE, headless: true });
    const context = await browser.newContext({
      baseURL: options.webOrigin,
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
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
        await socket.close({ code: 1008, reason: 'loopback-only acceptance' });
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
        ensure(isExpectedTestReleaseMetadata(metadata, options.revision), 'release_identity');
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

    await checked('dev_login', async () => {
      const email = `goal-b-${options.revision.slice(0, 12)}@example.invalid`;
      const account = `goal-b-${options.revision.slice(0, 12)}`;
      const login = await api.json('dev_login', '/api/v1/auth/dev-login', {
        method: 'POST',
        data: {
          email,
          account,
          roles: ['creator'],
        },
      });
      const me = await api.json('dev_login', '/api/v1/me');
      for (const identity of [login.data, me.data]) {
        ensure(
          UUID_PATTERN.test(identity?.id ?? '') &&
            identity?.email === email &&
            identity?.account === account &&
            JSON.stringify(identity?.roles) === '["creator"]',
          'dev_login',
        );
      }
      const sessionCookie = (await context.cookies(options.webOrigin)).find(
        (cookie) => cookie.name === 'cb_session',
      );
      ensure(sessionCookie?.httpOnly === true, 'dev_login');
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
      capability = capabilities.data[0];
      ensure(UUID_PATTERN.test(capability?.id ?? ''), activeCheck);
      state.resources.capabilityId = capability.id;
    });

    await checked('creation_publish_and_retry_fence', async () => {
      const published = await api.json(
        activeCheck,
        `/api/v1/capabilities/${capability.id}/publish`,
        { method: 'POST' },
      );
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
      await page.waitForFunction(
        ({ id }) =>
          window.location.pathname === `/tasks/${id}` &&
          document.body.innerText.includes('你的能力'),
        { id: task.id },
        { timeout: 30_000 },
      );
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
    await checked('studio_failed_send_retains_draft', async () => {
      const draft = 'Goal B 网络失败后必须保留的草稿';
      await composer.fill(draft);
      await page.route(
        messageUrl,
        async (route) => {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'DEPENDENCY_UNAVAILABLE', userMessage: '暂时不可用' },
            }),
          });
        },
        { times: 1 },
      );
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
      await page.unroute(messageUrl);
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
      let submittedText;
      await page.route(messageUrl, async (route) => {
        requestCount += 1;
        try {
          submittedText = route.request().postDataJSON()?.text;
        } catch {
          submittedText = undefined;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
        await route.fallback();
      });
      const responsePromise = page.waitForResponse(
        (response) => response.url() === messageUrl && response.request().method() === 'POST',
        { timeout: 30_000 },
      );
      await page.evaluate(() => {
        const button = document.querySelector('button[aria-label="生成第一版 UI"]');
        if (!(button instanceof HTMLButtonElement)) throw new Error('missing send button');
        button.click();
        button.click();
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      ensure((await composer.inputValue()) === prompt, activeCheck);
      const response = await responsePromise;
      ensure(response.status() === 202, activeCheck, 'http_status');
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
      ensure(requestCount === 1 && submittedText === prompt, activeCheck);
      await page.unroute(messageUrl);
    });

    await checked('studio_active_turn_reload', async () => {
      await poll(
        activeCheck,
        async () =>
          (await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`)).data,
        (detail) => detail?.activeTurn?.id === firstTurnId,
        20_000,
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      const restored = await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`);
      ensure(
        restored.data?.activeTurn?.id === firstTurnId ||
          Boolean(artifactForTurn(restored.data, firstTurnId)),
        activeCheck,
      );
      await page.getByRole('complementary', { name: 'UI 设计对话' }).waitFor({
        state: 'visible',
        timeout: 30_000,
      });
      await page.waitForFunction(
        () =>
          document.querySelector('button[aria-label="停止当前修改"]') !== null ||
          document.querySelector('iframe.rt-artifact__frame') !== null,
        undefined,
        { timeout: 30_000 },
      );
      const uiShowsRunning = await page.getByRole('button', { name: '停止当前修改' }).isVisible();
      if (uiShowsRunning) {
        ensure(restored.data?.activeTurn?.id === firstTurnId, activeCheck);
      } else {
        const converged = await api.json(
          activeCheck,
          `/api/v1/runtime/sessions/${studioSession.id}`,
        );
        ensure(
          Boolean(artifactForTurn(converged.data, firstTurnId)) &&
            (await page.locator('iframe.rt-artifact__frame').isVisible()),
          activeCheck,
        );
      }
    });

    let firstArtifact;
    let firstDetail;
    await checked('studio_first_revision', async () => {
      firstDetail = await poll(
        activeCheck,
        async () =>
          (await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`)).data,
        (detail) => detail?.activeTurn === null && Boolean(artifactForTurn(detail, firstTurnId)),
        TURN_TIMEOUT_MS,
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
    await checked('studio_second_revision', async () => {
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
      secondDetail = await poll(
        activeCheck,
        async () =>
          (await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`)).data,
        (detail) => detail?.activeTurn === null && Boolean(artifactForTurn(detail, secondTurnId)),
        TURN_TIMEOUT_MS,
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
      const started = await api.json(
        activeCheck,
        `/api/v1/runtime/sessions/${studioSession.id}/messages`,
        {
          method: 'POST',
          data: {
            text: '重新设计整个页面并生成大量细节；先分析所有区域，再逐区修改并最后保存。',
          },
          expected: [202],
        },
      );
      const interruptedTurnId = started.data?.message?.turnId;
      ensure(UUID_PATTERN.test(interruptedTurnId ?? ''), activeCheck);
      const activeCandidate = await poll(
        activeCheck,
        async () =>
          (await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`)).data,
        (detail) =>
          detail?.activeTurn?.id === interruptedTurnId &&
          Boolean(artifactForTurn(detail, interruptedTurnId)),
        90_000,
        100,
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
      const after = await poll(
        activeCheck,
        async () =>
          (await api.json(activeCheck, `/api/v1/runtime/sessions/${studioSession.id}`)).data,
        (detail) => detail?.activeTurn === null,
        30_000,
      );
      ensure(!artifactForTurn(after, interruptedTurnId), activeCheck);
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
      await page.waitForURL(
        (url) =>
          /^\/try\/session\/[0-9a-f-]+$/i.test(url.pathname) &&
          url.searchParams.get('returnTo') === `/try/session/${studioSession.id}`,
        { timeout: 30_000 },
      );
      await page.getByRole('button', { name: '返回 UI 设计' }).click();
      await page.waitForURL((url) => url.pathname === `/try/session/${studioSession.id}`, {
        timeout: 30_000,
      });
    });

    await checked('task_trial_return', async () => {
      const returnTo = `/tasks/${task.id}`;
      await page.goto(`/try/c/${capability.id}?returnTo=${encodeURIComponent(returnTo)}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForURL(
        (url) =>
          /^\/try\/session\/[0-9a-f-]+$/i.test(url.pathname) &&
          url.searchParams.get('returnTo') === returnTo,
        { timeout: 30_000 },
      );
      await page.getByRole('button', { name: '返回发布流程' }).click();
      await page.waitForURL((url) => url.pathname === returnTo, { timeout: 30_000 });
      await page.waitForFunction(() => document.body.innerText.includes('你的能力'), undefined, {
        timeout: 30_000,
      });
    });

    await checked('logout_clears_session', async () => {
      const logout = await api.json(activeCheck, '/api/v1/auth/logout', { method: 'POST' });
      ensure(logout.data?.loggedOut === true, activeCheck);
      const me = await api.raw('/api/v1/me');
      ensure(me.status() === 401, activeCheck, 'http_status');
      const remainingCookieNames = (await context.cookies(options.webOrigin)).map(
        (cookie) => cookie.name,
      );
      ensure(
        !remainingCookieNames.includes('cb_session') &&
          !remainingCookieNames.includes('cb_refresh') &&
          !remainingCookieNames.includes('cb_auth_tx'),
        activeCheck,
      );
      await page.goto(`/tasks/${task.id}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '去登录' }).waitFor({
        state: 'visible',
        timeout: 30_000,
      });
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
  process.stdout.write(`PASS goal_b_test_browser ${options.revision}\n`);
}

if ((process.argv[1] ? resolve(process.argv[1]) : '') === fileURLToPath(import.meta.url)) {
  await main();
}
