// Fastify 装配：入口 token 鉴权、/v1/chat/completions 代理路由。流式响应
// hijack 后逐 chunk 透传 provider 字节，同时增量提取末帧 usage。
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { PaymentApiErrorResponseSchema, PaymentRequiredResponseSchema } from '@cb/payment-protocol';
import { admitPaymentCall, type PaymentAdmissionClient } from './payment-admission.js';
import type { BillingClient } from './billing.js';
import { priceFor, type PricingTable, type TokenUsage } from './pricing.js';
import { isProviderJsonSuccessPayload, type ProviderClient } from './provider.js';
import {
  checkAndHold,
  finalizeTurn,
  parseChatRequest,
  releaseHold,
  type GatewayLogger,
  type HoldOutcome,
} from './service.js';
import { createUsageExtractor, normalizeUsage } from './usage.js';

export interface GatewayAppDependencies {
  billing: BillingClient;
  paymentAdmission?: PaymentAdmissionClient;
  provider: ProviderClient;
  gatewayToken: string;
  pricing: PricingTable;
  holdFixedCostCents: number;
  defaultMaxTokens: number;
  logger?: boolean | object;
}

declare module 'fastify' {
  interface FastifyInstance {
    gatewayDeps: GatewayAppDependencies;
  }
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const candidate = createHash('sha256').update(provided, 'utf8').digest();
  const known = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidate, known);
}

function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

function sendError(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
): FastifyReply {
  const messages: Record<string, string> = {
    unauthorized: '请验证身份后再试。',
    invalid_request: '请求格式不正确，请检查后重试。',
    payment_required: '余额不足，请完成支付后继续。',
    conflict: '本次调用已处理或与原请求冲突，请查询业务状态。',
    provider_unavailable: '模型服务暂时不可用，请稍后重试。',
    billing_unavailable: '计费服务暂时不可用，请稍后重试。',
  };
  return reply.code(status).send(
    PaymentApiErrorResponseSchema.parse({
      error: {
        userMessage: messages[code] ?? '请求暂时无法完成，请稍后重试。',
        retriable: status >= 500 || status === 429,
        action:
          status === 402
            ? 'wait'
            : status >= 500
              ? 'retry'
              : status === 400
                ? 'change_input'
                : 'none',
        traceId: req.id,
      },
    }),
  );
}

function loggerOf(req: FastifyRequest): GatewayLogger {
  return {
    warn: (fields, message) => req.log.warn(fields, message),
    error: (fields, message) => req.log.error(fields, message),
  };
}

async function pumpProviderStream(
  req: FastifyRequest,
  reply: FastifyReply,
  stream: ReadableStream<Uint8Array>,
): Promise<TokenUsage | null> {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const extractor = createUsageExtractor();
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  // 客户端断开：取消上游读取，已收到的 usage 仍用于收尾。
  const onClose = () => void reader.cancel().catch(() => undefined);
  req.raw.on('close', onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reply.raw.write(Buffer.from(value));
      extractor.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    req.raw.off('close', onClose);
    reply.raw.end();
  }
  return extractor.result();
}

