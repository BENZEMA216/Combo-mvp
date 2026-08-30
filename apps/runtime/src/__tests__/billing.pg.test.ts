import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestCreatorAgentPackageFile } from '@cb/creator-agent-protocol/agent-package';
import {
  createCreatorKnowledgeBundle,
  digestCreatorKnowledgeBundle,
} from '@cb/creator-agent-protocol/knowledge-bundle';
import type { CapabilityDefinition, KnowledgeAgentBinding } from '@cb/shared';
import {
  createUsageBillingService,
  UsageRequestConflictError,
  type UsageRequest,
} from '../modules/billing/service.js';
import { createTurnRunner, TurnAdmissionUnavailableError } from '../modules/agent/run-turn.js';
import {
  createTurn,
  finishTurnCas,
  getRunningTurnId,
  lockRunningTurn,
  lockTurnSession,
} from '../modules/agent/turn-repo.js';
import {
  appendTurnMessage,
  createSession,
  getOrCreateStudioSession,
  lockActiveSession,
  type SessionRow,
} from '../modules/session/repo.js';
import { toRuntimeDb, withTransaction, type RuntimeDb } from '../platform/infra/db.js';
import { createSessionEventBus } from '../platform/infra/event-bus.js';
import { createInterruptBus } from '../platform/infra/redis-interrupt-bus.js';
import type { KnowledgeAgentTestGate } from '../platform/config/env.js';
import {
  knowledgeQuestionDigest,
  type ResolvedKnowledgeAgent,
} from '../modules/knowledge-agent/resolver.js';
import {
  FakeObjectStore,
  FakeSessionEventLog,
  makeFakeAgentFactory,
  silentLog,
  waitFor,
} from './fakes.js';

const enabled =
  process.env.BILLING_PG_TEST === '1' &&
  Boolean(process.env.BILLING_TEST_DATABASE_URL && process.env.BILLING_RUNTIME_TEST_DATABASE_URL);
const pgDescribe = enabled ? describe : describe.skip;

const DEFINITION: CapabilityDefinition = {
  version: 1,
  name: '计费并发测试',
  summary: '验证真实 PostgreSQL 入场与结算',
  kind: 'writing',
  instructions: '完成测试任务。',
  inputs: [],
  starterPrompts: [],
  meta: {},
};

interface SeededBillingChain {
  creatorUserId: string;
  consumerUserId: string;
  taskId: string;
  capabilityId: string;
  session: SessionRow;
}

interface SeededKnowledgeChain extends SeededBillingChain {
  binding: KnowledgeAgentBinding;
  resolved: ResolvedKnowledgeAgent;
  gate: KnowledgeAgentTestGate;
  question: string;
  answer: string;
  chunkId: string;
}

const RUNTIME_SOURCE_SHA = 'd'.repeat(40);

