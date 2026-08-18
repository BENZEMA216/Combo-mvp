import { connect, createServer as createNetServer } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CreatorWorker } from './creator-worker.js';
import { CreatorWorkerHttpServer, type CreatorWorkerServerAddress } from './http-server.js';
import {
  createHostInterruptedTerminalEvidence,
  type CodexHost,
  type HostThread,
  type HostTurnHandle,
} from './host-types.js';

class ImmediateHost implements CodexHost {
  createThreadCount = 0;
  turnCount = 0;
  started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async createThread(): Promise<HostThread> {
    this.createThreadCount += 1;
    return {
      id: `thread-${this.createThreadCount}`,
      generation: 1,
      workspaceRootsAcknowledged: false,
    };
  }

  startTurn(input: { thread: HostThread; messageId: string; text: string }): HostTurnHandle {
    this.turnCount += 1;
    const turnId = `turn-${this.turnCount}`;
    return {
      turnId: Promise.resolve(turnId),
      result: Promise.resolve({ text: `<script>${input.text}</script>` }),
      interrupt: async () =>
        createHostInterruptedTerminalEvidence({
          threadId: input.thread.id,
          turnId,
          status: 'interrupted',
          error: null,
          completedAt: 0,
        }),
    };
  }
}

describe('CreatorWorkerHttpServer', () => {
  let host: ImmediateHost;
  let worker: CreatorWorker;
  let server: CreatorWorkerHttpServer;
  let address: CreatorWorkerServerAddress;
  let capability: string;

  beforeEach(async () => {
    host = new ImmediateHost();
    worker = new CreatorWorker({ host, turnTimeoutMs: 5_000 });
    await worker.start();
    server = new CreatorWorkerHttpServer({ worker });
    address = await server.start();
    capability = new URL(address.experienceUrl).hash.slice('#access='.length);
  });

  afterEach(async () => {
    await server.stop();
    await worker.stop();
  });

  function headers(includeJson = false): Record<string, string> {
    return {
      Authorization: `Bearer ${capability}`,
      'X-Combo-Creator-Worker': '1',
      Origin: address.origin,
      ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async function createConversation(): Promise<string> {
    const response = await fetch(`${address.origin}/api/conversations`, {
      method: 'POST',
      headers: headers(true),
      body: '{}',
    });
    const payload = (await response.json()) as { data: { conversationId: string } };
    return payload.data.conversationId;
  }

  it('binds only IPv4 loopback and keeps the capability out of HTML and query parameters', async () => {
    expect(address.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(address.experienceUrl).toBe(`${address.origin}/#access=${capability}`);
    expect(address.experienceUrl).not.toContain('?');
    expect(Buffer.from(capability, 'base64url')).toHaveLength(32);

    const response = await fetch(address.origin);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain(capability);
    expect(html).toContain('textContent');
    expect(html).not.toContain('.innerHTML');
    expect(html).not.toContain('insertAdjacentHTML');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('requires the capability for every API request', async () => {
    const missing = await fetch(`${address.origin}/api/status`);
    expect(missing.status).toBe(401);
    const wrong = await fetch(`${address.origin}/api/status`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(wrong.status).toBe(401);
    const allowed = await fetch(`${address.origin}/api/status`, { headers: headers() });
    expect(allowed.status).toBe(200);

    const duplicate = await rawHttp(
      address.port,
      `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nAuthorization: Bearer ${capability}\r\nAuthorization: Bearer ${capability}\r\nConnection: close\r\n\r\n`,
    );
    expect(duplicate).toContain('401 Unauthorized');
  });

  it('requires exact origin, JSON content type, and CSRF header for mutations', async () => {
    const cases = [
      { headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' } },
      {
        headers: {
          Authorization: `Bearer ${capability}`,
          'Content-Type': 'application/json',
          Origin: 'null',
          'X-Combo-Creator-Worker': '1',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${capability}`,
          'Content-Type': 'application/json',
          Origin: 'http://attacker.invalid',
          'X-Combo-Creator-Worker': '1',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${capability}`,
          Origin: address.origin,
          'X-Combo-Creator-Worker': '1',
          'Content-Type': 'text/plain',
        },
      },
    ];
    for (const current of cases) {
      const response = await fetch(`${address.origin}/api/conversations`, {
        method: 'POST',
        headers: current.headers,
        body: '{}',
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    const options = await fetch(`${address.origin}/api/conversations`, {
      method: 'OPTIONS',
      headers: headers(),
    });
    expect(options.status).toBe(405);
    expect(options.headers.get('access-control-allow-origin')).toBeNull();
    const duplicateOrigin = await rawHttp(
      address.port,
      `POST /api/conversations HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nAuthorization: Bearer ${capability}\r\nOrigin: ${address.origin}\r\nOrigin: ${address.origin}\r\nContent-Type: application/json\r\nX-Combo-Creator-Worker: 1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    expect(duplicateOrigin).toContain('403 Forbidden');
    expect(worker.status().conversations).toBe(0);
  });

  it('uses exact request schemas and never accepts path or Host policy overrides', async () => {
    for (const body of [
      { project: '/private/project' },
      { cwd: '/private/project' },
      { model: 'unsafe' },
      { tools: ['unsafe'] },
      { instructions: 'override' },
      JSON.parse('{"__proto__":null}') as Record<string, unknown>,
    ]) {
      const response = await fetch(`${address.origin}/api/conversations`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(host.createThreadCount).toBe(0);
  });

  it('returns model text as JSON data without rendering it into the server HTML', async () => {
    const conversationId = await createConversation();
    const response = await fetch(`${address.origin}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ messageId: 'message-1', text: '<img src=x onerror=alert(1)>' }),
    });
    const payload = (await response.json()) as { data: { text: string } };
    expect(response.status).toBe(200);
    expect(payload.data.text).toBe('<script><img src=x onerror=alert(1)></script>');
    const page = await (await fetch(address.origin)).text();
    expect(page).not.toContain('<img src=x onerror=alert(1)>');
    expect(host.createThreadCount).toBe(1);
    expect(host.turnCount).toBe(1);
  });

  it('rejects oversized content and unknown fields without invoking the Worker Host', async () => {
    const conversationId = await createConversation();
    const oversized = await fetch(
      `${address.origin}/api/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ messageId: 'large', text: 'x'.repeat(20_000) }),
      },
    );
    expect(oversized.status).toBe(413);
    const unknown = await fetch(`${address.origin}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ messageId: 'm', text: 'ok', cwd: '/private/project' }),
    });
    expect(unknown.status).toBe(400);

    for (const body of [
      { messageId: 'x'.repeat(129), text: 'ok' },
      { messageId: 'within-limit', text: 'x'.repeat(4_001) },
    ]) {
      const boundary = await fetch(
        `${address.origin}/api/conversations/${conversationId}/messages`,
        {
          method: 'POST',
          headers: headers(true),
          body: JSON.stringify(body),
        },
      );
      expect(boundary.status).toBe(400);
    }

    const oversizedChunk = 'x'.repeat(17_000);
    const chunked = await rawHttp(
      address.port,
      `POST /api/conversations/${conversationId}/messages HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nAuthorization: Bearer ${capability}\r\nOrigin: ${address.origin}\r\nContent-Type: application/json\r\nX-Combo-Creator-Worker: 1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${oversizedChunk.length.toString(16)}\r\n${oversizedChunk}\r\n0\r\n\r\n`,
    );
    expect(chunked).toContain('413 Payload Too Large');
    expect(host.turnCount).toBe(0);
  });

  it('rejects DNS rebinding, duplicate Host, and absolute-form request targets', async () => {
    const expectedHost = `127.0.0.1:${address.port}`;
    const badHost = await rawHttp(
      address.port,
      `GET / HTTP/1.1\r\nHost: attacker.invalid\r\nConnection: close\r\n\r\n`,
    );
    expect(badHost).toContain('400 Bad Request');

    const duplicateHost = await rawHttp(
      address.port,
      `GET / HTTP/1.1\r\nHost: ${expectedHost}\r\nHost: ${expectedHost}\r\nConnection: close\r\n\r\n`,
    );
    expect(duplicateHost).toMatch(/400 Bad Request|HTTP\/1\.1 400/);

    const absolute = await rawHttp(
      address.port,
      `GET http://attacker.invalid/ HTTP/1.1\r\nHost: ${expectedHost}\r\nConnection: close\r\n\r\n`,
    );
    expect(absolute).toContain('400 Bad Request');

    const missingHost = await rawHttp(address.port, 'GET / HTTP/1.0\r\nConnection: close\r\n\r\n');
    expect(missingHost).toContain('400 Bad Request');
  });

  it('never includes local implementation details in API failures', async () => {
    const conversationId = await createConversation();
    const response = await fetch(`${address.origin}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ messageId: 'bad id with spaces', text: '/private/project secret' }),
    });
    const body = await response.text();
    expect(response.status).toBe(400);
    expect(body).not.toContain('/private/project');
    expect(body).not.toContain('thread-');
    expect(body).not.toContain('stack');
  });
});

describe('CreatorWorkerHttpServer lifecycle', () => {
  it('coalesces concurrent starts and closes a listener when stop wins the start race', async () => {
    const worker = new CreatorWorker({ host: new ImmediateHost(), turnTimeoutMs: 5_000 });
    await worker.start();

    const concurrent = new CreatorWorkerHttpServer({ worker });
    const [first, second] = await Promise.all([concurrent.start(), concurrent.start()]);
    expect(second).toEqual(first);
    await concurrent.stop();

    const port = await reserveLoopbackPort();
    const racing = new CreatorWorkerHttpServer({ worker, port });
    const starting = racing.start();
    racing.beginStop();
    await expect(starting).rejects.toThrow('stopping');
    await racing.stop();
    await expect(bindAndClose(port)).resolves.toBeUndefined();

    await worker.stop();
  });
});

function rawHttp(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('end', () => resolve(response));
    socket.once('connect', () => socket.end(request));
  });
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address.');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function bindAndClose(port: number): Promise<void> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
