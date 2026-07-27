import { context, trace, type Attributes } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { buildTraceparent, traceHexToUuid, uuidToTraceHex, type TraceId } from '@cb/shared';
import type { Env } from '../config/env.js';

export interface ObservabilityHandle {
  enabled: boolean;
  shutdown: () => Promise<void>;
}

let sdk: NodeSDK | undefined;

function otlpTraceUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
}

function parseResourceAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const [key, ...rest] = part.split('=');
    const value = rest.join('=');
    if (key?.trim() && value.trim()) attrs[key.trim()] = value.trim();
  }
  return attrs;
}

const BLOCKED_SPAN_ATTRIBUTE = [
  /^url\.(?:full|query)$/i,
  /^http\.(?:url|target|client_ip)$/i,
  /(?:^|\.)(?:request|response)\.headers?(?:\.|$)/i,
  /(?:^|\.)(?:cookie|set-cookie|authorization)(?:\.|$)/i,
  /(?:^|\.)(?:client|peer)\.(?:address|port)$/i,
  /^net\.(?:peer|sock\.peer)\./i,
  /^network\.peer\./i,
  /^exception\.(?:message|stacktrace)$/i,
  /(?:^|\.)(?:request|response)\.body(?:\.|$)/i,
];

function safeSpanAttributes(attributes: Attributes): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) => !BLOCKED_SPAN_ATTRIBUTE.some((pattern) => pattern.test(key)),
    ),
  );
}

function safeSpanName(name: string): string {
  const queryAt = name.indexOf('?');
  return queryAt === -1 ? name : name.slice(0, queryAt);
}

/** 在任何 span 离开进程前删除原始查询、客户端地址、头、正文与异常消息。 */
function safeReadableSpan(span: ReadableSpan): ReadableSpan {
  return {
    name: safeSpanName(span.name),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext ? { parentSpanContext: span.parentSpanContext } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes: safeSpanAttributes(span.attributes),
    links: span.links.map((link) => ({
      ...link,
      attributes: safeSpanAttributes(link.attributes ?? {}),
    })),
    events: span.events.map((event) => ({
      ...event,
      ...(event.attributes ? { attributes: safeSpanAttributes(event.attributes) } : {}),
    })),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

export function createSafeTraceExporter(delegate: SpanExporter): SpanExporter {
  return {
    export(spans, resultCallback) {
      delegate.export(spans.map(safeReadableSpan), resultCallback);
    },
    shutdown: () => delegate.shutdown(),
    ...(delegate.forceFlush ? { forceFlush: () => delegate.forceFlush!() } : {}),
  };
}

export function startNodeObservability(env: Env): ObservabilityHandle {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (env.OTEL_SDK_DISABLED === 'true' || !endpoint) {
    return { enabled: false, shutdown: async () => undefined };
  }
  if (sdk) return { enabled: true, shutdown: () => sdk!.shutdown() };

  const serviceName = env.OTEL_SERVICE_NAME || 'cb-runtime';
  const resource = resourceFromAttributes({
    ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.0',
    'service.namespace': 'combo-mvp',
    'service.instance.id': `runtime-api-${process.pid}`,
    'process.runtime.name': 'nodejs',
    'process.name': 'runtime-api',
  });

  sdk = new NodeSDK({
    resource,
    traceExporter: createSafeTraceExporter(new OTLPTraceExporter({ url: otlpTraceUrl(endpoint) })),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  return { enabled: true, shutdown: () => sdk!.shutdown() };
}

export function currentTraceId(fallbackTraceId?: TraceId): TraceId | undefined {
  const span = trace.getSpan(context.active());
  const spanContext = span?.spanContext();
  if (spanContext?.traceId) return traceHexToUuid(spanContext.traceId) ?? fallbackTraceId;
  return fallbackTraceId;
}

export function currentTraceLogFields(fallbackTraceId?: TraceId): Record<string, string> {
  const span = trace.getSpan(context.active());
  const spanContext = span?.spanContext();
  const traceId = spanContext?.traceId
    ? (traceHexToUuid(spanContext.traceId) ?? fallbackTraceId)
    : fallbackTraceId;
  const traceHex = spanContext?.traceId ?? (traceId ? uuidToTraceHex(traceId) : undefined);
  return {
    ...(traceId ? { traceId } : {}),
    ...(traceHex ? { trace_id: traceHex } : {}),
    ...(spanContext?.spanId ? { span_id: spanContext.spanId } : {}),
  };
}

export function currentTraceparent(fallbackTraceId: TraceId): string {
  const span = trace.getSpan(context.active());
  const spanContext = span?.spanContext();
  if (spanContext?.traceId && spanContext.spanId) {
    const flags = (spanContext.traceFlags & 1) === 1 ? '01' : '00';
    return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
  }
  return buildTraceparent(fallbackTraceId);
}
