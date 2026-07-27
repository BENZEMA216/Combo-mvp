import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerClientEventRoutes } from '../platform/http/client-events.js';
import { createSafeTraceExporter } from '../platform/observability/node.js';

function replyDouble(): FastifyReply {
  const reply = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply as unknown as FastifyReply;
}

describe('authoring client-event logging boundary', () => {
  it('records only a fixed route bucket when every pathname segment is sensitive', async () => {
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
      id: 'trace-authoring-client-event',
      body: {
        kind: 'api_error',
        traceId: 'trace-authoring-client-event',
        url: 'https://app.invalid/user@example.invalid/654321/cb_session=s1.cookie-sentinel/resend-key-sentinel',
        route: '/also-sensitive',
        message: 'user@example.invalid entered 654321',
        stack: 'cb_session=s1.cookie-sentinel',
      },
      log: { warn },
    } as unknown as FastifyRequest;

    await (handler as RouteHandlerMethod).call(app as never, req, replyDouble());

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('"routeBucket":"unknown"');
    for (const sentinel of [
      'user@example.invalid',
      '654321',
      'cookie-sentinel',
      'resend-key-sentinel',
      '/also-sensitive',
    ]) {
      expect(logged).not.toContain(sentinel);
    }
  });
});

describe('authoring OpenTelemetry export boundary', () => {
  it('removes query credentials, client addresses, headers, bodies and exception text', async () => {
    const memory = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(createSafeTraceExporter(memory))],
    });
    const span = provider
      .getTracer('safe-export-test')
      .startSpan('GET /api/v1/connect/script?code=pairing-secret');
    span.setAttributes({
      'http.route': '/api/v1/connect/script',
      'http.target': '/api/v1/connect/script?code=pairing-secret',
      'url.full': 'https://combo.example/api/v1/connect/script?code=pairing-secret',
      'url.query': 'code=pairing-secret',
      'http.client_ip': '192.0.2.44',
      'client.address': '192.0.2.44',
      'http.request.header.authorization': 'Bearer alternate-secret',
      'http.request.header.cookie': 'cb_session=s1.cookie-secret',
      'http.request.header.x-resend-key': 'resend-secret',
      'http.request.body': 'user@example.test 123456',
    });
    span.addEvent('exception', {
      'exception.message': 'user@example.test 123456 resend-secret',
      'exception.stacktrace': 'cb_session=s1.cookie-secret',
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'pairing-secret 192.0.2.44' });
    span.end();
    await provider.forceFlush();

    const exported = memory.getFinishedSpans();
    expect(exported).toHaveLength(1);
    expect(exported[0]?.attributes['http.route']).toBe('/api/v1/connect/script');
    const serialized = JSON.stringify(
      exported.map((item) => ({
        name: item.name,
        attributes: item.attributes,
        events: item.events,
        status: item.status,
      })),
    );
    for (const sentinel of [
      'pairing-secret',
      'alternate-secret',
      'cookie-secret',
      'resend-secret',
      'user@example.test',
      '123456',
      '192.0.2.44',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    await provider.shutdown();
  });
});