pgDescribe('Agent billing PostgreSQL concurrency', () => {
  let pool: Pool;
  let db: RuntimeDb;
  let runtimePool: Pool;
  let runtimeDb: RuntimeDb;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.BILLING_TEST_DATABASE_URL,
      max: 8,
    });
    db = toRuntimeDb(pool);
    runtimePool = new Pool({
      connectionString: process.env.BILLING_RUNTIME_TEST_DATABASE_URL,
      max: 8,
    });
    runtimeDb = toRuntimeDb(runtimePool);
    const identity = await runtimeDb.query<{ current_user: string }>(
      'SELECT current_user::text AS current_user',
    );
    if (identity.rows[0]?.current_user !== 'combo_runtime') {
      throw new Error('billing runtime test connection must use combo_runtime');
    }
    const schema = await db.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN (
            'billing_accounts',
            'billing_free_allowances',
            'usage_charges',
            'wallet_ledger',
            'agent_packages',
            'agent_package_releases',
            'agent_usage_receipts'
          )`,
    );
    if (schema.rows.length !== 7) throw new Error('knowledge billing migrations are not applied');
    const migration = await db.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`,
    );
    if (migration.rows[0]?.filename !== '0018_agent_session_usage_receipts.sql') {
      throw new Error('knowledge billing migration head is not 0018');
    }
  });

  afterAll(async () => {
    // 资金流水是强制只追加的；本测试只允许连接专用测试库，并使用随机标识，
    // 不尝试清理或改写账本。测试库应由外层 fixture 整体重建。
    await runtimePool?.end();
    await pool?.end();
  });

  async function seedChain(): Promise<SeededBillingChain> {
    const suffix = randomUUID().replaceAll('-', '');
    const accountPart = (offset: number): string =>
      suffix.slice(offset, offset + 8).replace(/[0189]/g, 'a');
    const creator = await db.query<{ id: string }>(
      `INSERT INTO users (account)
       VALUES ($1)
       RETURNING id`,
      [`creator-${accountPart(0)}`],
    );
    const consumer = await db.query<{ id: string }>(
      `INSERT INTO users (account)
       VALUES ($1)
       RETURNING id`,
      [`creator-${accountPart(8)}`],
    );
    const creatorUserId = creator.rows[0]!.id;
    const consumerUserId = consumer.rows[0]!.id;
    const task = await db.query<{ id: string }>(
      `INSERT INTO tasks (owner_user_id, idempotency_key)
       VALUES ($1, $2)
       RETURNING id`,
      [creatorUserId, `billing-task-${suffix}`],
    );
    const taskId = task.rows[0]!.id;
    const capability = await db.query<{ id: string }>(
      `INSERT INTO capabilities
         (task_id, owner_user_id, name, storage_key, published)
       VALUES ($1, $2, 'billing concurrency', $3, true)
       RETURNING id`,
      [taskId, creatorUserId, `billing/${suffix}.json`],
    );
    const capabilityId = capability.rows[0]!.id;
    const session = await createSession(db, {
      capabilityId,
      ownerUserId: consumerUserId,
    });
    // Seed funds through the same immutable recharge-credit equation used by
    // production. A direct balance mutation is intentionally rejected by 0009.
    await withTransaction(db, async (transaction) => {
      const recharge = await transaction.query<{ id: string }>(
        `INSERT INTO recharge_orders (
           order_no, owner_user_id, client_idempotency_key, package_id, amount_cents,
           payment_method, gateway_environment, institution_no, merchant_no,
           pay_trace_no, pay_time, payment_status, credit_status,
           platform_trade_no, paid_at, credited_at
         )
         VALUES (
           $1, $2, $3, 'manual', 100,
           'qr', 'test', 'INST0001', 'MCH_TEST_001',
           $4, '20260728120000', 'succeeded', 'credited', $5, now(), now()
         )
         RETURNING id`,
        [
          `CBR-RUNTIME-${suffix}`,
          consumerUserId,
          `runtime-credit-${suffix}`,
          `TRACE-RUNTIME-${suffix}`,
          `TRADE-RUNTIME-${suffix}`,
        ],
      );
      const rechargeOrderId = recharge.rows[0]?.id;
      if (!rechargeOrderId) throw new Error('recharge seed returned no row');
      await transaction.query(
        `INSERT INTO billing_accounts (owner_user_id, balance_cents, reserved_cents)
         VALUES ($1, 100, 0)`,
        [consumerUserId],
      );
      await transaction.query(
        `INSERT INTO wallet_ledger (
           owner_user_id, entry_type, amount_cents, recharge_order_id, usage_charge_id
         )
         VALUES ($1, 'recharge_credit', 100, $2, NULL)`,
        [consumerUserId, rechargeOrderId],
      );
    });
    const chain = { creatorUserId, consumerUserId, taskId, capabilityId, session };
    return chain;
  }

  async function seedKnowledgeChain(): Promise<SeededKnowledgeChain> {
    const chain = await seedChain();
    const suffix = randomUUID().replaceAll('-', '');
    const packageDigest = `sha256:${suffix}${suffix}` as const;
    const releaseId = `release.agent-package.${suffix}` as const;
    const chunkId = `chunk.knowledge.${suffix}` as const;
    const content = 'Combo 的前三次成功回答使用免费额度。';
    const knowledge = createCreatorKnowledgeBundle({
      protocol: 'combo.knowledge-bundle/1',
      chunks: [
        {
          id: chunkId,
          source: {
            sourceId: `source.knowledge.${suffix}`,
            displayLabel: '公开计费手册',
          },
          content,
          contentDigest: digestCreatorAgentPackageFile(new TextEncoder().encode(content)),
        },
      ],
    });
    await db.query(
      `INSERT INTO agent_packages (package_digest, protocol, owner_user_id)
       VALUES ($1, 'combo.agent-package/1', $2)`,
      [packageDigest, chain.creatorUserId],
    );
    await db.query(
      `INSERT INTO agent_package_releases
         (release_id, package_digest, owner_user_id, protocol, release_scope,
          idempotency_key, request_sha256)
       VALUES ($1, $2, $3, 'combo.agent-package-release/1', 'controlled_test', $4, $5)`,
      [releaseId, packageDigest, chain.creatorUserId, randomUUID(), suffix + suffix],
    );
    const binding: KnowledgeAgentBinding = {
      productKind: 'knowledge_agent_test',
      capability: {
        id: chain.capabilityId,
        protocol: 'combo.agent-package-capability/2',
      },
      release: {
        protocol: 'combo.agent-package-release/1',
        releaseId,
        packageDigest,
      },
      releaseScope: 'controlled_test',
      knowledge: {
        protocol: 'combo.knowledge-bundle/1',
        resourcePath: 'skills/knowledge/references/knowledge-bundle.json',
        resourceDigest: digestCreatorKnowledgeBundle(knowledge),
      },
    };
    const session = await createSession(runtimeDb, {
      capabilityId: chain.capabilityId,
      ownerUserId: chain.consumerUserId,
      agentBinding: binding,
    });
    const question = 'Combo 的免费额度是多少？';
    const answer = '前三次成功回答免费。';
    const resolved: ResolvedKnowledgeAgent = {
      binding,
      name: '公开知识助手',
      description: '只回答固定公开资料',
      instructions: '先检索，再提交候选答案。',
      knowledge,
    };
    const gate: KnowledgeAgentTestGate = {
      protocol: 'combo.knowledge-agent-runtime-test-gate/1',
      sourceSha: RUNTIME_SOURCE_SHA,
      publisherUserId: chain.creatorUserId,
      capabilityId: chain.capabilityId,
      releaseId,
      packageDigest,
      validatorPolicyVersion: 'knowledge-agent-test-validator-v1',
      cases: [
        {
          questionDigest: knowledgeQuestionDigest(question),
          answer,
          citationChunkIds: [chunkId],
        },
      ],
    };
    return { ...chain, session, binding, resolved, gate, question, answer, chunkId };
  }

  function knowledgeRunner(
    chain: SeededKnowledgeChain,
    script: Parameters<typeof makeFakeAgentFactory>[0],
    policy: { freeUses: number; unitPriceCents: number },
  ) {
    const agent = makeFakeAgentFactory(script);
    const runner = createTurnRunner({
      db: runtimeDb,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: new FakeSessionEventLog(),
      agentFactory: agent.factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      billingPolicy: policy,
      runtimeSourceSha: RUNTIME_SOURCE_SHA,
      log: silentLog,
    });
    const usageId = randomUUID();
    const start = (id = usageId) =>
      runner.startTurn({
        session: chain.session,
        definition: DEFINITION,
        text: chain.question,
        usageId: id,
        capabilityOwnerUserId: chain.creatorUserId,
        knowledge: {
          resolved: chain.resolved,
          gate: chain.gate,
          runtimeSourceSha: RUNTIME_SOURCE_SHA,
        },
        log: silentLog,
      });
    return { agent, runner, start, usageId };
  }

  async function reserveFreeUsage(chain: SeededBillingChain, text: string) {
    const billing = createUsageBillingService({ freeUses: 1, unitPriceCents: 100 });
    const request: UsageRequest = {
      ownerUserId: chain.consumerUserId,
      capabilityOwnerUserId: chain.creatorUserId,
      capabilityId: chain.capabilityId,
      sessionId: chain.session.id,
      usageId: randomUUID(),
      text,
    };
    const turnId = randomUUID();
    await withTransaction(runtimeDb, async (transaction) => {
      const session = await lockActiveSession(transaction, chain.session.id, chain.consumerUserId);
      if (!session) throw new Error('session missing');
      const preparation = await billing.prepareUsage(transaction, request);
      if (preparation.kind !== 'new' || preparation.source !== 'free') {
        throw new Error(`expected free preparation, received ${preparation.kind}`);
      }
      await createTurn(transaction, { id: turnId, sessionId: chain.session.id });
      await billing.reservePreparedUsage(transaction, {
        ...request,
        turnId,
        preparation,
      });
      await appendTurnMessage(transaction, {
        sessionId: chain.session.id,
        turnId,
        idx: 0,
        role: 'user',
        content: [{ type: 'text', text }],
      });
    });
    return { billing, turnId };
  }

  it('reserves and completes a free use through combo_runtime service SQL', async () => {
    const chain = await seedChain();
    const { billing, turnId } = await reserveFreeUsage(chain, '成功的免费任务');

    await withTransaction(runtimeDb, async (transaction) => {
      await lockTurnSession(transaction, chain.session.id);
      expect(await lockRunningTurn(transaction, turnId, chain.session.id)).toBe(true);
      expect(await finishTurnCas(transaction, { id: turnId, status: 'completed' })).toBe(true);
      await billing.settleUsage(transaction, turnId);
    });

    const result = await db.query<{
      free_used_count: number;
      free_reserved_count: number;
      charge_source: string;
      charge_status: string;
      balance_cents: string;
      reserved_cents: string;
      debit_count: string;
    }>(
      `SELECT
         fa.free_used_count,
         fa.free_reserved_count,
         uc.charge_source,
         uc.status AS charge_status,
         ba.balance_cents::text,
         ba.reserved_cents::text,
         (SELECT count(*)::text
            FROM wallet_ledger wl
           WHERE wl.owner_user_id = $1
             AND wl.entry_type = 'usage_debit') AS debit_count
       FROM billing_free_allowances fa
       JOIN usage_charges uc
         ON uc.owner_user_id = fa.owner_user_id
        AND uc.capability_id = fa.capability_id
       JOIN billing_accounts ba ON ba.owner_user_id = fa.owner_user_id
      WHERE fa.owner_user_id = $1
        AND fa.capability_id = $2
        AND uc.turn_id = $3`,
      [chain.consumerUserId, chain.capabilityId, turnId],
    );
    expect(result.rows[0]).toEqual({
      free_used_count: 1,
      free_reserved_count: 0,
      charge_source: 'free',
      charge_status: 'completed',
      balance_cents: '100',
      reserved_cents: '0',
      debit_count: '0',
    });
  });

  it('creates and settles an owner use without a pre-existing billing account', async () => {
    const chain = await seedChain();
    const ownerSession = await getOrCreateStudioSession(db, {
      capabilityId: chain.capabilityId,
      ownerUserId: chain.creatorUserId,
    });
    const before = await db.query<{ account_count: string }>(
      `SELECT count(*)::text AS account_count
         FROM billing_accounts
        WHERE owner_user_id = $1`,
      [chain.creatorUserId],
    );
    expect(before.rows[0]).toEqual({ account_count: '0' });

    const billing = createUsageBillingService({ freeUses: 3, unitPriceCents: 100 });
    const request: UsageRequest = {
      ownerUserId: chain.creatorUserId,
      capabilityOwnerUserId: chain.creatorUserId,
      capabilityId: chain.capabilityId,
      sessionId: ownerSession.id,
      usageId: randomUUID(),
      text: '创建者首次使用自己的 Agent',
    };
    const turnId = randomUUID();
    await withTransaction(runtimeDb, async (transaction) => {
      const locked = await lockActiveSession(transaction, ownerSession.id, chain.creatorUserId);
      if (!locked) throw new Error('owner session missing');
      const preparation = await billing.prepareUsage(transaction, request);
      if (preparation.kind !== 'new' || preparation.source !== 'owner') {
        throw new Error(`expected owner preparation, received ${preparation.kind}`);
      }
      await createTurn(transaction, { id: turnId, sessionId: ownerSession.id });
      await billing.reservePreparedUsage(transaction, {
        ...request,
        turnId,
        preparation,
      });
      await appendTurnMessage(transaction, {
        sessionId: ownerSession.id,
        turnId,
        idx: 0,
        role: 'user',
        content: [{ type: 'text', text: request.text }],
      });
    });

    const reserved = await db.query<{
      balance_cents: string;
      reserved_cents: string;
      charge_source: string;
      charge_status: string;
      charge_reserved_cents: string;
      ledger_count: string;
    }>(
      `SELECT
         ba.balance_cents::text,
         ba.reserved_cents::text,
         uc.charge_source,
         uc.status AS charge_status,
         uc.reserved_cents::text AS charge_reserved_cents,
         (SELECT count(*)::text
            FROM wallet_ledger wl
           WHERE wl.owner_user_id = ba.owner_user_id) AS ledger_count
       FROM billing_accounts ba
       JOIN usage_charges uc ON uc.owner_user_id = ba.owner_user_id
      WHERE ba.owner_user_id = $1
        AND uc.turn_id = $2`,
      [chain.creatorUserId, turnId],
    );
    expect(reserved.rows[0]).toEqual({
      balance_cents: '0',
      reserved_cents: '0',
      charge_source: 'owner',
      charge_status: 'reserved',
      charge_reserved_cents: '0',
      ledger_count: '0',
    });

    await withTransaction(runtimeDb, async (transaction) => {
      await lockTurnSession(transaction, ownerSession.id);
      expect(await lockRunningTurn(transaction, turnId, ownerSession.id)).toBe(true);
      expect(await finishTurnCas(transaction, { id: turnId, status: 'completed' })).toBe(true);
      await billing.settleUsage(transaction, turnId);
    });

    const settled = await db.query<{
      balance_cents: string;
      reserved_cents: string;
      charge_source: string;
      charge_status: string;
      settled_cents: string;
      ledger_count: string;
    }>(
      `SELECT
         ba.balance_cents::text,
         ba.reserved_cents::text,
         uc.charge_source,
         uc.status AS charge_status,
         uc.settled_cents::text,
         (SELECT count(*)::text
            FROM wallet_ledger wl
           WHERE wl.owner_user_id = ba.owner_user_id) AS ledger_count
       FROM billing_accounts ba
       JOIN usage_charges uc ON uc.owner_user_id = ba.owner_user_id
      WHERE ba.owner_user_id = $1
        AND uc.turn_id = $2`,
      [chain.creatorUserId, turnId],
    );
    expect(settled.rows[0]).toEqual({
      balance_cents: '0',
      reserved_cents: '0',
      charge_source: 'owner',
      charge_status: 'completed',
      settled_cents: '0',
      ledger_count: '0',
    });
  });

  it('bounds a real Session lock wait and safely retries the same owner usageId', async () => {
    const chain = await seedChain();
    const ownerSession = await createSession(db, {
      capabilityId: chain.capabilityId,
      ownerUserId: chain.creatorUserId,
    });
    const agent = makeFakeAgentFactory();
    const runner = createTurnRunner({
      db: runtimeDb,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: new FakeSessionEventLog(),
      agentFactory: agent.factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      turnAdmissionDatabaseTimeoutMs: 100,
      turnAdmissionDeadlineMs: 1_000,
      log: silentLog,
    });
    const usageId = randomUUID();
    const startInput = {
      session: ownerSession,
      definition: DEFINITION,
      text: '同一个 usageId 的锁超时重试',
      usageId,
      capabilityOwnerUserId: chain.creatorUserId,
      log: silentLog,
    };
    const blocker = await pool.connect();
    let blockerTransactionOpen = false;
    try {
      await blocker.query('BEGIN');
      blockerTransactionOpen = true;
      await blocker.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [ownerSession.id]);

      let lockFailure: unknown;
      try {
        await runner.startTurn(startInput);
      } catch (error) {
        lockFailure = error;
      }
      expect(lockFailure).toBeInstanceOf(TurnAdmissionUnavailableError);
      if (!(lockFailure instanceof TurnAdmissionUnavailableError)) {
        throw new Error('real PostgreSQL lock wait did not produce an admission failure');
      }
      expect(lockFailure.stage).toBe('session_lock');
      expect(lockFailure.reason).toBe('database_transient');
      // lock_timeout and statement_timeout intentionally share one bound; depending
      // on scheduling PostgreSQL may report either lock-not-available or cancellation.
      expect(['55P03', '57014']).toContain(lockFailure.databaseCode);
      const residue = await db.query<{
        account_count: string;
        usage_count: string;
        turn_count: string;
        message_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM billing_accounts WHERE owner_user_id = $1)
             AS account_count,
           (SELECT count(*)::text FROM usage_charges WHERE owner_user_id = $1 AND usage_id = $2)
             AS usage_count,
           (SELECT count(*)::text FROM turns WHERE session_id = $3) AS turn_count,
           (SELECT count(*)::text FROM messages WHERE session_id = $3) AS message_count`,
        [chain.creatorUserId, usageId, ownerSession.id],
      );
      expect(residue.rows[0]).toEqual({
        account_count: '0',
        usage_count: '0',
        turn_count: '0',
        message_count: '0',
      });

      await blocker.query('ROLLBACK');
      blockerTransactionOpen = false;
      const retried = await runner.startTurn(startInput);
      expect(retried.status).toBe('started');
      await waitFor(async () => {
        const terminal = await db.query<{ status: string }>(
          `SELECT status
             FROM turns
            WHERE session_id = $1`,
          [ownerSession.id],
        );
        return terminal.rows[0]?.status === 'completed';
      }, 5_000);
      expect(agent.calls).toHaveLength(1);

      const final = await db.query<{
        turn_count: string;
        message_count: string;
        usage_count: string;
        charge_status: string;
        charge_source: string;
        settled_cents: string;
        ledger_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM turns WHERE session_id = $1) AS turn_count,
           (SELECT count(*)::text FROM messages WHERE session_id = $1) AS message_count,
           count(*)::text AS usage_count,
           max(status::text) AS charge_status,
           max(charge_source::text) AS charge_source,
           max(settled_cents)::text AS settled_cents,
           (SELECT count(*)::text
              FROM wallet_ledger
             WHERE owner_user_id = $2) AS ledger_count
         FROM usage_charges
        WHERE owner_user_id = $2
          AND usage_id = $3`,
        [ownerSession.id, chain.creatorUserId, usageId],
      );
      expect(final.rows[0]).toEqual({
        turn_count: '1',
        message_count: '1',
        usage_count: '1',
        charge_status: 'completed',
        charge_source: 'owner',
        settled_cents: '0',
        ledger_count: '0',
      });

      const replayed = await runner.startTurn(startInput);
      expect(replayed.status).toBe('replayed');
      expect(agent.calls).toHaveLength(1);
    } finally {
      if (blockerTransactionOpen) await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await runner.dispose(AbortSignal.timeout(5_000));
    }
  });

  it('releases a failed free use through combo_runtime service SQL', async () => {
    const chain = await seedChain();
    const { billing, turnId } = await reserveFreeUsage(chain, '失败的免费任务');

    await withTransaction(runtimeDb, async (transaction) => {
      await lockTurnSession(transaction, chain.session.id);
      expect(await lockRunningTurn(transaction, turnId, chain.session.id)).toBe(true);
      expect(
        await finishTurnCas(transaction, {
          id: turnId,
          status: 'failed',
          lastError: { code: 'AGENT_FAILED', message: 'test failure' },
        }),
      ).toBe(true);
      await billing.releaseUsage(transaction, turnId);
    });

    const result = await db.query<{
      free_used_count: number;
      free_reserved_count: number;
      charge_source: string;
      charge_status: string;
      balance_cents: string;
      reserved_cents: string;
      debit_count: string;
    }>(
      `SELECT
         fa.free_used_count,
         fa.free_reserved_count,
         uc.charge_source,
         uc.status AS charge_status,
         ba.balance_cents::text,
         ba.reserved_cents::text,
         (SELECT count(*)::text
            FROM wallet_ledger wl
           WHERE wl.owner_user_id = $1
             AND wl.entry_type = 'usage_debit') AS debit_count
       FROM billing_free_allowances fa
       JOIN usage_charges uc
         ON uc.owner_user_id = fa.owner_user_id
        AND uc.capability_id = fa.capability_id
       JOIN billing_accounts ba ON ba.owner_user_id = fa.owner_user_id
      WHERE fa.owner_user_id = $1
        AND fa.capability_id = $2
        AND uc.turn_id = $3`,
      [chain.consumerUserId, chain.capabilityId, turnId],
    );
    expect(result.rows[0]).toEqual({
      free_used_count: 0,
      free_reserved_count: 0,
      charge_source: 'free',
      charge_status: 'released',
      balance_cents: '100',
      reserved_cents: '0',
      debit_count: '0',
    });
  });

  it('concurrent same usageId creates one Turn, one reserve and one debit', async () => {
    const chain = await seedChain();
    const billing = createUsageBillingService({ freeUses: 0, unitPriceCents: 100 });
    const usageId = randomUUID();
    const request: UsageRequest = {
      ownerUserId: chain.consumerUserId,
      capabilityOwnerUserId: chain.creatorUserId,
      capabilityId: chain.capabilityId,
      sessionId: chain.session.id,
      usageId,
      text: '同一个并发任务',
    };

    const open = () =>
      withTransaction(runtimeDb, async (transaction) => {
        const session = await lockActiveSession(
          transaction,
          chain.session.id,
          chain.consumerUserId,
        );
        if (!session) throw new Error('session missing');
        const preparation = await billing.prepareUsage(transaction, request);
        if (preparation.kind === 'replay') {
          return { kind: 'replay' as const, turnId: preparation.turnId };
        }
        if (preparation.kind === 'insufficient') {
          throw new Error('unexpected insufficient balance');
        }
        if (await getRunningTurnId(transaction, chain.session.id)) {
          throw new Error('unexpected unrelated running Turn');
        }
        const turnId = randomUUID();
        await createTurn(transaction, { id: turnId, sessionId: chain.session.id });
        await billing.reservePreparedUsage(transaction, {
          ...request,
          turnId,
          preparation,
        });
        await appendTurnMessage(transaction, {
          sessionId: chain.session.id,
          turnId,
          idx: 0,
          role: 'user',
          content: [{ type: 'text', text: request.text }],
        });
        return { kind: 'new' as const, turnId };
      });

    const opened = await Promise.all([open(), open()]);
    expect(opened.map((result) => result.kind).sort()).toEqual(['new', 'replay']);
    expect(new Set(opened.map((result) => result.turnId)).size).toBe(1);

    const reserved = await db.query<{
      turn_count: string;
      message_count: string;
      usage_count: string;
      balance_cents: string;
      reserved_cents: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM turns WHERE session_id = $1) AS turn_count,
         (SELECT count(*)::text FROM messages WHERE session_id = $1) AS message_count,
         (SELECT count(*)::text FROM usage_charges
           WHERE owner_user_id = $2 AND usage_id = $3) AS usage_count,
         balance_cents::text,
         reserved_cents::text
       FROM billing_accounts
       WHERE owner_user_id = $2`,
      [chain.session.id, chain.consumerUserId, usageId],
    );
    expect(reserved.rows[0]).toMatchObject({
      turn_count: '1',
      message_count: '1',
      usage_count: '1',
      balance_cents: '0',
      reserved_cents: '100',
    });

    const turnId = opened[0]!.turnId;
    await withTransaction(runtimeDb, async (transaction) => {
      await lockTurnSession(transaction, chain.session.id);
      expect(await lockRunningTurn(transaction, turnId, chain.session.id)).toBe(true);
      expect(await finishTurnCas(transaction, { id: turnId, status: 'completed' })).toBe(true);
      await billing.settleUsage(transaction, turnId);
    });

    const settled = await db.query<{
      balance_cents: string;
      reserved_cents: string;
      debit_count: string;
      debit_total: string;
    }>(
      `SELECT
         a.balance_cents::text,
         a.reserved_cents::text,
         count(l.id)::text AS debit_count,
         COALESCE(sum(l.amount_cents), 0)::text AS debit_total
       FROM billing_accounts a
       LEFT JOIN wallet_ledger l
         ON l.owner_user_id = a.owner_user_id
        AND l.entry_type = 'usage_debit'
       WHERE a.owner_user_id = $1
       GROUP BY a.owner_user_id, a.balance_cents, a.reserved_cents`,
      [chain.consumerUserId],
    );
    expect(settled.rows[0]).toEqual({
      balance_cents: '0',
      reserved_cents: '0',
      debit_count: '1',
      debit_total: '-100',
    });
    expect(BigInt(settled.rows[0]!.balance_cents)).toBeGreaterThanOrEqual(0n);
    expect(BigInt(settled.rows[0]!.reserved_cents)).toBeGreaterThanOrEqual(0n);
  });

  it('serializes the same user and usageId across different Sessions', async () => {
    const chain = await seedChain();
    const secondSession = await createSession(db, {
      capabilityId: chain.capabilityId,
      ownerUserId: chain.consumerUserId,
    });
    const billing = createUsageBillingService({ freeUses: 0, unitPriceCents: 100 });
    const sharedUsageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const open = (session: SessionRow, usageId: string) =>
      withTransaction(runtimeDb, async (transaction) => {
        const locked = await lockActiveSession(transaction, session.id, chain.consumerUserId);
        if (!locked) throw new Error('session missing');
        const request: UsageRequest = {
          ownerUserId: chain.consumerUserId,
          capabilityOwnerUserId: chain.creatorUserId,
          capabilityId: chain.capabilityId,
          sessionId: session.id,
          usageId,
          text: '跨 Session 的同一任务',
        };
        const preparation = await billing.prepareUsage(transaction, request);
        if (preparation.kind !== 'new') throw new Error(`unexpected ${preparation.kind}`);
        const turnId = randomUUID();
        await createTurn(transaction, { id: turnId, sessionId: session.id });
        await billing.reservePreparedUsage(transaction, {
          ...request,
          turnId,
          preparation,
        });
        await appendTurnMessage(transaction, {
          sessionId: session.id,
          turnId,
          idx: 0,
          role: 'user',
          content: [{ type: 'text', text: request.text }],
        });
        return { sessionId: session.id, turnId };
      });

    const results = await Promise.allSettled([
      open(chain.session, sharedUsageId),
      open(secondSession, sharedUsageId.toUpperCase()),
    ]);
    const succeeded = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(UsageRequestConflictError);

    const reserved = await db.query<{
      turn_count: string;
      usage_count: string;
      balance_cents: string;
      reserved_cents: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM turns WHERE session_id = ANY($1::uuid[])) AS turn_count,
         (SELECT count(*)::text FROM usage_charges
           WHERE owner_user_id = $2 AND usage_id = $3) AS usage_count,
         balance_cents::text,
         reserved_cents::text
       FROM billing_accounts
       WHERE owner_user_id = $2`,
      [[chain.session.id, secondSession.id], chain.consumerUserId, sharedUsageId],
    );
    expect(reserved.rows[0]).toEqual({
      turn_count: '1',
      usage_count: '1',
      balance_cents: '0',
      reserved_cents: '100',
    });

    const winner = succeeded[0]?.value;
    if (!winner) throw new Error('missing successful usage');
    await withTransaction(runtimeDb, async (transaction) => {
      await lockTurnSession(transaction, winner.sessionId);
      expect(await lockRunningTurn(transaction, winner.turnId, winner.sessionId)).toBe(true);
      expect(await finishTurnCas(transaction, { id: winner.turnId, status: 'completed' })).toBe(
        true,
      );
      await billing.settleUsage(transaction, winner.turnId);
    });
    const ledger = await db.query<{ debit_count: string; debit_total: string }>(
      `SELECT count(*)::text AS debit_count,
              COALESCE(sum(amount_cents), 0)::text AS debit_total
         FROM wallet_ledger
        WHERE owner_user_id = $1 AND entry_type = 'usage_debit'`,
      [chain.consumerUserId],
    );
    expect(ledger.rows[0]).toEqual({ debit_count: '1', debit_total: '-100' });
  });

  it('settles an accepted knowledge answer against the real free allowance', async () => {
    const chain = await seedKnowledgeChain();
    const context = knowledgeRunner(
      chain,
      {
        invokeNamedTools: [
          { name: 'knowledge_search', params: { query: '免费额度' } },
          {
            name: 'submit_knowledge_answer',
            params: {
              status: 'answered',
              answer: chain.answer,
              citationChunkIds: [chain.chunkId],
            },
          },
        ],
      },
      { freeUses: 1, unitPriceCents: 100 },
    );
    try {
      await context.start();
      await waitFor(async () => {
        const result = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM agent_usage_receipts WHERE session_id = $1`,
          [chain.session.id],
        );
        return result.rows[0]?.count === '1';
      }, 5_000);
      const state = await db.query<{
        charge_source: string;
        charge_status: string;
        execution_outcome: string;
        settled_cents: string;
        free_used_count: number;
        free_reserved_count: number;
        assistant_count: string;
        debit_count: string;
      }>(
        `SELECT uc.charge_source,
                uc.status::text AS charge_status,
                uc.execution_outcome::text,
                uc.settled_cents::text,
                fa.free_used_count,
                fa.free_reserved_count,
                (SELECT count(*)::text FROM messages
                  WHERE turn_id = uc.turn_id AND role = 'assistant') AS assistant_count,
                (SELECT count(*)::text FROM wallet_ledger
                  WHERE owner_user_id = $2 AND entry_type = 'usage_debit') AS debit_count
           FROM usage_charges uc
           JOIN billing_free_allowances fa
             ON fa.owner_user_id = uc.owner_user_id
            AND fa.capability_id = uc.capability_id
          WHERE uc.session_id = $1`,
        [chain.session.id, chain.consumerUserId],
      );
      expect(state.rows[0]).toEqual({
        charge_source: 'free',
        charge_status: 'completed',
        execution_outcome: 'answered',
        settled_cents: '0',
        free_used_count: 1,
        free_reserved_count: 0,
        assistant_count: '1',
        debit_count: '0',
      });
    } finally {
      await context.runner.dispose(AbortSignal.timeout(5_000));
    }
  });

  it('returns real PostgreSQL 402 admission without creating a Turn or reservation', async () => {
    const chain = await seedKnowledgeChain();
    const context = knowledgeRunner(chain, {}, { freeUses: 0, unitPriceCents: 101 });
    try {
      await expect(context.start()).resolves.toEqual({
        status: 'recharge_required',
        balanceCents: 100n,
        requiredCents: 101n,
      });
      const state = await db.query<{
        turn_count: string;
        message_count: string;
        charge_count: string;
        receipt_count: string;
        balance_cents: string;
        reserved_cents: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM turns WHERE session_id = $1) AS turn_count,
           (SELECT count(*)::text FROM messages WHERE session_id = $1) AS message_count,
           (SELECT count(*)::text FROM usage_charges WHERE session_id = $1) AS charge_count,
           (SELECT count(*)::text FROM agent_usage_receipts WHERE session_id = $1) AS receipt_count,
           balance_cents::text,
           reserved_cents::text
         FROM billing_accounts
        WHERE owner_user_id = $2`,
        [chain.session.id, chain.consumerUserId],
      );
      expect(state.rows[0]).toEqual({
        turn_count: '0',
        message_count: '0',
        charge_count: '0',
        receipt_count: '0',
        balance_cents: '100',
        reserved_cents: '0',
      });
      expect(context.agent.calls).toHaveLength(0);
    } finally {
      await context.runner.dispose(AbortSignal.timeout(5_000));
    }
  });

  it('settles one accepted knowledge answer exactly once through combo_runtime', async () => {
    const chain = await seedKnowledgeChain();
    const context = knowledgeRunner(
      chain,
      {
        deltas: ['candidate text must stay private'],
        invokeNamedTools: [
          { name: 'knowledge_search', params: { query: '免费额度' } },
          {
            name: 'submit_knowledge_answer',
            params: {
              status: 'answered',
              answer: chain.answer,
              citationChunkIds: [chain.chunkId],
            },
          },
        ],
      },
      { freeUses: 0, unitPriceCents: 100 },
    );
    try {
      const opened = await Promise.all([context.start(), context.start()]);
      expect(opened.map((result) => result.status).sort()).toEqual(['replayed', 'started']);
      await waitFor(async () => {
        const receipt = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM agent_usage_receipts
            WHERE owner_user_id = $1 AND usage_id = $2`,
          [chain.consumerUserId, context.usageId],
        );
        return receipt.rows[0]?.count === '1';
      }, 5_000);

      const snapshot = await db.query<{
        turn_count: string;
        charge_count: string;
        receipt_count: string;
        assistant_count: string;
        debit_count: string;
        debit_total: string;
        turn_status: string;
        charge_status: string;
        execution_outcome: string;
        validation_code: string;
        settled_cents: string;
        balance_cents: string;
        reserved_cents: string;
        session_package_digest: string;
        charge_package_digest: string;
        receipt_package_digest: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM turns WHERE session_id = $1) AS turn_count,
           count(DISTINCT uc.id)::text AS charge_count,
           count(DISTINCT r.id)::text AS receipt_count,
           (SELECT count(*)::text FROM messages
             WHERE session_id = $1 AND role = 'assistant') AS assistant_count,
           (SELECT count(*)::text FROM wallet_ledger
             WHERE owner_user_id = $2 AND entry_type = 'usage_debit') AS debit_count,
           (SELECT COALESCE(sum(amount_cents), 0)::text FROM wallet_ledger
             WHERE owner_user_id = $2 AND entry_type = 'usage_debit') AS debit_total,
           max(t.status::text) AS turn_status,
           max(uc.status::text) AS charge_status,
           max(uc.execution_outcome::text) AS execution_outcome,
           max(r.validation_code) AS validation_code,
           max(uc.settled_cents)::text AS settled_cents,
           max(ba.balance_cents)::text AS balance_cents,
           max(ba.reserved_cents)::text AS reserved_cents,
           max(s.package_digest) AS session_package_digest,
           max(uc.package_digest) AS charge_package_digest,
           max(r.package_digest) AS receipt_package_digest
         FROM sessions s
         JOIN turns t ON t.session_id = s.id
         JOIN usage_charges uc ON uc.turn_id = t.id
         JOIN agent_usage_receipts r ON r.usage_charge_id = uc.id
         JOIN billing_accounts ba ON ba.owner_user_id = uc.owner_user_id
        WHERE s.id = $1
        GROUP BY s.id`,
        [chain.session.id, chain.consumerUserId],
      );
      expect(snapshot.rows[0]).toEqual({
        turn_count: '1',
        charge_count: '1',
        receipt_count: '1',
        assistant_count: '1',
        debit_count: '1',
        debit_total: '-100',
        turn_status: 'completed',
        charge_status: 'completed',
        execution_outcome: 'answered',
        validation_code: 'accepted',
        settled_cents: '100',
        balance_cents: '0',
        reserved_cents: '0',
        session_package_digest: chain.binding.release.packageDigest,
        charge_package_digest: chain.binding.release.packageDigest,
        receipt_package_digest: chain.binding.release.packageDigest,
      });
      await expect(context.start()).resolves.toMatchObject({ status: 'replayed' });
      expect(context.agent.calls).toHaveLength(1);
    } finally {
      await context.runner.dispose(AbortSignal.timeout(5_000));
    }
  });

  it.each([
    {
      label: 'insufficient evidence',
      script: (_chain: SeededKnowledgeChain) => ({
        invokeNamedTools: [
          { name: 'knowledge_search', params: { query: '不存在的问题' } },
          { name: 'submit_knowledge_answer', params: { status: 'insufficient_evidence' } },
        ],
      }),
      outcome: 'insufficient_evidence',
      validation: 'insufficient_evidence',
      turnStatus: 'completed',
      assistantCount: '1',
    },
    {
      label: 'rejected candidate',
      script: (chain: SeededKnowledgeChain) => ({
        invokeNamedTools: [
          { name: 'knowledge_search', params: { query: '免费额度' } },
          {
            name: 'submit_knowledge_answer',
            params: {
              status: 'answered',
              answer: 'tampered answer',
              citationChunkIds: [chain.chunkId],
            },
          },
        ],
      }),
      outcome: 'failed',
      validation: 'rejected',
      turnStatus: 'failed',
      assistantCount: '0',
    },
  ])('releases wallet for $label and records an immutable receipt', async (candidate) => {
    const chain = await seedKnowledgeChain();
    const context = knowledgeRunner(chain, candidate.script(chain), {
      freeUses: 0,
      unitPriceCents: 100,
    });
    try {
      await context.start();
      await waitFor(async () => {
        const result = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM agent_usage_receipts WHERE session_id = $1`,
          [chain.session.id],
        );
        return result.rows[0]?.count === '1';
      }, 5_000);
      const state = await db.query<{
        turn_status: string;
        charge_status: string;
        execution_outcome: string;
        validation_code: string;
        assistant_count: string;
        debit_count: string;
        balance_cents: string;
        reserved_cents: string;
      }>(
        `SELECT t.status::text AS turn_status,
                uc.status::text AS charge_status,
                uc.execution_outcome::text,
                r.validation_code,
                (SELECT count(*)::text FROM messages
                  WHERE turn_id = t.id AND role = 'assistant') AS assistant_count,
                (SELECT count(*)::text FROM wallet_ledger
                  WHERE owner_user_id = $2 AND entry_type = 'usage_debit') AS debit_count,
                ba.balance_cents::text,
                ba.reserved_cents::text
           FROM turns t
           JOIN usage_charges uc ON uc.turn_id = t.id
           JOIN agent_usage_receipts r ON r.usage_charge_id = uc.id
           JOIN billing_accounts ba ON ba.owner_user_id = uc.owner_user_id
          WHERE t.session_id = $1`,
        [chain.session.id, chain.consumerUserId],
      );
      expect(state.rows[0]).toEqual({
        turn_status: candidate.turnStatus,
        charge_status: 'released',
        execution_outcome: candidate.outcome,
        validation_code: candidate.validation,
        assistant_count: candidate.assistantCount,
        debit_count: '0',
        balance_cents: '100',
        reserved_cents: '0',
      });
    } finally {
      await context.runner.dispose(AbortSignal.timeout(5_000));
    }
  });

  it('lets a peer atomically interrupt a knowledge Turn without double settlement', async () => {
    const chain = await seedKnowledgeChain();
    const owner = knowledgeRunner(
      chain,
      { hangUntilAbort: true },
      {
        freeUses: 0,
        unitPriceCents: 100,
      },
    );
    const peer = createTurnRunner({
      db: runtimeDb,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: new FakeSessionEventLog(),
      agentFactory: makeFakeAgentFactory({}).factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      billingPolicy: { freeUses: 0, unitPriceCents: 100 },
      runtimeSourceSha: RUNTIME_SOURCE_SHA,
      log: silentLog,
    });
    try {
      await owner.start();
      await waitFor(() => owner.agent.calls.length === 1);
      await expect(peer.interrupt(chain.session.id)).resolves.toBe(true);
      await waitFor(async () => {
        const result = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM agent_usage_receipts WHERE session_id = $1`,
          [chain.session.id],
        );
        return result.rows[0]?.count === '1';
      }, 5_000);
      await owner.runner.dispose(AbortSignal.timeout(5_000));

      const state = await db.query<{
        turn_status: string;
        charge_status: string;
        outcome: string;
        validation_code: string;
        receipt_count: string;
        assistant_count: string;
        debit_count: string;
        balance_cents: string;
        reserved_cents: string;
      }>(
        `SELECT t.status::text AS turn_status,
                uc.status::text AS charge_status,
                uc.execution_outcome::text AS outcome,
                max(r.validation_code) AS validation_code,
                count(r.id)::text AS receipt_count,
                (SELECT count(*)::text FROM messages
                  WHERE turn_id = t.id AND role = 'assistant') AS assistant_count,
                (SELECT count(*)::text FROM wallet_ledger
                  WHERE owner_user_id = $2 AND entry_type = 'usage_debit') AS debit_count,
                max(ba.balance_cents)::text AS balance_cents,
                max(ba.reserved_cents)::text AS reserved_cents
           FROM turns t
           JOIN usage_charges uc ON uc.turn_id = t.id
           JOIN agent_usage_receipts r ON r.usage_charge_id = uc.id
           JOIN billing_accounts ba ON ba.owner_user_id = uc.owner_user_id
          WHERE t.session_id = $1
          GROUP BY t.id, uc.id`,
        [chain.session.id, chain.consumerUserId],
      );
      expect(state.rows[0]).toEqual({
        turn_status: 'interrupted',
        charge_status: 'released',
        outcome: 'interrupted',
        validation_code: 'not_run',
        receipt_count: '1',
        assistant_count: '0',
        debit_count: '0',
        balance_cents: '100',
        reserved_cents: '0',
      });
    } finally {
      await owner.runner.dispose(AbortSignal.timeout(5_000)).catch(() => undefined);
      await peer.dispose(AbortSignal.timeout(5_000));
    }
  });
});
