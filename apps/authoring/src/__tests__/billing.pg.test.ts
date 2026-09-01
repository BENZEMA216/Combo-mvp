import { Pool } from 'pg';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RechargeOrderViewSchema, RecoveryRechargeOrderViewSchema } from '@cb/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRechargeOrderHandler } from '../modules/billing/handlers.js';
import { PgBillingRepository } from '../modules/billing/repo.js';
import {
  BillingIdempotencyConflictError,
  BillingRateLimitedError,
  BillingRecoveryUnavailableError,
} from '../modules/billing/types.js';
import { asTxPool, type TxPool } from '../platform/infra/db-tx.js';
import type { VerifiedPaymentNotification } from '../platform/infra/leshouying/index.js';

const enabled =
  process.env.BILLING_PG_TEST === '1' &&
  Boolean(process.env.BILLING_TEST_DATABASE_URL && process.env.BILLING_AUTHORING_TEST_DATABASE_URL);
const pgDescribe = enabled ? describe : describe.skip;

pgDescribe('billing PostgreSQL concurrency invariants', () => {
  let pool: Pool;
  let apiPool: Pool;
  let repository: PgBillingRepository;
  let ownerId: string;
  let runId: string;
  const recoveryIds = new Map<string, string>();
  let capabilityId: string;
  let releaseId: string;
  let packageDigest: string;
  let knowledgeResourceDigest: string;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.BILLING_TEST_DATABASE_URL,
      max: 6,
    });
    apiPool = new Pool({
      connectionString: process.env.BILLING_AUTHORING_TEST_DATABASE_URL,
      max: 6,
    });
    const identity = await apiPool.query<{ current_user: string }>(
      'SELECT current_user::text AS current_user',
    );
    if (identity.rows[0]?.current_user !== 'combo_api') {
      throw new Error('billing authoring test connection must use combo_api');
    }
    const schema = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN (
            'billing_accounts',
            'recharge_orders',
            'payment_attempts',
            'payment_callback_events',
            'wallet_ledger',
            'pending_usage_recoveries'
          )`,
    );
    if (schema.rows.length !== 6) throw new Error('billing migration is not applied');
    repository = new PgBillingRepository(asTxPool(apiPool), apiPool);
  });

  afterAll(async () => {
    await Promise.all([pool?.end(), apiPool?.end()]);
  });

  beforeEach(async () => {
    recoveryIds.clear();
    ownerId = randomUUID();
    runId = randomBytes(12).toString('hex');
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    const accountSuffix = [...randomBytes(8)]
      .map((value) => alphabet[value % alphabet.length])
      .join('');
    await pool.query(
      `INSERT INTO users (id, account)
       VALUES ($1, $2)`,
      [ownerId, `creator-${accountSuffix}`],
    );
    const task = await pool.query<{ id: string }>(
      `INSERT INTO tasks (owner_user_id, idempotency_key)
       VALUES ($1, $2)
       RETURNING id`,
      [ownerId, `authoring-billing-${runId}`],
    );
    const capability = await pool.query<{ id: string }>(
      `INSERT INTO capabilities (task_id, owner_user_id, name, storage_key, published)
       VALUES ($1, $2, 'recovery billing', $3, true)
       RETURNING id`,
      [task.rows[0]!.id, ownerId, `billing/${runId}.json`],
    );
    capabilityId = capability.rows[0]!.id;
    const packageHex = createHash('sha256').update(`package:${runId}`).digest('hex');
    const releaseHex = createHash('sha256').update(`release:${runId}`).digest('hex').slice(0, 32);
    const resourceHex = createHash('sha256').update(`resource:${runId}`).digest('hex');
    packageDigest = `sha256:${packageHex}`;
    releaseId = `release.agent-package.${releaseHex}`;
    knowledgeResourceDigest = `sha256:${resourceHex}`;
    await pool.query(
      `INSERT INTO agent_packages (package_digest, protocol, owner_user_id)
       VALUES ($1, 'combo.agent-package/1', $2)`,
      [packageDigest, ownerId],
    );
    await pool.query(
      `INSERT INTO agent_package_releases
         (release_id, package_digest, owner_user_id, protocol, release_scope,
          idempotency_key, request_sha256)
       VALUES ($1, $2, $3, 'combo.agent-package-release/1', 'controlled_test', $4, $5)`,
      [releaseId, packageDigest, ownerId, randomUUID(), packageHex],
    );
  });

  async function ensureRecovery(
    suffix: string,
    recoveryUsageId: string,
    expiresInMs = 6 * 24 * 60 * 60 * 1_000,
  ): Promise<void> {
    if ([...recoveryIds.entries()].some(([key]) => key === suffix)) return;
    const session = await pool.query<{ id: string }>(
      `INSERT INTO sessions
         (capability_id, owner_user_id, mode, product_kind, capability_protocol,
          release_id, package_digest, release_scope,
          knowledge_resource_path, knowledge_resource_digest)
       VALUES (
         $1, $2, 'consume', 'knowledge_agent_test', 'combo.agent-package-capability/2',
         $3, $4, 'controlled_test',
         'skills/knowledge/references/knowledge-bundle.json', $5
       )
       RETURNING id`,
      [capabilityId, ownerId, releaseId, packageDigest, knowledgeResourceDigest],
    );
    await pool.query(
      `INSERT INTO pending_usage_recoveries (
         owner_user_id, usage_id, session_id, capability_id, request_text,
         request_fingerprint, product_kind, capability_protocol, release_id,
         package_digest, release_scope, knowledge_resource_path,
         knowledge_resource_digest, billing_policy_version, validator_policy_version,
         unit_price_cents, free_limit_snapshot, active_recharge_intent_id, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'knowledge_agent_test',
         'combo.agent-package-capability/2', $7, $8, 'controlled_test',
         'skills/knowledge/references/knowledge-bundle.json', $9,
         'runtime-usage-v1', 'knowledge-agent-test-validator-v1', 300, 3, $2,
         statement_timestamp() + ($10 * interval '1 millisecond')
       )`,
      [
        ownerId,
        recoveryUsageId,
        session.rows[0]!.id,
        capabilityId,
        `recover ${suffix}`,
        createHash('sha256').update(`request:${runId}:${suffix}`).digest('hex'),
        releaseId,
        packageDigest,
        knowledgeResourceDigest,
        expiresInMs,
      ],
    );
  }

  async function prepareForRecovery(
    suffix: string,
    recoveryUsageId: string,
    rechargeIntentId: string,
    amountCents = 300n,
    targetRepository = repository,
  ) {
    const identity = `${runId}-${suffix}`;
    return targetRepository.prepareRecharge({
      orderNo: `CBR-PG-${identity}`,
      ownerUserId: ownerId,
      recoveryUsageId,
      clientIdempotencyKey: rechargeIntentId,
      packageId: 'manual',
      amountCents,
      paymentMethod: 'qr',
      payType: 'alipay',
      gatewayEnvironment: 'test',
      institutionNo: 'INST0001',
      merchantNo: 'MCH_TEST_001',
      payTraceNo: `TRACE-PG-${identity}`,
      payTime: '20260728120000',
      requestFingerprint: createHash('sha256').update(identity).digest('hex'),
      submissionRecoveryMs: 10_000,
    });
  }

  async function prepareLegacy(suffix: string, rechargeIntentId: string) {
    const identity = `${runId}-${suffix}`;
    return repository.prepareRecharge({
      orderNo: `CBR-PG-${identity}`,
      ownerUserId: ownerId,
      clientIdempotencyKey: rechargeIntentId,
      packageId: 'manual',
      amountCents: 300n,
      paymentMethod: 'qr',
      payType: 'alipay',
      gatewayEnvironment: 'test',
      institutionNo: 'INST0001',
      merchantNo: 'MCH_TEST_001',
      payTraceNo: `TRACE-PG-${identity}`,
      payTime: '20260728120000',
      requestFingerprint: createHash('sha256').update(identity).digest('hex'),
      submissionRecoveryMs: 10_000,
    });
  }

  async function prepare(suffix: string) {
    const recoveryUsageId = recoveryIds.get(suffix) ?? randomUUID();
    if (!recoveryIds.has(suffix)) await ensureRecovery(suffix, recoveryUsageId);
    recoveryIds.set(suffix, recoveryUsageId);
    return prepareForRecovery(suffix, recoveryUsageId, recoveryUsageId);
  }

  function notification(
    order: Awaited<ReturnType<typeof prepare>>['order'],
    fingerprint: string,
    tradeNo: string,
  ): VerifiedPaymentNotification {
    return {
      eventFingerprint: fingerprint,
      gatewayEnvironment: 'test',
      institutionNo: 'INST0001',
      merchantNo: 'MCH_TEST_001',
      payTraceNo: order.payTraceNo,
      payTime: order.payTime,
      amountCents: order.amountCents,
      platformTradeNo: tradeNo,
      resultCode: 'PAY_SUCCESS',
      returnCode: 'SUCCESS',
      tradeType: '1',
      attach: order.orderNo,
      paidAt: new Date(),
    };
  }

  async function invokeCreateHandler(body: Record<string, unknown>) {
    const createPayment = vi.fn(async () => ({
      status: 'pending' as const,
      action: {
        kind: 'code_url' as const,
        value: 'https://qr.alipay.com/opaque',
        expiresAt: new Date(Date.now() + 60_000),
      },
    }));
    const reply = {
      statusCode: 200,
      body: undefined as unknown,
      code(statusCode: number) {
        this.statusCode = statusCode;
        return this;
      },
      send(responseBody: unknown) {
        this.body = responseBody;
        return this;
      },
    };
    const request = {
      id: `trace-${randomUUID()}`,
      auth: { userId: ownerId },
      body,
      log: { error: vi.fn() },
      server: {
        infra: {
          db: apiPool,
          billing: { gatewayEnabled: true, submissionRecoveryMs: 10_000 },
          paymentGateway: {
            configured: true,
            environment: 'test',
            institutionNo: 'INST0001',
            merchantNo: 'MCH_TEST_001',
            createPayment,
            queryPayment: vi.fn(),
            verifyPaymentNotification: vi.fn(),
          },
        },
      },
    };
    await createRechargeOrderHandler().call({} as never, request as never, reply as never);
    return { createPayment, reply };
  }

  it('preserves legacy intent-only creation without a pending recovery binding', async () => {
    const rechargeIntentId = randomUUID();
    const created = await prepareLegacy('legacy-no-recovery', rechargeIntentId);
    const replayed = await prepareLegacy('legacy-no-recovery', rechargeIntentId);

    expect(created).toMatchObject({ created: true, shouldSubmit: true });
    expect(created.order.recoveryUsageId).toBeUndefined();
    expect(replayed).toMatchObject({ created: false, shouldSubmit: false });
    expect(replayed.order.id).toBe(created.order.id);

    const persisted = await pool.query<{
      recovery_usage_id: string | null;
      pending_count: string;
    }>(
      `SELECT ro.recovery_usage_id,
              (SELECT count(*)::text
                 FROM pending_usage_recoveries pur
                WHERE pur.owner_user_id = ro.owner_user_id) AS pending_count
         FROM recharge_orders ro
        WHERE ro.id = $1`,
      [created.order.id],
    );
    expect(persisted.rows[0]).toEqual({ recovery_usage_id: null, pending_count: '0' });
  });

  it('commits and serializes the legacy create response for the existing client schema', async () => {
    const rechargeIntentId = randomUUID();
    const { createPayment, reply } = await invokeCreateHandler({
      rechargeIntentId,
      amountCents: 500,
      channel: 'qr',
      payType: 'alipay',
    });

    expect(reply.statusCode).toBe(201);
    const envelope = reply.body as { data: unknown; meta: { traceId: string } };
    const view = RechargeOrderViewSchema.parse(envelope.data);
    expect(view).toMatchObject({ rechargeIntentId, amountCents: '500', status: 'pending' });
    expect(RecoveryRechargeOrderViewSchema.safeParse(envelope.data).success).toBe(false);
    expect(createPayment).toHaveBeenCalledTimes(1);
    const committed = await pool.query<{ recovery_usage_id: string | null }>(
      `SELECT recovery_usage_id FROM recharge_orders WHERE id = $1`,
      [view.id],
    );
    expect(committed.rows).toEqual([{ recovery_usage_id: null }]);
  });

  it('keeps an explicit recovery create response strict after commit', async () => {
    const recoveryUsageId = randomUUID();
    await ensureRecovery('handler-recovery-view', recoveryUsageId);
    const { reply } = await invokeCreateHandler({
      recoveryUsageId,
      rechargeIntentId: recoveryUsageId,
      amountCents: 300,
      channel: 'qr',
      payType: 'alipay',
    });

    expect(reply.statusCode).toBe(201);
    const envelope = reply.body as { data: unknown };
    const view = RecoveryRechargeOrderViewSchema.parse(envelope.data);
    expect(view).toMatchObject({ recoveryUsageId, rechargeIntentId: recoveryUsageId });
    expect(RechargeOrderViewSchema.safeParse(envelope.data).success).toBe(false);
    const committed = await pool.query<{ recovery_usage_id: string | null }>(
      `SELECT recovery_usage_id FROM recharge_orders WHERE id = $1`,
      [view.id],
    );
    expect(committed.rows).toEqual([{ recovery_usage_id: recoveryUsageId }]);
  });

  it('keeps a fresh submitting order untouched, then recovers the stale trace by query lease', async () => {
    const prepared = await prepare('stale-submit');
    const repeated = await prepare('stale-submit');
    expect(prepared).toMatchObject({ shouldSubmit: true, created: true });
    expect(repeated).toMatchObject({ shouldSubmit: false, created: false });
    expect(repeated.order.paymentStatus).toBe('created');

    await expect(
      repository.leaseRechargeOrderForOwner({
        ownerUserId: ownerId,
        orderId: prepared.order.id,
        leaseOwner: 'fresh-submit-must-not-query',
        leaseMs: 30_000,
      }),
    ).resolves.toBeNull();

    await pool.query(`UPDATE recharge_orders SET next_query_at = now() WHERE id = $1`, [
      prepared.order.id,
    ]);
    const leased = await repository.leaseRechargeOrderForOwner({
      ownerUserId: ownerId,
      orderId: prepared.order.id,
      leaseOwner: 'stale-submit-query-original',
      leaseMs: 30_000,
    });
    expect(leased).toMatchObject({
      id: prepared.order.id,
      payTraceNo: prepared.order.payTraceNo,
      paymentStatus: 'unknown',
    });
    const attempt = await pool.query<{ status: string }>(
      `SELECT status
         FROM payment_attempts
        WHERE recharge_order_id = $1 AND attempt_no = 1`,
      [prepared.order.id],
    );
    expect(attempt.rows[0]?.status).toBe('unknown');
  });

  it('serializes concurrent idempotent preparation into exactly one gateway submission owner', async () => {
    const recoveryUsageId = randomUUID();
    await ensureRecovery('prepare-race', recoveryUsageId);
    recoveryIds.set('prepare-race', recoveryUsageId);
    const prepared = await Promise.all([
      prepareForRecovery('prepare-race', recoveryUsageId, recoveryUsageId),
      prepareForRecovery('prepare-race', recoveryUsageId, recoveryUsageId),
    ]);
    expect(prepared.filter((result) => result.shouldSubmit)).toHaveLength(1);
    expect(prepared.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(prepared.map((result) => result.order.id)).size).toBe(1);
    expect(new Set(prepared.map((result) => result.order.payTraceNo)).size).toBe(1);
    expect(new Set(prepared.map((result) => result.order.recoveryUsageId))).toEqual(
      new Set([recoveryIds.get('prepare-race')]),
    );
    const linked = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM recharge_orders
        WHERE owner_user_id = $1 AND recovery_usage_id = $2`,
      [ownerId, recoveryIds.get('prepare-race')],
    );
    expect(linked.rows[0]?.count).toBe('1');
  });

  it('rejects wrong amount or intent and replaces only a terminal uncredited order', async () => {
    const recoveryUsageId = randomUUID();
    await ensureRecovery('replacement', recoveryUsageId);
    recoveryIds.set('replacement', recoveryUsageId);

    await expect(
      prepareForRecovery('wrong-amount', recoveryUsageId, recoveryUsageId, 301n),
    ).rejects.toBeInstanceOf(BillingIdempotencyConflictError);
    await expect(
      prepareForRecovery('wrong-first-intent', recoveryUsageId, randomUUID()),
    ).rejects.toBeInstanceOf(BillingIdempotencyConflictError);

    const first = await prepareForRecovery('replacement-first', recoveryUsageId, recoveryUsageId);
    await repository.recordSubmission(first.order.id, first.order.attemptNo, {
      status: 'failed',
      gatewayResultCode: 'PAY_FAIL',
    });
    const replacementIntentId = randomUUID();
    const replacement = await prepareForRecovery(
      'replacement-second',
      recoveryUsageId,
      replacementIntentId,
    );
    expect(replacement).toMatchObject({ created: true, shouldSubmit: true });
    expect(replacement.order).toMatchObject({
      recoveryUsageId,
      clientIdempotencyKey: replacementIntentId,
    });
    await expect(
      repository.findRechargeOrderByRecovery(ownerId, recoveryUsageId),
    ).resolves.toMatchObject({ id: replacement.order.id });

    const activeIntent = await pool.query<{ active_recharge_intent_id: string }>(
      `SELECT active_recharge_intent_id
         FROM pending_usage_recoveries
        WHERE owner_user_id = $1 AND usage_id = $2`,
      [ownerId, recoveryUsageId],
    );
    expect(activeIntent.rows[0]?.active_recharge_intent_id).toBe(replacementIntentId);
  });

  it('does not replace paid or credited orders and rejects expired recoveries', async () => {
    const paid = await prepare('paid-no-replace');
    await repository.processNotification(
      notification(
        paid.order,
        createHash('sha256').update(`${runId}:paid-no-replace`).digest('hex'),
        `TRADE-PG-${runId}-PAID`,
      ),
    );
    await expect(
      prepareForRecovery('paid-replacement', recoveryIds.get('paid-no-replace')!, randomUUID()),
    ).rejects.toBeInstanceOf(BillingIdempotencyConflictError);

    const expiredRecoveryId = randomUUID();
    await ensureRecovery('expired', expiredRecoveryId, 1);
    recoveryIds.set('expired', expiredRecoveryId);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await expect(
      prepareForRecovery('expired-order', expiredRecoveryId, expiredRecoveryId),
    ).rejects.toBeInstanceOf(BillingRecoveryUnavailableError);
  });

  it('rejects a replacement after a callback credits the terminal order first', async () => {
    const first = await prepare('callback-first');
    await repository.recordSubmission(first.order.id, first.order.attemptNo, {
      status: 'failed',
      gatewayResultCode: 'PAY_FAIL',
    });
    const eventFingerprint = createHash('sha256').update(`${runId}:callback-first`).digest('hex');
    const trusted = notification(first.order, eventFingerprint, `TRADE-PG-${runId}-FIRST`);

    await expect(repository.processNotification(trusted)).resolves.toBe('processed');
    await expect(repository.processNotification(trusted)).resolves.toBe('duplicate');
    await expect(
      prepareForRecovery(
        'callback-first-replacement',
        recoveryIds.get('callback-first')!,
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(BillingIdempotencyConflictError);

    await expect(
      repository.findRechargeOrderByRecovery(ownerId, recoveryIds.get('callback-first')!),
    ).resolves.toMatchObject({ id: first.order.id, creditStatus: 'credited' });
    const accounting = await pool.query<{ credit_count: string; event_count: string }>(
      `SELECT
         (SELECT count(*)::text
            FROM wallet_ledger
           WHERE recharge_order_id = $1 AND entry_type = 'recharge_credit') AS credit_count,
         (SELECT count(*)::text
            FROM payment_callback_events
           WHERE event_fingerprint = $2 AND processing_status = 'processed') AS event_count`,
      [first.order.id, eventFingerprint],
    );
    expect(accounting.rows[0]).toEqual({ credit_count: '1', event_count: '1' });
  });

  it('keeps a late-credited old order visible after replacement wins first', async () => {
    const first = await prepare('replacement-first-callback');
    await repository.recordSubmission(first.order.id, first.order.attemptNo, {
      status: 'failed',
      gatewayResultCode: 'PAY_FAIL',
    });
    const recoveryUsageId = recoveryIds.get('replacement-first-callback')!;
    const replacementIntentId = randomUUID();
    const replacement = await prepareForRecovery(
      'replacement-first-callback-new',
      recoveryUsageId,
      replacementIntentId,
    );
    expect(replacement).toMatchObject({ created: true, shouldSubmit: true });

    const eventFingerprint = createHash('sha256')
      .update(`${runId}:replacement-first-callback`)
      .digest('hex');
    const trusted = notification(first.order, eventFingerprint, `TRADE-PG-${runId}-LATE`);
    await expect(repository.processNotification(trusted)).resolves.toBe('processed');
    await expect(repository.processNotification(trusted)).resolves.toBe('duplicate');

    await expect(
      repository.findRechargeOrderByRecovery(ownerId, recoveryUsageId),
    ).resolves.toMatchObject({ id: first.order.id, creditStatus: 'credited' });
    await expect(
      repository.findRechargeOrderByIntent(ownerId, replacementIntentId),
    ).resolves.toMatchObject({ id: replacement.order.id, creditStatus: 'uncredited' });
    const state = await pool.query<{
      active_recharge_intent_id: string;
      credit_count: string;
      event_count: string;
    }>(
      `SELECT p.active_recharge_intent_id,
              (SELECT count(*)::text
                 FROM wallet_ledger
                WHERE recharge_order_id = $3 AND entry_type = 'recharge_credit') AS credit_count,
              (SELECT count(*)::text
                 FROM payment_callback_events
                WHERE event_fingerprint = $4 AND processing_status = 'processed') AS event_count
         FROM pending_usage_recoveries p
        WHERE p.owner_user_id = $1 AND p.usage_id = $2`,
      [ownerId, recoveryUsageId, first.order.id, eventFingerprint],
    );
    expect(state.rows[0]).toEqual({
      active_recharge_intent_id: replacementIntentId,
      credit_count: '1',
      event_count: '1',
    });
  });

  it('does not deadlock a trusted callback racing terminal-order replacement', async () => {
    const first = await prepare('callback-replacement-race');
    await repository.recordSubmission(first.order.id, first.order.attemptNo, {
      status: 'failed',
      gatewayResultCode: 'PAY_FAIL',
    });
    const recoveryUsageId = recoveryIds.get('callback-replacement-race')!;
    let callbackLockedOrder!: () => void;
    let releaseCallback!: () => void;
    let replacementLockedPending!: () => void;
    let releaseReplacement!: () => void;
    const atCallbackOrderLock = new Promise<void>((resolve) => (callbackLockedOrder = resolve));
    const callbackBarrier = new Promise<void>((resolve) => (releaseCallback = resolve));
    const atReplacementPendingLock = new Promise<void>(
      (resolve) => (replacementLockedPending = resolve),
    );
    const replacementBarrier = new Promise<void>((resolve) => (releaseReplacement = resolve));
    let callbackPid = 0;
    let replacementPid = 0;
    const callbackPool: TxPool = {
      async connect() {
        const client = await apiPool.connect();
        callbackPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid'))
          .rows[0]!.pid;
        return {
          async query(sql, params) {
            const result = await client.query(sql, params);
            if (sql.includes('WHERE ro.pay_trace_no') && sql.includes('FOR UPDATE OF ro')) {
              callbackLockedOrder();
              await callbackBarrier;
            }
            return result as never;
          },
          release: () => client.release(),
        };
      },
    };
    const replacementPool: TxPool = {
      async connect() {
        const client = await apiPool.connect();
        replacementPid = (
          await client.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid')
        ).rows[0]!.pid;
        return {
          async query(sql, params) {
            const result = await client.query(sql, params);
            if (sql.includes('FROM pending_usage_recoveries') && sql.includes('FOR UPDATE')) {
              replacementLockedPending();
              await replacementBarrier;
            }
            return result as never;
          },
          release: () => client.release(),
        };
      },
    };
    const timeout = (message: string) =>
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(message)), 5_000).unref?.();
      });
    const eventFingerprint = createHash('sha256')
      .update(`${runId}:callback-replacement-race`)
      .digest('hex');
    const trusted = notification(first.order, eventFingerprint, `TRADE-PG-${runId}-RACE`);
    const callback = new PgBillingRepository(callbackPool, apiPool).processNotification(trusted);
    let replacement!: ReturnType<typeof prepareForRecovery>;
    let settled!: Awaited<ReturnType<typeof Promise.allSettled>>;
    try {
      await Promise.race([atCallbackOrderLock, timeout('callback did not lock old order')]);
      replacement = prepareForRecovery(
        'callback-replacement-new',
        recoveryUsageId,
        randomUUID(),
        300n,
        new PgBillingRepository(replacementPool, apiPool),
      );
      await Promise.race([
        atReplacementPendingLock,
        timeout('replacement did not lock pending recovery'),
      ]);
      releaseCallback();
      const deadline = Date.now() + 5_000;
      for (;;) {
        const lock = await pool.query<{ blocked: boolean }>(
          `SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked`,
          [callbackPid, replacementPid],
        );
        if (lock.rows[0]?.blocked) break;
        if (Date.now() >= deadline) throw new Error('callback did not wait on replacement lock');
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      releaseReplacement();
      settled = await Promise.race([
        Promise.allSettled([replacement, callback]),
        timeout('callback/replacement deadlock'),
      ]);
    } finally {
      releaseCallback();
      releaseReplacement();
    }
    expect(settled).toMatchObject([
      { status: 'fulfilled', value: { created: true, shouldSubmit: true } },
      { status: 'fulfilled', value: 'processed' },
    ]);
    await expect(repository.processNotification(trusted)).resolves.toBe('duplicate');
    await expect(
      repository.findRechargeOrderByRecovery(ownerId, recoveryUsageId),
    ).resolves.toMatchObject({ id: first.order.id, creditStatus: 'credited' });
    const accounting = await pool.query<{ credit_count: string; event_count: string }>(
      `SELECT
         (SELECT count(*)::text
            FROM wallet_ledger
           WHERE recharge_order_id = $1 AND entry_type = 'recharge_credit') AS credit_count,
         (SELECT count(*)::text
            FROM payment_callback_events
           WHERE event_fingerprint = $2 AND processing_status = 'processed') AS event_count`,
      [first.order.id, eventFingerprint],
    );
    expect(accounting.rows[0]).toEqual({ credit_count: '1', event_count: '1' });
  }, 15_000);

  it('admits only three active orders per owner while preserving same-intent replay', async () => {
    const first = await prepare('active-1');
    await prepare('active-2');
    await prepare('active-3');

    await expect(prepare('active-1')).resolves.toMatchObject({
      created: false,
      shouldSubmit: false,
      order: { id: first.order.id },
    });
    await expect(prepare('active-4')).rejects.toBeInstanceOf(BillingRateLimitedError);

    await pool.query(`UPDATE recharge_orders SET next_query_at = NULL WHERE id = $1`, [
      first.order.id,
    ]);
    await expect(prepare('active-4')).resolves.toMatchObject({
      created: true,
      shouldSubmit: true,
    });
  });

  it('bounds failed recharge-order creation per owner over a rolling hour', async () => {
    for (let index = 0; index < 10; index += 1) {
      const prepared = await prepare(`hourly-${index}`);
      await repository.recordSubmission(prepared.order.id, prepared.order.attemptNo, {
        status: 'failed',
        gatewayResultCode: 'PAY_FAIL',
      });
    }

    await expect(prepare('hourly-over-limit')).rejects.toMatchObject({
      name: 'BillingRateLimitedError',
      retryAfterSeconds: 3_600,
    });
  });

  it('retires exhausted query compensation but still credits a later trusted callback', async () => {
    const prepared = await prepare('query-cutoff');
    await pool.query(
      `UPDATE recharge_orders
          SET next_query_at = now(), query_attempt_count = 120
        WHERE id = $1`,
      [prepared.order.id],
    );

    await expect(repository.retireExpiredReconciliations({ limit: 1 })).resolves.toBe(1);
    await expect(repository.findRechargeOrder(ownerId, prepared.order.id)).resolves.toMatchObject({
      reconciliationActive: false,
      paymentStatus: 'created',
      creditStatus: 'uncredited',
    });

    await expect(
      repository.processNotification(
        notification(
          prepared.order,
          createHash('sha256').update(`${runId}:late-callback`).digest('hex'),
          `TRADE-PG-${runId}-LATE`,
        ),
      ),
    ).resolves.toBe('processed');
    await expect(repository.getWallet(ownerId)).resolves.toEqual({
      availableCents: 300n,
      reservedCents: 0n,
    });
  });

  it('keeps the first trusted platform order identity across late POST and query races', async () => {
    const callbackFirst = await prepare('pending-callback-first');
    await expect(
      repository.processNotification({
        ...notification(
          callbackFirst.order,
          createHash('sha256').update(`${runId}:pending-first`).digest('hex'),
          `TRADE-PG-${runId}-BOUND`,
        ),
        resultCode: 'PAY_IN_PROCESS',
      }),
    ).resolves.toBe('processed');
    await expect(
      repository.recordSubmission(callbackFirst.order.id, callbackFirst.order.attemptNo, {
        status: 'pending',
        platformTradeNo: `TRADE-PG-${runId}-LATE-POST`,
      }),
    ).resolves.toMatchObject({ platformTradeNo: `TRADE-PG-${runId}-BOUND` });
    await expect(
      repository.recordSubmission(callbackFirst.order.id, callbackFirst.order.attemptNo, {
        status: 'failed',
        gatewayResultCode: 'PAY_FAIL',
      }),
    ).resolves.toMatchObject({
      paymentStatus: 'pending',
      platformTradeNo: `TRADE-PG-${runId}-BOUND`,
      reconciliationActive: true,
    });
    const callbackFirstAttempt = await pool.query<{ status: string }>(
      `SELECT status
         FROM payment_attempts
        WHERE recharge_order_id = $1 AND attempt_no = 1`,
      [callbackFirst.order.id],
    );
    expect(callbackFirstAttempt.rows[0]?.status).toBe('pending');

    const queryRace = await prepare('query-identity-race');
    await pool.query(`UPDATE recharge_orders SET next_query_at = now() WHERE id = $1`, [
      queryRace.order.id,
    ]);
    const leased = await repository.leaseRechargeOrderForOwner({
      ownerUserId: ownerId,
      orderId: queryRace.order.id,
      leaseOwner: 'query-identity-race',
      leaseMs: 30_000,
    });
    expect(leased).not.toBeNull();
    if (!leased) return;
    await repository.recordSubmission(queryRace.order.id, queryRace.order.attemptNo, {
      status: 'pending',
      platformTradeNo: `TRADE-PG-${runId}-POST-WINS`,
    });
    await repository.applyQueryResult(leased, {
      status: 'failed',
      gatewayResultCode: 'PAY_FAIL',
    });

    const state = await pool.query<{
      order_trade_no: string;
      attempt_trade_no: string;
      payment_status: string;
      query_lease_owner: string | null;
    }>(
      `SELECT ro.platform_trade_no AS order_trade_no,
              pa.platform_trade_no AS attempt_trade_no,
              ro.payment_status,
              ro.query_lease_owner
         FROM recharge_orders ro
         JOIN payment_attempts pa ON pa.recharge_order_id = ro.id AND pa.attempt_no = 1
        WHERE ro.id = $1`,
      [queryRace.order.id],
    );
    expect(state.rows[0]).toEqual({
      order_trade_no: `TRADE-PG-${runId}-POST-WINS`,
      attempt_trade_no: `TRADE-PG-${runId}-POST-WINS`,
      payment_status: 'unknown',
      query_lease_owner: null,
    });
  });

  it('clears expired bearer payment actions in bounded batches', async () => {
    const prepared = await prepare('expired-action');
    await repository.recordSubmission(prepared.order.id, prepared.order.attemptNo, {
      status: 'pending',
      action: {
        kind: 'code_url',
        value: 'opaque-expired-action',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await pool.query(
      `UPDATE payment_attempts
          SET started_at = now() - interval '2 minutes',
              action_expires_at = now() - interval '1 minute'
        WHERE recharge_order_id = $1`,
      [prepared.order.id],
    );

    await expect(repository.clearExpiredPaymentActions({ limit: 1 })).resolves.toBe(1);
    const action = await pool.query<{
      action_kind: string | null;
      action_value: string | null;
      action_expires_at: Date | null;
    }>(
      `SELECT action_kind, action_value, action_expires_at
         FROM payment_attempts
        WHERE recharge_order_id = $1`,
      [prepared.order.id],
    );
    expect(action.rows[0]).toEqual({
      action_kind: null,
      action_value: null,
      action_expires_at: null,
    });
  });

  it('serializes callback and query credit into one balance increment and one ledger row', async () => {
    const prepared = await prepare('race-credit');
    await repository.recordSubmission(prepared.order.id, prepared.order.attemptNo, {
      status: 'pending',
      action: {
        kind: 'code_url',
        value: 'opaque-test-action',
        expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
      },
    });
    await pool.query(`UPDATE recharge_orders SET next_query_at = now() WHERE id = $1`, [
      prepared.order.id,
    ]);
    const leased = await repository.leaseRechargeOrderForOwner({
      ownerUserId: ownerId,
      orderId: prepared.order.id,
      leaseOwner: 'pg-race-query',
      leaseMs: 30_000,
    });
    expect(leased).not.toBeNull();
    if (!leased) return;

    const callback = notification(
      prepared.order,
      createHash('sha256').update(`${runId}:callback-race`).digest('hex'),
      `TRADE-PG-${runId}-RACE`,
    );
    await Promise.all([
      repository.processNotification(callback),
      repository.applyQueryResult(leased, {
        status: 'succeeded',
        gatewayResultCode: 'PAY_SUCCESS',
        platformTradeNo: `TRADE-PG-${runId}-RACE`,
        paidAt: new Date(),
      }),
    ]);

    const state = await pool.query<{
      balance_cents: string;
      credit_status: string;
      payment_status: string;
      ledger_count: number;
    }>(
      `SELECT ba.balance_cents::text,
              ro.credit_status,
              ro.payment_status,
              (
                SELECT count(*)::int
                  FROM wallet_ledger wl
                 WHERE wl.recharge_order_id = ro.id
              ) AS ledger_count
         FROM recharge_orders ro
         JOIN billing_accounts ba ON ba.owner_user_id = ro.owner_user_id
        WHERE ro.id = $1`,
      [prepared.order.id],
    );
    expect(state.rows[0]).toEqual({
      balance_cents: '300',
      credit_status: 'credited',
      payment_status: 'succeeded',
      ledger_count: 1,
    });
  });

  it('keeps success terminal when callback commits before the pre-order response is saved', async () => {
    const prepared = await prepare('callback-first');
    await expect(
      repository.processNotification(
        notification(
          prepared.order,
          createHash('sha256').update(`${runId}:callback-first`).digest('hex'),
          `TRADE-PG-${runId}-FIRST`,
        ),
      ),
    ).resolves.toBe('processed');

    const late = await repository.recordSubmission(prepared.order.id, prepared.order.attemptNo, {
      status: 'pending',
      action: {
        kind: 'code_url',
        value: 'late-opaque-action',
        expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
      },
    });
    expect(late).toMatchObject({
      paymentStatus: 'succeeded',
      creditStatus: 'credited',
      platformTradeNo: `TRADE-PG-${runId}-FIRST`,
    });
    const count = await pool.query<{ balance: string; ledger_count: number }>(
      `SELECT ba.balance_cents::text AS balance,
              count(wl.id)::int AS ledger_count
         FROM billing_accounts ba
         JOIN wallet_ledger wl ON wl.owner_user_id = ba.owner_user_id
        WHERE ba.owner_user_id = $1
        GROUP BY ba.balance_cents`,
      [ownerId],
    );
    expect(count.rows[0]).toEqual({ balance: '300', ledger_count: 1 });
  });

  it('0010 upgrade converts stored aggregate_qr rows and tightens the channel constraint', async () => {
    const client = await pool.connect();
    try {
      // 复刻 0010 的约束演进：旧 CHECK 只允许 h5/aggregate_qr → 迁移存量行 → 收紧为 h5/qr。
      await client.query(`
        CREATE TEMP TABLE recharge_orders_upgrade_test (
          id uuid PRIMARY KEY,
          payment_method text NOT NULL,
          CONSTRAINT ck_test_payment_method
            CHECK (payment_method IN ('h5', 'aggregate_qr'))
        )
      `);
      const legacyId = randomUUID();
      await client.query(
        `INSERT INTO recharge_orders_upgrade_test (id, payment_method)
         VALUES ($1, 'aggregate_qr')`,
        [legacyId],
      );
      await client.query(
        'ALTER TABLE recharge_orders_upgrade_test DROP CONSTRAINT ck_test_payment_method',
      );
      await client.query(
        `UPDATE recharge_orders_upgrade_test
            SET payment_method = 'qr'
          WHERE payment_method = 'aggregate_qr'`,
      );
      await client.query(
        `ALTER TABLE recharge_orders_upgrade_test
          ADD CONSTRAINT ck_test_payment_method CHECK (payment_method IN ('h5', 'qr'))`,
      );

      const converted = await client.query<{ payment_method: string }>(
        `SELECT payment_method FROM recharge_orders_upgrade_test WHERE id = $1`,
        [legacyId],
      );
      expect(converted.rows[0]?.payment_method).toBe('qr');

      await expect(
        client.query(
          `INSERT INTO recharge_orders_upgrade_test (id, payment_method) VALUES ($1, 'aggregate_qr')`,
          [randomUUID()],
        ),
      ).rejects.toThrow();
      await client.query(
        `INSERT INTO recharge_orders_upgrade_test (id, payment_method) VALUES ($1, 'qr')`,
        [randomUUID()],
      );
    } finally {
      client.release();
    }
  });

  it('0011 upgrade migrates h5 rows and allows only qr', async () => {
    const client = await pool.connect();
    try {
      // 复刻 0011 的约束演进：承接 0010 的 h5/qr → 迁移存量 h5 → 收紧为只允许 qr。
      await client.query(`
        CREATE TEMP TABLE recharge_orders_0011_test (
          id uuid PRIMARY KEY,
          payment_method text NOT NULL,
          CONSTRAINT ck_test_0011_payment_method
            CHECK (payment_method IN ('h5', 'qr'))
        )
      `);
      const legacyH5Id = randomUUID();
      const qrId = randomUUID();
      await client.query(
        `INSERT INTO recharge_orders_0011_test (id, payment_method) VALUES ($1, 'h5'), ($2, 'qr')`,
        [legacyH5Id, qrId],
      );
      await client.query(
        `UPDATE recharge_orders_0011_test
            SET payment_method = 'qr'
          WHERE payment_method <> 'qr'`,
      );
      await client.query(
        'ALTER TABLE recharge_orders_0011_test DROP CONSTRAINT ck_test_0011_payment_method',
      );
      await client.query(
        `ALTER TABLE recharge_orders_0011_test
          ADD CONSTRAINT ck_test_0011_payment_method CHECK (payment_method IN ('qr'))`,
      );

      const converted = await client.query<{ payment_method: string }>(
        `SELECT payment_method FROM recharge_orders_0011_test WHERE id = $1`,
        [legacyH5Id],
      );
      expect(converted.rows[0]?.payment_method).toBe('qr');

      await expect(
        client.query(
          `INSERT INTO recharge_orders_0011_test (id, payment_method) VALUES ($1, 'h5')`,
          [randomUUID()],
        ),
      ).rejects.toThrow();
      await client.query(
        `INSERT INTO recharge_orders_0011_test (id, payment_method) VALUES ($1, 'qr')`,
        [randomUUID()],
      );
    } finally {
      client.release();
    }
  });
});
