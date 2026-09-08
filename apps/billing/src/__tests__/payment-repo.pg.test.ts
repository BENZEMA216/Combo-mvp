import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgBillingStore } from '../repo.js';
import { createPgPaymentStore } from '../payment-repo.js';
import { createPaymentTokenCodec, type PaymentStore } from '../payment-service.js';
import type { BillingStore } from '../service.js';

const databaseUrl = process.env.BILLING_V2_TEST_DATABASE_URL;
const password = process.env.POSTGRES_BILLING_PASSWORD;
const suite =
  process.env.BILLING_V2_REPO_PG_TEST === '1' && databaseUrl && password ? describe : describe.skip;
suite('payment admission PostgreSQL transactions', () => {
  let admin: Client;
  let pool: Pool;
  let payments: PaymentStore;
  let billing: BillingStore;
  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const url = new URL(databaseUrl!);
    url.username = 'combo_billing';
    url.password = password!;
    pool = new Pool({ connectionString: url.toString(), max: 6 });
    payments = createPgPaymentStore(pool, {
      tokens: createPaymentTokenCodec('test-payment-key-'.repeat(3)),
      checkoutBaseUrl: 'https://pay.combo.test',
    });
    billing = createPgBillingStore(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });
  async function input() {
    const userId = randomUUID();
    await admin.query('INSERT INTO v2_users(id) VALUES ($1)', [userId]);
    return {
      userId,
      agentId: 'payment-test-agent',
      operationId: randomUUID(),
      callId: randomUUID(),
      requestFingerprint: 'a'.repeat(64),
      pricingPolicyId: 'price-v1',
      estimatedAmount: 300,
    };
  }

  it('creates one payment requirement and binds every immutable input', async () => {
    const call = await input();
    const [a, b] = await Promise.all([payments.admitCall(call), payments.admitCall(call)]);
    expect(a).toEqual(b);
    if (a.kind !== 'payment_required') throw new Error('expected payment requirement');
    for (const change of [
      { userId: randomUUID() },
      { operationId: randomUUID() },
      { estimatedAmount: 301 },
      { requestFingerprint: 'b'.repeat(64) },
      { pricingPolicyId: 'price-v2' },
    ]) {
      expect(await payments.admitCall({ ...call, ...change })).toEqual({ kind: 'conflict' });
    }
    const stored = await admin.query<{ token_digest: string; fields: string[] }>(
      'SELECT token_digest, ARRAY(SELECT jsonb_object_keys(to_jsonb(p))) AS fields FROM v2_payment_requests p WHERE id = $1',
      [a.requirement.id],
    );
    expect(stored.rows[0]!.token_digest).not.toBe(a.requirement.paymentToken);
    expect(stored.rows[0]!.fields).not.toContain('payment_token');
    expect(
      await billing.createHold({
        userId: call.userId,
        agentId: call.agentId,
        turnId: call.callId,
        estimatedAmount: 300,
        overdraftHardLimitCents: 500,
      }),
    ).toMatchObject({ kind: 'conflict' });
  });

  it('maps different request keys to one payment and isolates users', async () => {
    const call = await input();
    const required = await payments.admitCall(call);
    if (required.kind !== 'payment_required') throw new Error('requirement missing');
    expect(
      await payments.createPayment({
        userId: randomUUID(),
        paymentToken: required.requirement.paymentToken,
        requestKey: 'request-key-1',
      }),
    ).toEqual({ kind: 'not_found' });
    const outcomes = await Promise.all(
      ['request-key-1', 'request-key-2'].map((requestKey) =>
        payments.createPayment({
          userId: call.userId,
          paymentToken: required.requirement.paymentToken,
          requestKey,
        }),
      ),
    );
    expect(outcomes.filter((o) => o.kind === 'payment' && !o.replayed)).toHaveLength(1);
    for (const outcome of outcomes)
      expect(outcome).toMatchObject({
        kind: 'payment',
        payment: { paymentRequestId: required.requirement.id, status: 'waiting' },
      });
    const another = await payments.admitCall({ ...call, callId: randomUUID() });
    if (another.kind !== 'payment_required') throw new Error('second requirement missing');
    expect(
      await payments.createPayment({
        userId: call.userId,
        paymentToken: another.requirement.paymentToken,
        requestKey: 'request-key-1',
      }),
    ).toEqual({ kind: 'conflict' });
    expect(
      await payments.getPayment({
        userId: randomUUID(),
        paymentRequestId: required.requirement.id,
      }),
    ).toBeNull();
    expect(
      await payments.findPayment({ userId: call.userId, requestKey: 'request-key-2' }),
    ).toMatchObject({ paymentRequestId: required.requirement.id });
  });

  it('credits once, reserves the original call, then admits and settles it once', async () => {
    const call = await input();
    const required = await payments.admitCall(call);
    if (required.kind !== 'payment_required') throw new Error('requirement missing');
    const id = required.requirement.id;
    const confirmation = {
      paymentRequestId: id,
      channelTransactionId: randomUUID(),
      amountCents: 300,
    };
    expect(await payments.confirmPayment(confirmation)).toEqual({ kind: 'conflict' });
    await payments.createPayment({
      userId: call.userId,
      paymentToken: required.requirement.paymentToken,
      requestKey: 'request-key-1',
    });
    expect(await payments.confirmPayment({ ...confirmation, amountCents: 301 })).toEqual({
      kind: 'conflict',
    });
    const confirmations = await Promise.all([
      payments.confirmPayment(confirmation),
      payments.confirmPayment(confirmation),
    ]);
    expect(confirmations.filter((o) => o.kind === 'completed' && !o.replayed)).toHaveLength(1);
    expect(confirmations.filter((o) => o.kind === 'completed' && o.replayed)).toHaveLength(1);
    expect(await payments.getPayment({ userId: call.userId, paymentRequestId: id })).toMatchObject({
      status: 'completed',
    });
    expect(await billing.readWallet(call.userId)).toMatchObject({
      principalBalance: 300,
      heldAmount: 300,
    });
    expect(
      await billing.createHold({
        userId: call.userId,
        agentId: call.agentId,
        turnId: randomUUID(),
        estimatedAmount: 1,
        overdraftHardLimitCents: 500,
      }),
    ).toMatchObject({ kind: 'insufficient' });
    const admissions = await Promise.all([payments.admitCall(call), payments.admitCall(call)]);
    expect(admissions.filter((o) => o.kind === 'admitted' && !o.replayed)).toHaveLength(1);
    const admission = admissions[0]!;
    if (admission.kind !== 'admitted') throw new Error('admission missing');
    expect(await billing.readWallet(call.userId)).toMatchObject({ heldAmount: 300 });
    expect(await billing.settleHold({ holdId: admission.holdId, actualAmount: 200 })).toMatchObject(
      { kind: 'settled', replayed: false },
    );
    expect(await billing.readWallet(call.userId)).toMatchObject({
      principalBalance: 100,
      heldAmount: 0,
    });
    expect(await payments.admitCall(call)).toMatchObject({ kind: 'admitted', replayed: true });
    const credit = await admin.query<{ count: string }>(
      "SELECT count(*)::text FROM v2_ledger WHERE ref_id = $1 AND kind = 'recharge'",
      [id],
    );
    expect(credit.rows[0]!.count).toBe('1');
    expect(await payments.releaseExpiredFunds(10)).toBe(0);
  });

  it('uses ordinary available balance without generating a payment', async () => {
    const call = await input();
    await billing.adminRecharge({ userId: call.userId, amount: 500, idempotencyKey: randomUUID() });
    const outcomes = await Promise.all([payments.admitCall(call), payments.admitCall(call)]);
    expect(outcomes.filter((o) => o.kind === 'admitted' && !o.replayed)).toHaveLength(1);
    expect(await billing.readWallet(call.userId)).toMatchObject({
      principalBalance: 500,
      heldAmount: 300,
    });
    const count = await admin.query<{ count: string }>(
      'SELECT count(*)::text FROM v2_payment_requests WHERE user_id = $1',
      [call.userId],
    );
    expect(count.rows[0]!.count).toBe('0');
  });

  it('retries an explicitly failed paid call with the original business identity and one successful debit', async () => {
    const call = await input();
    const required = await payments.admitCall(call);
    if (required.kind !== 'payment_required') throw new Error('payment missing');
    await payments.createPayment({
      userId: call.userId,
      paymentToken: required.requirement.paymentToken,
      requestKey: 'retry-test-key',
    });
    await payments.confirmPayment({
      paymentRequestId: required.requirement.id,
      channelTransactionId: randomUUID(),
      amountCents: 300,
    });
    const first = await payments.admitCall(call);
    if (first.kind !== 'admitted') throw new Error('admission missing');
    expect(
      await payments.finishCall!({
        holdId: first.holdId,
        outcome: 'failed_no_charge',
        failureReason: 'invalid_response',
      }),
    ).toBe('conflict');
    await billing.settleHold({ holdId: first.holdId, actualAmount: 0 });
    expect(await payments.admitCall(call)).toMatchObject({ replayed: true });
    expect(
      await payments.finishCall!({
        holdId: first.holdId,
        outcome: 'failed_no_charge',
        failureReason: 'invalid_response',
      }),
    ).toBe('recorded');
    const next = await Promise.all([payments.admitCall(call), payments.admitCall(call)]);
    expect(next.filter((r) => r.kind === 'admitted' && !r.replayed)).toHaveLength(1);
    const retry = next.find((r) => r.kind === 'admitted' && !r.replayed)!;
    if (retry.kind !== 'admitted') throw new Error('retry missing');
    expect(retry.holdId).not.toBe(first.holdId);
    expect(retry.executionId).not.toBe(call.callId);
    await billing.settleHold({ holdId: retry.holdId, actualAmount: 200 });
    expect(await payments.finishCall!({ holdId: retry.holdId, outcome: 'succeeded' })).toBe(
      'recorded',
    );
    expect(await payments.admitCall(call)).toMatchObject({ holdId: retry.holdId, replayed: true });
    expect(
      await payments.finishCall!({
        holdId: first.holdId,
        outcome: 'failed_no_charge',
        failureReason: 'invalid_response',
      }),
    ).toBe('recorded');
    expect(await payments.admitCall(call)).toMatchObject({ holdId: retry.holdId, replayed: true });
    expect(await billing.readWallet(call.userId)).toMatchObject({
      principalBalance: 100,
      heldAmount: 0,
    });
    const facts = await admin.query(
      `SELECT (SELECT count(*) FROM v2_payment_requests WHERE user_id=$1)::int AS payments,
      (SELECT count(*) FROM v2_ledger WHERE user_id=$1 AND kind='recharge')::int AS credits,
      (SELECT count(*) FROM v2_ledger WHERE user_id=$1 AND kind='consume')::int AS debits`,
      [call.userId],
    );
    expect(facts.rows[0]).toEqual({ payments: 1, credits: 1, debits: 1 });
    const root = await admin.query(
      'SELECT operation_id,call_id,hold_id FROM v2_billable_calls WHERE user_id=$1',
      [call.userId],
    );
    expect(root.rows[0]).toMatchObject({
      operation_id: call.operationId,
      call_id: call.callId,
      hold_id: first.holdId,
    });
    await expect(
      pool.query('DELETE FROM v2_call_attempts WHERE hold_id=$1', [retry.holdId]),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "UPDATE v2_call_attempts SET state='failed_no_charge',failure_reason='invalid_response' WHERE hold_id=$1",
        [retry.holdId],
      ),
    ).rejects.toThrow();
  });

  it('does not equate successful zero-cost, unknown, or historical zero settlements with retry permission', async () => {
    for (const outcome of ['succeeded', 'unknown'] as const) {
      const call = await input();
      await billing.adminRecharge({
        userId: call.userId,
        amount: 300,
        idempotencyKey: randomUUID(),
      });
      const first = await payments.admitCall(call);
      if (first.kind !== 'admitted') throw new Error('missing');
      await billing.settleHold({ holdId: first.holdId, actualAmount: 0 });
      expect(await payments.finishCall!({ holdId: first.holdId, outcome })).toBe('recorded');
      expect(
        await payments.finishCall!({
          holdId: first.holdId,
          outcome: 'failed_no_charge',
          failureReason: 'invalid_response',
        }),
      ).toBe('conflict');
      expect(await payments.admitCall(call)).toMatchObject({ replayed: true });
    }
    const call = await input();
    await billing.adminRecharge({ userId: call.userId, amount: 300, idempotencyKey: randomUUID() });
    const first = await payments.admitCall(call);
    if (first.kind !== 'admitted') throw new Error('missing');
    await billing.settleHold({ holdId: first.holdId, actualAmount: 0 });
    expect(await payments.admitCall(call)).toMatchObject({ replayed: true });
    expect(await payments.admitCall({ ...call, requestFingerprint: 'b'.repeat(64) })).toEqual({
      kind: 'conflict',
    });
  });

  it('requires an explicit audited failure receipt to recover a pre-upgrade zero settlement', async () => {
    const call = await input();
    await billing.adminRecharge({ userId: call.userId, amount: 300, idempotencyKey: randomUUID() });
    const held = await billing.createHold({
      userId: call.userId,
      agentId: call.agentId,
      turnId: call.callId,
      estimatedAmount: 300,
      overdraftHardLimitCents: 500,
    });
    if (held.kind !== 'held') throw new Error('hold missing');
    await admin.query(
      `INSERT INTO v2_billable_calls(user_id,agent_id,operation_id,call_id,request_fingerprint,pricing_policy_id,estimated_amount,hold_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        call.userId,
        call.agentId,
        call.operationId,
        call.callId,
        call.requestFingerprint,
        call.pricingPolicyId,
        call.estimatedAmount,
        held.hold.id,
      ],
    );
    await billing.settleHold({ holdId: held.hold.id, actualAmount: 0 });
    expect(await payments.admitCall(call)).toMatchObject({ replayed: true });
    expect(
      await payments.finishCall!({
        holdId: held.hold.id,
        outcome: 'failed_no_charge',
        failureReason: 'invalid_response',
      }),
    ).toBe('recorded');
    expect(await payments.admitCall(call)).toMatchObject({ replayed: false });
  });

  it('accounts for trusted late success and rejects a channel transaction reused for another payment', async () => {
    const call = await input();
    const callRef = randomUUID();
    const paymentId = randomUUID();
    await admin.query(
      `INSERT INTO v2_billable_calls(id,user_id,agent_id,operation_id,call_id,request_fingerprint,pricing_policy_id,estimated_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        callRef,
        call.userId,
        call.agentId,
        call.operationId,
        call.callId,
        call.requestFingerprint,
        call.pricingPolicyId,
        call.estimatedAmount,
      ],
    );
    await admin.query(
      `INSERT INTO v2_payment_requests(id,call_ref,user_id,amount,token_digest,state,created_at,updated_at,expires_at) VALUES ($1,$2,$3,300,$4,'waiting',now()-interval '1 day',now()-interval '1 day',now()-interval '23 hours')`,
      [paymentId, callRef, call.userId, randomUUID().replaceAll('-', '').repeat(2)],
    );
    expect(
      await payments.getPayment({ userId: call.userId, paymentRequestId: paymentId }),
    ).toMatchObject({ status: 'closed' });
    const channelTransactionId = randomUUID();
    expect(
      await payments.confirmPayment({
        paymentRequestId: paymentId,
        channelTransactionId,
        amountCents: 300,
      }),
    ).toEqual({ kind: 'completed', replayed: false });
    expect(
      await payments.getPayment({ userId: call.userId, paymentRequestId: paymentId }),
    ).toMatchObject({ status: 'completed' });
    const other = await input();
    const req = await payments.admitCall(other);
    if (req.kind !== 'payment_required') throw new Error('requirement missing');
    await payments.createPayment({
      userId: other.userId,
      paymentToken: req.requirement.paymentToken,
      requestKey: 'request-key-1',
    });
    expect(
      await payments.confirmPayment({
        paymentRequestId: req.requirement.id,
        channelTransactionId,
        amountCents: 300,
      }),
    ).toEqual({ kind: 'conflict' });
  });

  it('releases an expired unclaimed reservation once without removing the credited balance', async () => {
    const call = await input();
    const callRef = randomUUID();
    const paymentId = randomUUID();
    await admin.query('BEGIN');
    try {
      await admin.query(
        `INSERT INTO v2_billable_calls(id,user_id,agent_id,operation_id,call_id,request_fingerprint,pricing_policy_id,estimated_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,300)`,
        [
          callRef,
          call.userId,
          call.agentId,
          call.operationId,
          call.callId,
          call.requestFingerprint,
          call.pricingPolicyId,
        ],
      );
      await admin.query(
        `INSERT INTO v2_payment_requests(id,call_ref,user_id,amount,token_digest,state,channel_transaction_id,created_at,updated_at,expires_at,completed_at) VALUES ($1,$2,$3,300,$4,'completed',$5,now()-interval '8 days',now()-interval '8 days',now()-interval '7 days',now()-interval '8 days')`,
        [paymentId, callRef, call.userId, randomUUID().replaceAll('-', '').repeat(2), randomUUID()],
      );
      await admin.query(
        'INSERT INTO v2_wallets(user_id,principal_balance,held_amount) VALUES ($1,300,300)',
        [call.userId],
      );
      await admin.query(
        `INSERT INTO v2_ledger(user_id,kind,bucket,amount,ref_id,idempotency_key) VALUES ($1,'recharge','principal',300,$2,$3), ($1,'hold',NULL,300,$2,$4)`,
        [call.userId, paymentId, `payment-credit:${paymentId}`, `payment-reserve:${paymentId}`],
      );
      await admin.query(
        `INSERT INTO v2_payment_fund_reservations(payment_id,call_ref,user_id,amount,created_at,expires_at) VALUES ($1,$2,$3,300,now()-interval '8 days',now()-interval '1 day')`,
        [paymentId, callRef, call.userId],
      );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    expect(await payments.releaseExpiredFunds(10)).toBe(1);
    expect(await payments.releaseExpiredFunds(10)).toBe(0);
    expect(await billing.readWallet(call.userId)).toMatchObject({
      principalBalance: 300,
      heldAmount: 0,
    });
    expect(await payments.admitCall(call)).toMatchObject({ kind: 'admitted', replayed: false });
  });

  it('rejects incomplete accounting and changes to persisted payment identity', async () => {
    const call = await input();
    const required = await payments.admitCall(call);
    if (required.kind !== 'payment_required') throw new Error('requirement missing');
    await payments.createPayment({
      userId: call.userId,
      paymentToken: required.requirement.paymentToken,
      requestKey: 'request-key-1',
    });
    await expect(
      pool.query(
        "UPDATE v2_payment_requests SET state = 'completed', channel_transaction_id = $2, completed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1",
        [required.requirement.id, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query('UPDATE v2_payment_requests SET amount = amount + 1 WHERE id = $1', [
        required.requirement.id,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      admin.query(
        'UPDATE v2_billable_calls SET operation_id = $2 WHERE agent_id = $1 AND call_id = $3',
        [call.agentId, randomUUID(), call.callId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });
});