export async function buildApp(deps: GatewayAppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  app.decorate('gatewayDeps', deps);
  app.setErrorHandler((error, req, reply) => {
    if (reply.sent) return;
    const status =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    return sendError(
      req,
      reply,
      status >= 400 && status < 500 ? 400 : 503,
      status >= 400 && status < 500 ? 'invalid_request' : 'billing_unavailable',
    );
  });

  app.get('/health', async () => ({ status: 'ok' as const }));
  app.get('/ready', async (_req, reply) => reply.send({ status: 'ok', ready: true }));

  app.post('/v1/chat/completions', async (req, reply) => {
    if (!tokenMatches(bearerToken(req), deps.gatewayToken)) {
      return sendError(req, reply, 401, 'unauthorized');
    }
    reply.header('cache-control', 'no-store');

    const parsed = parseChatRequest(req.body, deps.defaultMaxTokens);
    if (!parsed) return sendError(req, reply, 400, 'invalid_request');

    const log = loggerOf(req);
    const logFields = { agent_id: parsed.platform.agentId, turn_id: parsed.platform.turnId };
    const price = priceFor(deps.pricing, parsed.model);

    const hold = deps.paymentAdmission
      ? await admitPaymentCall(deps.paymentAdmission, parsed, price, deps.holdFixedCostCents)
      : await checkAndHold(
          deps.billing,
          {
            platform: parsed.platform,
            price,
            maxTokens: parsed.maxTokens,
            fixedCostCents: deps.holdFixedCostCents,
          },
          log,
        );
    if (hold.kind === 'rejected') {
      if (hold.status === 402) {
        const required = PaymentRequiredResponseSchema.safeParse(hold.body);
        if (required.success)
          return reply.code(402).send({ error: { ...required.data.error, traceId: req.id } });
        return sendError(
          req,
          reply,
          deps.paymentAdmission ? 503 : 402,
          deps.paymentAdmission ? 'billing_unavailable' : 'payment_required',
        );
      }
      const status = [400, 404, 409, 429, 503].includes(hold.status) ? hold.status : 503;
      return sendError(
        req,
        reply,
        status,
        status === 409 ? 'conflict' : status === 400 ? 'invalid_request' : 'billing_unavailable',
      );
    }

    if (parsed.stream) {
      return handleStream(req, reply, deps, parsed, hold, price, log, logFields);
    }
    return handleJson(req, reply, deps, parsed, hold, price, log, logFields);
  });

  return app;
}

type Parsed = NonNullable<ReturnType<typeof parseChatRequest>>;

async function handleJson(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: GatewayAppDependencies,
  parsed: Parsed,
  hold: HoldOutcome,
  price: { input: number; output: number },
  log: GatewayLogger,
  logFields: Record<string, unknown>,
): Promise<FastifyReply> {
  let upstream;
  try {
    upstream = await deps.provider.chatCompletion(parsed.forwardBody);
  } catch (error) {
    await releaseHold(deps.billing, hold, log, logFields);
    req.log.warn({ ...logFields, err: error }, 'provider request failed');
    return sendError(req, reply, 502, 'provider_unavailable');
  }

  if (upstream.status < 200 || upstream.status >= 300) {
    await releaseHold(deps.billing, hold, log, logFields);
    return sendError(req, reply, 502, 'provider_unavailable');
  }

  if (!isProviderJsonSuccessPayload(upstream.json)) {
    await releaseHold(deps.billing, hold, log, logFields);
    req.log.warn(logFields, 'provider returned an invalid success payload');
    return sendError(req, reply, 502, 'provider_unavailable');
  }

  const usage = normalizeUsage((upstream.json as { usage?: unknown }).usage);
  await finalizeTurn(
    deps.billing,
    { hold, platform: parsed.platform, model: parsed.model, price, usage },
    log,
  );
  return reply.code(upstream.status).send(upstream.json);
}

async function handleStream(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: GatewayAppDependencies,
  parsed: Parsed,
  hold: HoldOutcome,
  price: { input: number; output: number },
  log: GatewayLogger,
  logFields: Record<string, unknown>,
): Promise<FastifyReply> {
  let upstream;
  try {
    upstream = await deps.provider.chatCompletionStream(parsed.forwardBody);
  } catch (error) {
    await releaseHold(deps.billing, hold, log, logFields);
    req.log.warn({ ...logFields, err: error }, 'provider stream request failed');
    return sendError(req, reply, 502, 'provider_unavailable');
  }

  if (!upstream.stream || upstream.status < 200 || upstream.status >= 300) {
    void upstream.stream?.cancel().catch(() => undefined);
    await releaseHold(deps.billing, hold, log, logFields);
    return sendError(req, reply, 502, 'provider_unavailable');
  }

  const usage = await pumpProviderStream(req, reply, upstream.stream);
  await finalizeTurn(
    deps.billing,
    { hold, platform: parsed.platform, model: parsed.model, price, usage },
    log,
  );
  return reply;
}
