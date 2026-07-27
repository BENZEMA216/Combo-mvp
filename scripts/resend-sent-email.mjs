#!/usr/bin/env node
/* global AbortController, clearTimeout, setTimeout */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

const RESEND_API_ORIGIN = 'https://api.resend.com';
const RESEND_LIST_URL = `${RESEND_API_ORIGIN}/emails?limit=100`;
const RESEND_KEY_PATTERN = /^re_[A-Za-z0-9_-]{16,252}$/u;
const RESEND_EMAIL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const EMAIL_SUBJECT = 'Combo 登录验证码';
const EMAIL_FROM = 'Combo <auth@buildwithcombo.com>';
const OTP_PATTERN = /Combo 登录验证码是 ([0-9]{6})。验证码将在 5 分钟后失效。/gu;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_INTERVAL_MS = 1_500;

function fail() {
  throw new Error('Acceptance Resend reader failed');
}

function safeApiKey(value) {
  if (
    typeof value !== 'string' ||
    value.length > 256 ||
    value !== value.trim() ||
    !RESEND_KEY_PATTERN.test(value)
  ) {
    fail();
  }
  return value;
}

/**
 * Read the protected full-access key exactly once and remove it from the process environment.
 * Callers must also overwrite their local reference when the acceptance run finishes.
 */
export function takeAcceptanceResendApiKey(environment = process.env) {
  const value = environment.ACCEPTANCE_RESEND_API_KEY;
  delete environment.ACCEPTANCE_RESEND_API_KEY;
  return safeApiKey(value);
}

function compactPositiveInteger(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(value)) fail();
  return BigInt(value).toString(36);
}

export function acceptanceEmailAddress(environment, sourceSha, runId, runAttempt, identity) {
  if (
    !['test', 'preview', 'production'].includes(environment) ||
    !SOURCE_SHA_PATTERN.test(sourceSha) ||
    !['primary', 'secondary'].includes(identity)
  ) {
    fail();
  }
  const environmentCode = { test: 't', preview: 'v', production: 'p' }[environment];
  const address =
    `delivered+combo-${environmentCode}-${sourceSha.slice(0, 12)}-` +
    `${compactPositiveInteger(runId)}-${compactPositiveInteger(runAttempt)}-${identity}` +
    '@resend.dev';
  if (address.slice(0, address.indexOf('@')).length > 64) fail();
  return address;
}

async function readJson(response) {
  if (!response || response.status !== 200) fail();
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) fail();
  try {
    return await response.json();
  } catch {
    fail();
  }
}

async function resendGet(url, apiKey, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
    });
    return await readJson(response);
  } catch {
    fail();
  } finally {
    clearTimeout(timer);
  }
}

export async function validateAcceptanceResendApiKey(apiKey, fetchImpl = globalThis.fetch) {
  const key = safeApiKey(apiKey);
  const list = await resendGet(`${RESEND_API_ORIGIN}/emails?limit=1`, key, fetchImpl);
  if (list?.object !== 'list' || typeof list.has_more !== 'boolean' || !Array.isArray(list.data)) {
    fail();
  }
}

function exactRecipient(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === 'string' &&
    value[0].toLowerCase() === expected
  );
}

function matchingEmailSummary(value, recipient, notBeforeMs) {
  if (
    !value ||
    typeof value !== 'object' ||
    !RESEND_EMAIL_ID_PATTERN.test(value.id ?? '') ||
    !exactRecipient(value.to, recipient) ||
    value.from !== EMAIL_FROM ||
    value.subject !== EMAIL_SUBJECT ||
    value.last_event !== 'delivered' ||
    typeof value.created_at !== 'string'
  ) {
    return false;
  }
  const createdAt = Date.parse(value.created_at);
  return Number.isFinite(createdAt) && createdAt >= notBeforeMs;
}

function extractOtp(value, recipient, notBeforeMs, expectedId) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.object !== 'email' ||
    value.id !== expectedId ||
    !matchingEmailSummary(value, recipient, notBeforeMs) ||
    typeof value.text !== 'string' ||
    value.text.length > 4_096 ||
    (value.html !== null && value.html !== undefined && typeof value.html !== 'string')
  ) {
    fail();
  }
  const matches = [...value.text.matchAll(OTP_PATTERN)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) fail();
  return matches[0][1];
}

export async function waitForDeliveredAcceptanceOtp({
  apiKey,
  recipient,
  notBefore,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
}) {
  const key = safeApiKey(apiKey);
  const normalizedRecipient = typeof recipient === 'string' ? recipient.toLowerCase() : '';
  if (
    !/^delivered\+combo-[tvp]-[0-9a-f]{12}-[0-9a-z]+-[0-9a-z]+-(?:primary|secondary)@resend\.dev$/u.test(
      normalizedRecipient,
    ) ||
    !(notBefore instanceof Date) ||
    !Number.isFinite(notBefore.getTime()) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > DEFAULT_TIMEOUT_MS ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > 5_000
  ) {
    fail();
  }

  // Allow bounded provider clock skew, while the run-specific recipient prevents stale matches.
  const notBeforeMs = notBefore.getTime() - 5_000;
  const deadline = Date.now() + timeoutMs;
  do {
    const list = await resendGet(RESEND_LIST_URL, key, fetchImpl);
    if (
      list?.object !== 'list' ||
      typeof list.has_more !== 'boolean' ||
      !Array.isArray(list.data) ||
      list.data.length > 100
    ) {
      fail();
    }
    const matching = list.data
      .filter((item) => matchingEmailSummary(item, normalizedRecipient, notBeforeMs))
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
    if (matching.length > 0) {
      const id = matching[0].id;
      const message = await resendGet(`${RESEND_API_ORIGIN}/emails/${id}`, key, fetchImpl);
      return extractOtp(message, normalizedRecipient, notBeforeMs, id);
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  } while (Date.now() <= deadline);
  fail();
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--validate-key') {
    process.stderr.write('Acceptance Resend reader rejected unsafe arguments.\n');
    process.exitCode = 2;
    return;
  }
  let apiKey;
  try {
    apiKey = takeAcceptanceResendApiKey();
    await validateAcceptanceResendApiKey(apiKey);
  } catch {
    process.stderr.write('Acceptance Resend reader validation failed.\n');
    process.exitCode = 2;
  } finally {
    apiKey = undefined;
    delete process.env.ACCEPTANCE_RESEND_API_KEY;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
