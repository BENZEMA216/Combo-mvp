import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  CreatorWorkerError,
  type CreatorWorker,
  type CreatorWorkerStatus,
} from './creator-worker.js';
import { renderChatPage } from './chat-page.js';

const LOOPBACK_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 16_384;
const MAX_HEADER_COUNT = 32;
const STOP_GRACE_MS = 1_000;

interface ApiSuccess<T> {
  ok: true;
  data: T;
}

interface ApiFailure {
  ok: false;
  error: { code: string; message: string; retryable: boolean };
}

export interface CreatorWorkerHttpServerOptions {
  worker: CreatorWorker;
  port?: number;
  agentName?: string;
}

export interface CreatorWorkerServerAddress {
  origin: string;
  experienceUrl: string;
  port: number;
}

export class CreatorWorkerHttpServer {
  private readonly worker: CreatorWorker;
  private readonly requestedPort: number;
  private readonly agentName: string;
  private readonly capability = randomBytes(32).toString('base64url');
  private readonly nonce = randomBytes(18).toString('base64');
  private server?: Server;
  private address?: CreatorWorkerServerAddress;
  private starting?: Promise<CreatorWorkerServerAddress>;
  private stopping = false;
  private closing?: Promise<void>;
  private closed = false;

  constructor(options: CreatorWorkerHttpServerOptions) {
    this.worker = options.worker;
    this.requestedPort = options.port ?? 0;
    this.agentName = options.agentName ?? 'Creator Project Agent';
    if (
      !Number.isSafeInteger(this.requestedPort) ||
      this.requestedPort < 0 ||
      this.requestedPort > 65_535
    ) {
      throw new TypeError('HTTP port is invalid.');
    }
  }

  start(): Promise<CreatorWorkerServerAddress> {
    if (this.stopping) {
      return Promise.reject(new Error('Creator Worker HTTP server is stopping.'));
    }
    if (this.server && this.address) return Promise.resolve(this.address);
    if (this.starting) return this.starting;
    const starting = this.startOnce().finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    this.starting = starting;
    return starting;
  }

