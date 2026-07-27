import { readFile } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerClientEventRoutes } from '../platform/http/client-events.js';

function replyDouble(): FastifyReply {
  const reply = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply as unknown as FastifyReply;
}

describe('runtime low-sensitivity request logging', () => {
  it('logs only a fixed route bucket and drops pathname, query, message, stack, and source', async () => {
    let handler: RouteHandlerMethod | undefined;
    const app = {
      post(_path: string, routeHandler: RouteHandlerMethod) {
        handler = routeHandler;
        return this;
      },
    };
    await registerClientEventRoutes(app as never);

    const warn = vi.fn();
    const req = {
      id: 'trace-runtime-client-event',
      body: {
        kind: 'sse_error',
        traceId: 'trace-runtime-client-event',
        url: 'https://app.invalid/user@example.invalid/123456/cb_session=s1.session-credential/resend-secret?access_token=query-credential',
        route: '/fallback?token=query-credential',
        message: 'user@example.invalid entered 123456',
        stack: 'Cookie: cb_session=s1.session-credential',
        source: 'runtime-web-sensitive-context',
      },
      log: { warn },
    } as unknown as FastifyRequest;

    await (handler as RouteHandlerMethod).call(app as never, req, replyDouble());

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('"routeBucket":"unknown"');
    for (const sensitive of [
      'query-credential',
      'user@example.invalid',
      '123456',
      'session-credential',
      'runtime-web-sensitive-context',
      'access_token',
      'resend-secret',
      '/fallback',
    ]) {
      expect(logged).not.toContain(sensitive);
    }
  });

  it('disables Fastify raw request logs and records only the route template on completion', async () => {
    const source = await readFile(new URL('../bootstrap/app.ts', import.meta.url), 'utf8');
    const hookStart = source.indexOf("app.addHook('onResponse'");
    const hookEnd = source.indexOf('// —— 统一错误信封', hookStart);
    const completionHook = source.slice(hookStart, hookEnd);

    expect(source).toContain('disableRequestLogging: true');
    expect(completionHook).toContain("route: req.routeOptions.url ?? 'unmatched'");
    expect(completionHook).not.toContain('req.url');
    expect(completionHook).not.toContain('headers:');
    expect(completionHook).not.toContain('body:');
  });
});
