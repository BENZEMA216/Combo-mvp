import { describe, expect, it, vi } from 'vitest';
import type {
  SandboxCapabilityInput,
  SandboxCapabilitySigner,
} from '../platform/infra/sandbox-capability.js';
import { SandboxClient } from '../platform/infra/sandbox-client.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function signerFixture() {
  const calls: SandboxCapabilityInput[] = [];
  const signer: SandboxCapabilitySigner = {
    async sign(input) {
      calls.push(input);
      return 'signed-capability';
    },
    publicKeyBase64: () => 'public',
  };
  return { signer, calls };
}

describe('SandboxClient', () => {
  it('signs each exact JSON request and sends Session/Pod identity only in headers', async () => {
    const { signer, calls } = signerFixture();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer signed-capability',
        'X-Sandbox-Session-Id': 'session-1',
        'X-Sandbox-Pod-Uid': 'pod-1',
      });
      expect(init?.redirect).toBe('error');
      return jsonResponse({ content: 'hello', sizeBytes: 5, offset: 0, truncated: false });
    });
    const client = new SandboxClient({
      baseUrl: 'http://sandbox.test:8080',
      sessionId: 'session-1',
      podUid: 'pod-1',
      signer,
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.read({ path: 'note.txt' })).resolves.toMatchObject({ content: 'hello' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: 'read',
      sessionId: 'session-1',
      podUid: 'pod-1',
    });
    expect(new TextDecoder().decode(calls[0]?.body)).toBe('{"path":"note.txt"}');
  });

  it('parses one bounded NDJSON command protocol and preserves the terminal result', async () => {
    const { signer } = signerFixture();
    const payload = [
      { type: 'start', commandId: 'command-1' },
      {
        type: 'output',
        commandId: 'command-1',
        stream: 'stdout',
        encoding: 'base64',
        data: Buffer.from('hello\n').toString('base64'),
      },
      {
        type: 'exit',
        commandId: 'command-1',
        exitCode: 0,
        durationMs: 12,
      },
    ]
      .map((frame) => JSON.stringify(frame))
      .join('\n');
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(payload, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        }),
      ),
    );
    const client = new SandboxClient({
      baseUrl: 'http://sandbox.test:8080',
      sessionId: 'session-1',
      podUid: 'pod-1',
      signer,
      fetch: fetch as typeof globalThis.fetch,
    });
    const frames: unknown[] = [];
    const result = await client.command(
      { commandId: 'command-1', command: 'printf hello' },
      (frame) => frames.push(frame),
    );
    expect(frames).toHaveLength(3);
    expect(result).toEqual({
      commandId: 'command-1',
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      truncated: false,
      durationMs: 12,
    });
  });

  it('decodes base64 output incrementally without corrupting UTF-8 split across frames', async () => {
    const { signer } = signerFixture();
    const utf8 = Buffer.from('你');
    const payload = [
      { type: 'start', commandId: 'command-1' },
      {
        type: 'output',
        commandId: 'command-1',
        stream: 'stdout',
        encoding: 'base64',
        data: utf8.subarray(0, 2).toString('base64'),
      },
      {
        type: 'output',
        commandId: 'command-1',
        stream: 'stdout',
        encoding: 'base64',
        data: utf8.subarray(2).toString('base64'),
      },
      { type: 'exit', commandId: 'command-1', exitCode: 0 },
    ]
      .map((frame) => JSON.stringify(frame))
      .join('\n');
    const client = new SandboxClient({
      baseUrl: 'http://sandbox.test:8080',
      sessionId: 'session-1',
      podUid: 'pod-1',
      signer,
      fetch: (async () => new Response(payload)) as typeof globalThis.fetch,
    });
    let output = '';
    await client.command({ commandId: 'command-1', command: 'printf 你' }, (frame) => {
      if (frame.type === 'output') output += frame.data;
    });
    expect(output).toBe('你');
  });

  it('accepts many bounded frames delivered in one large transport chunk', async () => {
    const { signer } = signerFixture();
    const frames = [
      { type: 'start', commandId: 'command-1' },
      ...Array.from({ length: 20 }, () => ({
        type: 'output',
        commandId: 'command-1',
        stream: 'stdout',
        encoding: 'base64',
        data: Buffer.from('x'.repeat(2_000)).toString('base64'),
      })),
      { type: 'exit', commandId: 'command-1', exitCode: 0 },
    ];
    const client = new SandboxClient({
      baseUrl: 'http://sandbox.test:8080',
      sessionId: 'session-1',
      podUid: 'pod-1',
      signer,
      fetch: (async () =>
        new Response(
          frames.map((frame) => JSON.stringify(frame)).join('\n'),
        )) as typeof globalThis.fetch,
    });
    await expect(
      client.command({ commandId: 'command-1', command: 'many' }, () => undefined),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it('rejects oversized or identity-mismatched command frames without returning raw data', async () => {
    const { signer } = signerFixture();
    const oversized = JSON.stringify({
      type: 'output',
      commandId: 'command-1',
      stream: 'stdout',
      encoding: 'base64',
      data: Buffer.from('secret'.repeat(20_000)).toString('base64'),
    });
    const client = new SandboxClient({
      baseUrl: 'http://sandbox.test:8080',
      sessionId: 'session-1',
      podUid: 'pod-1',
      signer,
      fetch: (async () => new Response(oversized)) as typeof globalThis.fetch,
      onCancelFailure: async () => undefined,
    });
    await expect(
      client.command({ commandId: 'command-1', command: 'x' }, () => undefined),
    ).rejects.toThrow('安全上限');
  });

  it('keeps the command stream open until an authenticated Abort cancel confirms cleanup', async () => {
    const { signer, calls } = signerFixture();
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    let releaseCancel!: () => void;
    const cancelCleanup = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const commandTransport: { signal: AbortSignal | null } = { signal: null };
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/commands')) {
        commandTransport.signal = init?.signal ?? null;
        commandStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      expect(String(url)).toContain('/v1/commands/command-1/cancel');
      expect(init?.signal?.aborted).toBe(false);
      await cancelCleanup;
      return jsonResponse({ cancelled: true });
    });
    const client = new SandboxClient({
      baseUrl: 'http://sandbox.test:8080',
      sessionId: 'session-1',
      podUid: 'pod-1',
      signer,
      fetch: fetch as typeof globalThis.fetch,
    });
    const controller = new AbortController();
    const running = client.command(
      { commandId: 'command-1', command: 'sleep 30' },
      () => undefined,
      controller.signal,
    );
    let settled = false;
    void running
      .catch(() => undefined)
      .finally(() => {
        settled = true;
      });
    await started;
    controller.abort();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(commandTransport.signal?.aborted).toBe(false);
    expect(settled).toBe(false);
    releaseCancel();
    await expect(running).rejects.toMatchObject({ code: 'aborted' });
    expect(commandTransport.signal?.aborted).toBe(true);
    expect(calls.map((call) => call.operation)).toEqual(['command', 'cancel']);
    expect(calls[1]?.target).toBe('command-1');
  });

  it('propagates recycle failure instead of treating an unconfirmed cancel as safe', async () => {
    const { signer } = signerFixture();
    const recycle = vi.fn(async () => Promise.reject(new Error('control plane unavailable')));
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/cancel')) throw new Error('cancel transport failed');
      return new Response(
        JSON.stringify({ type: 'error', commandId: 'command-1', error: 'process_cleanup_failed' }),
      );
    });
    const client = new SandboxClient({
      baseUrl: 'http://sandbox.test:8080',
      sessionId: 'session-1',
      podUid: 'pod-1',
      signer,
      fetch: fetch as typeof globalThis.fetch,
      onCancelFailure: recycle,
    });
    await expect(
      client.command({ commandId: 'command-1', command: 'x' }, () => undefined),
    ).rejects.toThrow('无法确认');
    expect(recycle).toHaveBeenCalledWith('command-1');
  });

  it('recycles the exact Pod when a protocol failure has no live command to cancel', async () => {
    const { signer } = signerFixture();
    const recycle = vi.fn(async () => undefined);
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/cancel')) return jsonResponse({ cancelled: false });
      return new Response(
        JSON.stringify({ type: 'error', commandId: 'command-1', error: 'process_cleanup_failed' }),
        { headers: { 'content-type': 'application/x-ndjson' } },
      );
    });
    const client = new SandboxClient({
      baseUrl: 'http://sandbox.test:8080',
      sessionId: 'session-1',
      podUid: 'pod-1',
      signer,
      fetch: fetch as typeof globalThis.fetch,
      onCancelFailure: recycle,
    });
    await expect(
      client.command({ commandId: 'command-1', command: 'x' }, () => undefined),
    ).rejects.toThrow('未能启动');
    expect(recycle).toHaveBeenCalledWith('command-1');
  });

  it('settles a black-holed ordinary HTTP request on its own hard timeout', async () => {
    const { signer } = signerFixture();
    const client = new SandboxClient({
      baseUrl: 'http://sandbox.test:8080',
      sessionId: 'session-1',
      podUid: 'pod-1',
      signer,
      requestTimeoutMs: 20,
      fetch: (() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch,
    });
    const started = Date.now();
    await expect(client.read({ path: 'note.txt' })).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('settles a black-holed command transport and requires Pod recycle evidence', async () => {
    const { signer } = signerFixture();
    const recycle = vi.fn(async () => undefined);
    const fetch = vi.fn((url: string | URL | Request) => {
      if (String(url).endsWith('/cancel')) return Promise.reject(new Error('cancel unavailable'));
      return new Promise<Response>(() => undefined);
    });
    const client = new SandboxClient({
      baseUrl: 'http://sandbox.test:8080',
      sessionId: 'session-1',
      podUid: 'pod-1',
      signer,
      requestTimeoutMs: 20,
      commandTransportTimeoutMs: 20,
      fetch: fetch as typeof globalThis.fetch,
      onCancelFailure: recycle,
    });
    const started = Date.now();
    await expect(
      client.command({ commandId: 'command-1', command: 'sleep 30' }, () => undefined),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(recycle).toHaveBeenCalledWith('command-1');
  });

  it('rejects malformed success bodies instead of trusting TypeScript-only response types', async () => {
    const { signer } = signerFixture();
    const client = new SandboxClient({
      baseUrl: 'http://sandbox.test:8080',
      sessionId: 'session-1',
      podUid: 'pod-1',
      signer,
      fetch: (async () =>
        jsonResponse({
          content: 42,
          sizeBytes: 2,
          offset: 0,
          truncated: false,
        })) as typeof globalThis.fetch,
    });
    await expect(client.read({ path: 'note.txt' })).rejects.toThrow('无效响应');
  });

  it('maps sandbox errors to stable redacted messages', async () => {
    const { signer } = signerFixture();
    const client = new SandboxClient({
      baseUrl: 'http://sandbox.test:8080',
      sessionId: 'session-1',
      podUid: 'pod-1',
      signer,
      fetch: (async () =>
        jsonResponse(
          {
            error: {
              code: 'invalid_path',
              message: 'raw /etc/passwd and token secret must not escape',
            },
          },
          400,
        )) as typeof globalThis.fetch,
    });
    await expect(client.read({ path: '../etc/passwd' })).rejects.toThrow('相对路径');
    await expect(client.read({ path: '../etc/passwd' })).rejects.not.toThrow('token secret');
  });
});