  private async startOnce(): Promise<CreatorWorkerServerAddress> {
    const server = createServer((request, response) => {
      void this.route(request, response).catch(() => {
        if (!response.headersSent)
          this.sendFailure(response, 500, 'INTERNAL_ERROR', '请求失败。', false);
        else response.destroy();
      });
    });
    server.maxHeadersCount = MAX_HEADER_COUNT;
    server.headersTimeout = 5_000;
    server.requestTimeout = 130_000;
    server.keepAliveTimeout = 5_000;
    server.on('upgrade', (_request, socket) => socket.destroy());
    server.on('clientError', (_error, socket) => socket.destroy());
    this.server = server;
    this.address = undefined;
    this.closing = undefined;
    this.closed = false;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.requestedPort, LOOPBACK_HOST, () => {
          server.off('error', reject);
          resolve();
        });
      });
      if (this.stopping || this.server !== server) {
        throw new Error('Creator Worker HTTP server is stopping.');
      }
      const socketAddress = server.address();
      if (
        !socketAddress ||
        typeof socketAddress === 'string' ||
        socketAddress.address !== LOOPBACK_HOST
      ) {
        throw new Error('Creator Worker did not bind the required loopback address.');
      }
      const origin = `http://${LOOPBACK_HOST}:${socketAddress.port}`;
      this.address = {
        origin,
        experienceUrl: `${origin}/#access=${encodeURIComponent(this.capability)}`,
        port: socketAddress.port,
      };
      return this.address;
    } catch (error) {
      if (server.listening) await this.ensureClosing(server);
      if (this.server === server) this.server = undefined;
      this.address = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.beginStop();
    await this.starting?.catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    this.address = undefined;
    if (!server) return;
    const closing = this.ensureClosing(server);
    server.closeIdleConnections();
    await Promise.race([closing, delay(STOP_GRACE_MS)]);
    if (!this.closed) {
      server.closeAllConnections();
      await Promise.race([closing, delay(STOP_GRACE_MS)]);
    }
  }

  beginStop(): void {
    if (this.stopping) return;
    this.stopping = true;
    const server = this.server;
    if (!server?.listening) return;
    void this.ensureClosing(server);
  }

  private ensureClosing(server: Server): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = new Promise<void>((resolve) => {
      server.close(() => {
        this.closed = true;
        resolve();
      });
    });
    return this.closing;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.applySecurityHeaders(response);
    if (this.stopping) {
      this.sendFailure(response, 503, 'WORKER_STOPPING', 'Worker 正在停止。', false);
      return;
    }
    if (!this.address || !this.hasExactHost(request, `${LOOPBACK_HOST}:${this.address.port}`)) {
      this.sendFailure(response, 400, 'BAD_REQUEST', '请求无效。', false);
      return;
    }
    if (
      !request.url ||
      !request.url.startsWith('/') ||
      request.url.startsWith('//') ||
      request.url.includes('://') ||
      request.headers.upgrade !== undefined ||
      request.method === 'CONNECT'
    ) {
      this.sendFailure(response, 400, 'BAD_REQUEST', '请求无效。', false);
      return;
    }

    const url = new URL(request.url, this.address.origin);
    if (url.search || url.hash) {
      this.sendFailure(response, 400, 'BAD_REQUEST', '请求无效。', false);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      this.sendHtml(response, renderChatPage({ nonce: this.nonce, agentName: this.agentName }));
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      this.sendFailure(response, 404, 'NOT_FOUND', '页面不存在。', false);
      return;
    }
    if (!this.authorized(request)) {
      this.sendFailure(response, 401, 'UNAUTHORIZED', '体验链接无效。', false);
      return;
    }
    if (request.headers.cookie !== undefined) {
      this.sendFailure(response, 400, 'BAD_REQUEST', '请求无效。', false);
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== this.address.origin) {
      this.sendFailure(response, 403, 'ORIGIN_REJECTED', '请求来源无效。', false);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/status') {
      this.sendSuccess<CreatorWorkerStatus>(response, this.worker.status());
      return;
    }
    if (request.method !== 'POST') {
      this.sendFailure(response, 405, 'METHOD_NOT_ALLOWED', '请求方式不支持。', false);
      return;
    }
    if (
      !this.hasExactSingleHeader(request, 'origin', this.address.origin) ||
      !this.hasExactSingleHeader(request, 'content-type', 'application/json') ||
      !this.hasExactSingleHeader(request, 'x-combo-creator-worker', '1')
    ) {
      this.sendFailure(response, 403, 'REQUEST_REJECTED', '请求来源无效。', false);
      return;
    }

    try {
      const body = await readJsonBody(request);
      if (url.pathname === '/api/conversations') {
        assertExactObject(body, []);
        this.sendSuccess(response, await this.worker.createConversation(), 201);
        return;
      }
      const messageMatch = /^\/api\/conversations\/([0-9a-f-]{36})\/messages$/.exec(url.pathname);
      if (messageMatch) {
        assertExactObject(body, ['messageId', 'text']);
        if (typeof body.messageId !== 'string' || typeof body.text !== 'string') {
          throw new CreatorWorkerError('INVALID_INPUT', 400, false);
        }
        const reply = await this.worker.sendMessage({
          conversationId: messageMatch[1]!,
          messageId: body.messageId,
          text: body.text,
        });
        this.sendSuccess(response, reply);
        return;
      }
      const interruptMatch = /^\/api\/conversations\/([0-9a-f-]{36})\/interrupt$/.exec(
        url.pathname,
      );
      if (interruptMatch) {
        assertExactObject(body, []);
        await this.worker.interrupt(interruptMatch[1]!);
        this.sendSuccess(response, { interrupted: true });
        return;
      }
      this.sendFailure(response, 404, 'NOT_FOUND', '接口不存在。', false);
    } catch (error) {
      if (error instanceof CreatorWorkerError) {
        this.sendFailure(response, error.status, error.code, error.message, error.retryable);
        return;
      }
      if (error instanceof BodyTooLargeError) {
        this.sendFailure(response, 413, 'BODY_TOO_LARGE', '请求内容过大。', false);
        return;
      }
      this.sendFailure(response, 400, 'INVALID_JSON', '请求内容无效。', false);
    }
  }

  private hasExactHost(request: IncomingMessage, expected: string): boolean {
    return this.hasExactSingleHeader(request, 'host', expected);
  }

  private hasExactSingleHeader(request: IncomingMessage, name: string, expected: string): boolean {
    let count = 0;
    let value: string | undefined;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === name) {
        count += 1;
        value = request.rawHeaders[index + 1];
      }
    }
    return count === 1 && value === expected;
  }

  private authorized(request: IncomingMessage): boolean {
    const header = this.singleHeaderValue(request, 'authorization');
    if (!header?.startsWith('Bearer ')) return false;
    const candidate = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.capability);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  private singleHeaderValue(request: IncomingMessage, name: string): string | undefined {
    let value: string | undefined;
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === name) {
        count += 1;
        value = request.rawHeaders[index + 1];
      }
    }
    return count === 1 ? value : undefined;
  }

  private applySecurityHeaders(response: ServerResponse): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        `script-src 'nonce-${this.nonce}'`,
        `style-src 'nonce-${this.nonce}'`,
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ].join('; '),
    );
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    );
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
  }

  private sendHtml(response: ServerResponse, html: string): void {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html);
  }

  private sendSuccess<T>(response: ServerResponse, data: T, status = 200): void {
    this.sendJson(response, status, { ok: true, data } satisfies ApiSuccess<T>);
  }

  private sendFailure(
    response: ServerResponse,
    status: number,
    code: string,
    message: string,
    retryable: boolean,
  ): void {
    this.sendJson(response, status, {
      ok: false,
      error: { code, message, retryable },
    } satisfies ApiFailure);
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    payload: ApiSuccess<unknown> | ApiFailure,
  ): void {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(payload));
  }
}

class BodyTooLargeError extends Error {}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid content length.');
    if (parsed > MAX_BODY_BYTES) throw new BodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('Invalid JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected object.');
  }
  return value as Record<string, unknown>;
}

function assertExactObject(value: Record<string, unknown>, expectedKeys: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new CreatorWorkerError('INVALID_INPUT', 400, false);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}
