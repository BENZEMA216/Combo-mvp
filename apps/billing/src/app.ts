// Fastify 装配：路由、内部/管理 token 鉴权与错误形态。buildApp 不监听端口，
// 进程入口（index.ts）与测试（app.inject）共用同一份装配。
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type preHandlerHookHandler,
} from 'fastify';
import { z } from 'zod';
import { HOLD_TTL_SECONDS, availableBalance, type BillingStore } from './service.js';

export interface BillingAppDependencies {
  store: BillingStore;
  internalToken: string;
  adminToken: string;
  overdraftHardLimitCents: number;
  /** /ready 探针：检查 PostgreSQL 可达性。 */
  readiness?: () => Promise<boolean>;
  logger?: boolean | object;
}

declare module 'fastify' {
  interface FastifyInstance {
    billingDeps: BillingAppDependencies;
  }
}

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_FREE_PATTERN = /^[^\p{Cc}\p{Cs}]+$/u;
const SafePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SafeNonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ControlFreeText128Schema = z.string().min(1).max(128).regex(CONTROL_FREE_PATTERN);

const HoldBodySchema = z
  .object({
    user_id: z.string().regex(UUID_PATTERN),
    agent_id: z.string().regex(AGENT_ID_PATTERN),
    turn_id: ControlFreeText128Schema,
    estimated_amount: SafePositiveIntegerSchema,
  })
  .strict();

const SettleBodySchema = z
  .object({
    hold_id: z.string().regex(UUID_PATTERN),
    actual_amount: SafeNonNegativeIntegerSchema,
  })
  .strict();

const MeteringBodySchema = z
  .object({
    agent_id: z.string().regex(AGENT_ID_PATTERN),
    user_id: z.string().regex(UUID_PATTERN),
    turn_id: ControlFreeText128Schema,
    hold_id: z.string().regex(UUID_PATTERN).optional(),
    dimension: z.enum([
      'llm_token_in',
      'llm_token_out',
      'tts_char',
      'image_gen',
      'retrieval_call',
      'audio_second',
    ]),
    quantity: SafePositiveIntegerSchema,
    model: ControlFreeText128Schema.optional(),
    unit_cost: SafeNonNegativeIntegerSchema.optional(),
    source: z.enum(['gateway', 'agent_report']),
    idempotency_key: ControlFreeText128Schema,
  })
  .strict();

const AdminRechargeBodySchema = z
  .object({
    user_id: z.string().regex(UUID_PATTERN),
    amount: SafePositiveIntegerSchema,
    idempotency_key: ControlFreeText128Schema,
    ref_id: ControlFreeText128Schema.optional(),
  })
  .strict();

const NO_STORE = 'no-store';

type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'payment_required'
  | 'unavailable';

function sendError(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  data?: unknown,
): FastifyReply {
  return reply
    .code(status)
    .send({ error: { code }, ...(data ? { data } : {}), meta: { traceId: req.id } });
}

/** Bearer token 恒定时间比较；先哈希再比，避免长度泄露与 Early-exit。 */
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

function requireToken(kind: 'internal' | 'admin'): preHandlerHookHandler {
  return async (req, reply) => {
    const deps = req.server.billingDeps;
    const expected = kind === 'internal' ? deps.internalToken : deps.adminToken;
    if (!tokenMatches(bearerToken(req), expected)) {
      return sendError(req, reply, 401, 'unauthorized');
    }
  };
}

function walletData(wallet: {
  userId: string;
  principalBalance: number;
  bonusBalance: number;
  heldAmount: number;
}) {
  return {
    userId: wallet.userId,
    principalBalance: wallet.principalBalance,
    bonusBalance: wallet.bonusBalance,
    heldAmount: wallet.heldAmount,
    availableBalance: availableBalance(wallet),
  };
}

