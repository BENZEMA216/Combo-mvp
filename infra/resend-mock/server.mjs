import { Buffer } from 'node:buffer';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL, URL } from 'node:url';

const ALLOWED_MODES = new Set([
  'accepted',
  'permanent',
  'invalid_from',
  'invalid_request',
  'rate_limited',
  'server_error',
  'timeout',
]);
const MAX_REQUEST_BYTES = 32 * 1024;
const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_TIMEOUT_DELAY_MS = 10_000;

function jsonResponse(response, statusCode, body) {
  if (response.destroyed || response.writableEnded) return;
  const encoded = JSON.stringify(body);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

function emptyResponse(response, statusCode = 204) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(statusCode, { 'cache-control': 'no-store' });
  response.end();
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthorized(request, apiKey) {
  const authorization = request.headers.authorization;
  return typeof authorization === 'string' && safeEqual(authorization, `Bearer ${apiKey}`);
}

async function readJson(request) {
  const contentType = request.headers['content-type'];
  if (
    typeof contentType !== 'string' ||
    !contentType.toLowerCase().startsWith('application/json')
  ) {
    throw Object.assign(new Error('unsupported content type'), { statusCode: 415 });
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      throw Object.assign(new Error('request too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid json'), { statusCode: 400 });
  }
}

function loginCodeFromText(text) {
  if (typeof text !== 'string') return null;
  return text.match(/(?:^|\D)([0-9]{6})(?:\D|$)/)?.[1] ?? null;
}

function validRecipient(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 254;
}

function deliveryStatus(mode) {
  switch (mode) {
    case 'permanent':
    case 'invalid_from':
      return 422;
    case 'invalid_request':
      return 400;
    case 'rate_limited':
      return 429;
    case 'server_error':
      return 503;
    case 'timeout':
      return 504;
    default:
      return 202;
  }
}

/**
 * 仅供 dev-test 使用的 Resend HTTP 形状 mock。服务不记录访问日志，也不会返回邮件正文。
 */
export function createResendMockServer(options = {}) {
  const apiKey = options.apiKey ?? process.env.RESEND_MOCK_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('RESEND_MOCK_API_KEY is required');
  }

  const maxMessages = Math.max(1, options.maxMessages ?? DEFAULT_MAX_MESSAGES);
  const timeoutDelayMs = Math.max(1, options.timeoutDelayMs ?? DEFAULT_TIMEOUT_DELAY_MS);
  let mode = 'accepted';
  const inbox = [];
  const idempotency = new Map();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://resend-mock.invalid');

      if (request.method === 'GET' && url.pathname === '/health') {
        return jsonResponse(response, 200, { status: 'ok' });
      }

      if (!isAuthorized(request, apiKey)) {
        return jsonResponse(response, 401, { error: 'unauthorized' });
      }

      if (request.method === 'DELETE' && url.pathname === '/__test/inbox') {
        inbox.length = 0;
        idempotency.clear();
        return emptyResponse(response);
      }

      if (request.method === 'PUT' && url.pathname === '/__test/mode') {
        const body = await readJson(request);
        if (!ALLOWED_MODES.has(body?.mode)) {
          return jsonResponse(response, 400, { error: 'invalid_mode' });
        }
        mode = body.mode;
        return jsonResponse(response, 200, { mode });
      }

      if (request.method === 'POST' && url.pathname === '/__test/inbox/latest') {
        const body = await readJson(request);
        if (!validRecipient(body?.to)) {
          return jsonResponse(response, 400, { error: 'invalid_recipient' });
        }
        const message = inbox.findLast((candidate) => candidate.to === body.to);
        if (!message) return jsonResponse(response, 404, { error: 'not_found' });
        return jsonResponse(response, 200, { id: message.id, code: message.code });
      }

      if (request.method === 'POST' && url.pathname === '/emails') {
        const body = await readJson(request);
        const idempotencyKey = request.headers['idempotency-key'];
        const recipient = Array.isArray(body?.to) && body.to.length === 1 ? body.to[0] : null;
        const code = loginCodeFromText(body?.text);
        if (
          typeof idempotencyKey !== 'string' ||
          idempotencyKey.length === 0 ||
          !validRecipient(body?.from) ||
          !validRecipient(recipient) ||
          typeof body?.subject !== 'string' ||
          body.subject.length === 0 ||
          !code
        ) {
          return jsonResponse(response, 400, { error: 'invalid_request' });
        }

        const previous = idempotency.get(idempotencyKey);
        if (previous) {
          return jsonResponse(response, previous.statusCode, previous.body);
        }

        const statusCode = deliveryStatus(mode);
        const responseBody =
          statusCode >= 200 && statusCode < 300
            ? { id: randomUUID() }
            : mode === 'permanent'
              ? {
                  name: 'validation_error',
                  message: 'The `to` field must be a valid recipient.',
                }
              : mode === 'invalid_from'
                ? {
                    name: 'invalid_from_address',
                    message: 'The sender address is not configured.',
                  }
                : mode === 'invalid_request'
                  ? {
                      name: 'validation_error',
                      message: 'The request contains an invalid `from` field.',
                    }
                  : { error: 'delivery_rejected' };
        idempotency.set(idempotencyKey, { statusCode, body: responseBody });
        const maxIdempotencyRecords = maxMessages * 4;
        while (idempotency.size > maxIdempotencyRecords) {
          idempotency.delete(idempotency.keys().next().value);
        }

        if (mode === 'timeout') {
          const timer = setTimeout(() => {
            jsonResponse(response, 504, { error: 'timeout' });
          }, timeoutDelayMs);
          timer.unref();
          response.once('close', () => clearTimeout(timer));
          return;
        }

        if (statusCode >= 200 && statusCode < 300) {
          inbox.push({ id: responseBody.id, to: recipient, code });
          if (inbox.length > maxMessages) inbox.splice(0, inbox.length - maxMessages);
        }
        return jsonResponse(response, statusCode, responseBody);
      }

      return jsonResponse(response, 404, { error: 'not_found' });
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
      return jsonResponse(response, statusCode, { error: 'invalid_request' });
    }
  });

  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

async function main() {
  const server = createResendMockServer();
  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number.parseInt(process.env.PORT ?? '4010', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be a valid TCP port');
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('[resend-mock] startup failed\n');
    process.exit(1);
  });
}
