import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { createSafeTraceExporter } from '../platform/observability/node.js';

describe('runtime OpenTelemetry export boundary', () => {
  it('removes query credentials, client addresses, headers, bodies and exception text', async () => {
    const memory = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(createSafeTraceExporter(memory))],
    });
    const span = provider
      .getTracer('safe-export-test')
      .startSpan('GET /api/v1/runtime/sessions/id/stream?access_token=query-secret');
    span.setAttributes({
      'http.route': '/api/v1/runtime/sessions/:id/stream',
      'http.target': '/api/v1/runtime/sessions/id/stream?access_token=query-secret',
      'url.full':
        'https://combo.example/api/v1/runtime/sessions/id/stream?access_token=query-secret',
      'url.query': 'access_token=query-secret',
      'network.peer.address': '198.51.100.17',
      'net.sock.peer.addr': '198.51.100.17',
      'http.request.header.authorization': 'Bearer alternate-secret',
      'http.request.header.cookie': 'cb_session=s1.cookie-secret',
      'http.request.header.x-resend-key': 'resend-secret',
      'http.request.body': 'user@example.test 123456',
    });
    span.addEvent('exception', {
      'exception.message': 'user@example.test 123456 resend-secret',
      'exception.stacktrace': 'cb_session=s1.cookie-secret',
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'query-secret 198.51.100.17' });
    span.end();
    await provider.forceFlush();

    const exported = memory.getFinishedSpans();
    expect(exported).toHaveLength(1);
    expect(exported[0]?.attributes['http.route']).toBe('/api/v1/runtime/sessions/:id/stream');
    const serialized = JSON.stringify(
      exported.map((item) => ({
        name: item.name,
        attributes: item.attributes,
        events: item.events,
        status: item.status,
      })),
    );
    for (const sentinel of [
      'query-secret',
      'alternate-secret',
      'cookie-secret',
      'resend-secret',
      'user@example.test',
      '123456',
      '198.51.100.17',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    await provider.shutdown();
  });
});