export async function buildApp(deps: BillingAppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  app.decorate('billingDeps', deps);

  const internal = { preHandler: [requireToken('internal')] };
  const admin = { preHandler: [requireToken('admin')] };

  app.get('/health', async () => ({ status: 'ok' as const }));

  app.get('/ready', async (_req, reply) => {
    const ready = deps.readiness ? await deps.readiness() : true;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', ready });
  });

  // 余额 + 冻结读模型（SDK 消费）。无钱包行的用户返回全零视图。
  app.get('/billing/wallets/:user_id', internal, async (req, reply) => {
    reply.header('cache-control', NO_STORE);
    const { user_id: userId } = req.params as { user_id: string };
    if (!UUID_PATTERN.test(userId)) return sendError(req, reply, 400, 'invalid_request');

    try {
      const wallet = await deps.store.readWallet(userId);
      const view = wallet ?? {
        userId,
        principalBalance: 0,
        bonusBalance: 0,
        heldAmount: 0,
      };
      return reply.code(200).send({ data: walletData(view), meta: { traceId: req.id } });
    } catch (error) {
      req.log.warn({ err: error }, 'wallet read failed');
      return sendError(req, reply, 503, 'unavailable');
    }
  });

  // 预授权：同步事务、turn_id 幂等。余额不足 402 + 当前钱包；负余额硬停也是 402，reason 区分。
  app.post('/billing/holds', internal, async (req, reply) => {
    reply.header('cache-control', NO_STORE);
    const parsed = HoldBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, 400, 'invalid_request');

    try {
      const outcome = await deps.store.createHold({
        userId: parsed.data.user_id,
        agentId: parsed.data.agent_id,
        turnId: parsed.data.turn_id,
        estimatedAmount: parsed.data.estimated_amount,
        overdraftHardLimitCents: deps.overdraftHardLimitCents,
      });
      if (outcome.kind === 'invalid_user') {
        return sendError(req, reply, 404, 'not_found', { reason: 'user_not_found' });
      }
      if (outcome.kind === 'insufficient' || outcome.kind === 'overdraft_blocked') {
        return sendError(req, reply, 402, 'payment_required', {
          reason: outcome.kind,
          wallet: walletData(outcome.wallet),
        });
      }
      if (outcome.kind === 'conflict') {
        return sendError(req, reply, 409, 'conflict', { reason: outcome.reason });
      }
      return reply.code(outcome.replayed ? 200 : 201).send({
        data: {
          hold_id: outcome.hold.id,
          status: outcome.hold.status,
          expires_at: outcome.hold.expiresAt.toISOString(),
          expires_in_seconds: HOLD_TTL_SECONDS,
          replayed: outcome.replayed,
        },
        meta: { traceId: req.id },
      });
    } catch (error) {
      req.log.warn({ err: error }, 'hold creation failed');
      return sendError(req, reply, 503, 'unavailable');
    }
  });

  // 结算：hold_id 幂等，先赠后本扣减并解冻差额；已释放/过期的 hold 返回 409。
  app.post('/billing/settlements', internal, async (req, reply) => {
    reply.header('cache-control', NO_STORE);
    const parsed = SettleBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, 400, 'invalid_request');

    try {
      const outcome = await deps.store.settleHold({
        holdId: parsed.data.hold_id,
        actualAmount: parsed.data.actual_amount,
      });
      if (outcome.kind === 'not_found') return sendError(req, reply, 404, 'not_found');
      if (outcome.kind === 'conflict') {
        return sendError(req, reply, 409, 'conflict', { reason: outcome.reason });
      }
      if (outcome.kind === 'invalid_state') {
        return sendError(req, reply, 409, 'conflict', { status: outcome.hold.status });
      }
      return reply.code(200).send({
        data: {
          hold_id: outcome.hold.id,
          status: outcome.hold.status,
          actual_amount: outcome.hold.actualAmount,
          deductions: outcome.deductions,
          released_amount: outcome.hold.estimatedAmount - (outcome.hold.actualAmount ?? 0),
          estimated_usage_recorded: outcome.estimatedUsageRecorded,
          replayed: outcome.replayed,
        },
        meta: { traceId: req.id },
      });
    } catch (error) {
      req.log.warn({ err: error }, 'settlement failed');
      return sendError(req, reply, 503, 'unavailable');
    }
  });

  // 网关推账：计量事实源，一次性写。
  app.post('/metering/events', internal, async (req, reply) => {
    reply.header('cache-control', NO_STORE);
    const parsed = MeteringBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, 400, 'invalid_request');

    try {
      const inserted = await deps.store.insertMeteringEvent({
        agentId: parsed.data.agent_id,
        userId: parsed.data.user_id,
        turnId: parsed.data.turn_id,
        holdId: parsed.data.hold_id,
        dimension: parsed.data.dimension,
        quantity: parsed.data.quantity,
        model: parsed.data.model,
        unitCost: parsed.data.unit_cost,
        source: parsed.data.source,
        idempotencyKey: parsed.data.idempotency_key,
      });
      if (inserted.kind === 'conflict') {
        return sendError(req, reply, 409, 'conflict', { reason: inserted.reason });
      }
      return reply.code(inserted.replayed ? 200 : 201).send({
        data: { id: inserted.id, replayed: inserted.replayed },
        meta: { traceId: req.id },
      });
    } catch (error) {
      req.log.warn({ err: error }, 'metering event insert failed');
      return sendError(req, reply, 503, 'unavailable');
    }
  });

  // 验证期手工充值：管理 token 鉴权，本金桶入账，幂等键重放返回原结果。
  app.post('/billing/admin/recharges', admin, async (req, reply) => {
    reply.header('cache-control', NO_STORE);
    const parsed = AdminRechargeBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, 400, 'invalid_request');

    try {
      const outcome = await deps.store.adminRecharge({
        userId: parsed.data.user_id,
        amount: parsed.data.amount,
        idempotencyKey: parsed.data.idempotency_key,
        refId: parsed.data.ref_id,
      });
      if (outcome.kind === 'invalid_user') {
        return sendError(req, reply, 404, 'not_found', { reason: 'user_not_found' });
      }
      if (outcome.kind === 'conflict') {
        return sendError(req, reply, 409, 'conflict', { reason: outcome.reason });
      }
      return reply.code(outcome.replayed ? 200 : 201).send({
        data: { wallet: walletData(outcome.wallet), replayed: outcome.replayed },
        meta: { traceId: req.id },
      });
    } catch (error) {
      req.log.warn({ err: error }, 'admin recharge failed');
      return sendError(req, reply, 503, 'unavailable');
    }
  });

  return app;
}
