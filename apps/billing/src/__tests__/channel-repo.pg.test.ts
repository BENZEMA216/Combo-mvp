import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgChannelOrderStore, clearExpiredChannelActions } from '../channel-repo.js';
import {
  ChannelConflictError,
  createPaymentChannelService,
  type ChannelOrderStore,
} from '../channel-service.js';
import { LeshouyingPaymentGateway, signPaymentParameters } from '../channel/index.js';
import { createPgPaymentStore } from '../payment-repo.js';
import { createPaymentTokenCodec, type PaymentStore } from '../payment-service.js';
const databaseUrl = process.env.BILLING_V2_TEST_DATABASE_URL;
const password = process.env.POSTGRES_BILLING_PASSWORD;
const suite =
  process.env.BILLING_V2_REPO_PG_TEST === '1' && databaseUrl && password ? describe : describe.skip;
const key = 'test-only-channel-key';
const scope = {
  environment: 'test' as const,
  institutionNo: 'TEST_INST',
  merchantNo: 'TEST_MERCHANT',
};
suite('channel orders and accounting PostgreSQL invariants', () => {
  let admin: Client;
  let pool: Pool;
  let store: ChannelOrderStore;
  let payments: PaymentStore;
  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const url = new URL(databaseUrl!);
    url.username = 'combo_billing';
    url.password = password!;
    pool = new Pool({ connectionString: url.toString(), max: 8 });
    store = createPgChannelOrderStore(pool);
    payments = createPgPaymentStore(pool, {
      tokens: createPaymentTokenCodec('test-payment-key-'.repeat(3)),
      checkoutBaseUrl: 'https://pay.test',
    });
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });
  async function payment() {
    const userId = randomUUID();
    await admin.query('INSERT INTO v2_users(id) VALUES($1)', [userId]);
    const call = {
      userId,
      agentId: 'channel-test-agent',
      operationId: randomUUID(),
      callId: randomUUID(),
      requestFingerprint: 'a'.repeat(64),
      pricingPolicyId: 'test-price',
      estimatedAmount: 300,
    };
    const required = await payments.admitCall(call);
    if (required.kind !== 'payment_required') throw new Error('expected 402');
    await payments.createPayment({
      userId,
      paymentToken: required.requirement.paymentToken,
      requestKey: randomUUID(),
    });
    return { paymentId: required.requirement.id, userId, payType: 'wechat' as const, ...scope };
  }
  it('persists one original channel order before dispatch and enforces identity and role constraints', async () => {
    const input = await payment();
    const prepared = await Promise.all([store.prepare(input), store.prepare(input)]);
    expect(prepared.filter((p) => p?.shouldSubmit)).toHaveLength(1);
    expect(prepared[0]?.order.payTraceNo).toBe(prepared[1]?.order.payTraceNo);
    expect(await store.prepare({ ...input, userId: randomUUID() })).toBeNull();
    await expect(
      admin.query('UPDATE v2_payment_channel_orders SET amount=301 WHERE payment_id=$1', [
        input.paymentId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      admin.query("UPDATE v2_payment_channel_orders SET pay_type='alipay' WHERE payment_id=$1", [
        input.paymentId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      pool.query('DELETE FROM v2_payment_channel_orders WHERE payment_id=$1', [input.paymentId]),
    ).rejects.toMatchObject({ code: '42501' });
    const grants = await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('combo_authz','v2_payment_channel_orders','SELECT') AS allowed",
    );
    expect(grants.rows[0]!.allowed).toBe(false);
  });
  it('pins channel transaction identity and caps action lifetime without trusting prepay as paid', async () => {
    const input = await payment();
    const prepared = (await store.prepare(input))!;
    await store.recordSubmission(prepared.order, {
      status: 'pending',
      platformTradeNo: `trade-${randomUUID()}`,
      action: {
        kind: 'code_url',
        value: 'test-private-qr',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const saved = (await store.get(input.paymentId, input.userId))!;
    expect(saved.actionExpiresAt?.getTime()).toBe(saved.expiresAt.getTime());
    expect(saved.completed).toBe(false);
    expect(
      await payments.getPayment({ userId: input.userId, paymentRequestId: input.paymentId }),
    ).toMatchObject({ status: 'waiting' });
    expect(
      await store.recordResult(
        saved,
        { status: 'succeeded', platformTradeNo: 'different-trade' },
        'b'.repeat(64),
        'callback',
      ),
    ).toBe(false);
    expect((await store.prepare(input))?.shouldSubmit).toBe(false);
  });
  it('leases each pending query once across workers and honors the durable attempt budget', async () => {
    const input = await payment();
    await store.prepare(input);
    await pool.query(
      "UPDATE v2_payment_channel_orders SET next_query_at=now()-interval '1 second' WHERE payment_id=$1",
      [input.paymentId],
    );
    const [a, b] = await Promise.all([
      store.leaseQueries({ ...scope, owner: randomUUID(), limit: 100 }),
      store.leaseQueries({ ...scope, owner: randomUUID(), limit: 100 }),
    ]);
    expect([...a, ...b].filter((o) => o.paymentId === input.paymentId)).toHaveLength(1);
    await pool.query(
      "UPDATE v2_payment_channel_orders SET query_attempts=120,query_lease_until=now()-interval '1 second' WHERE payment_id=$1",
      [input.paymentId],
    );
    expect(
      (await store.leaseQueries({ ...scope, owner: randomUUID(), limit: 100 })).some(
        (o) => o.paymentId === input.paymentId,
      ),
    ).toBe(false);
    await expect(
      pool.query('UPDATE v2_payment_channel_orders SET query_attempts=0 WHERE payment_id=$1', [
        input.paymentId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
  });
  it('verifies callbacks and accounts once despite duplicates, while rejecting a reused channel trade', async () => {
    const input = await payment();
    const prepared = (await store.prepare(input))!;
    await store.recordSubmission(prepared.order, {
      status: 'pending',
      action: {
        kind: 'code_url',
        value: 'private-test-qr',
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const gateway = new LeshouyingPaymentGateway(
      {
        environment: 'TEST',
        institutionNo: scope.institutionNo,
        merchantNo: scope.merchantNo,
        institutionKey: key,
        notifyUrl: 'https://callback.test',
        timeoutMs: 1000,
      },
      async () => {
        throw new Error('no PSP network in database tests');
      },
    );
    const service = createPaymentChannelService({ store, payments, gateway });
    const trade = `trade-${randomUUID()}`;
    function signed(order: typeof prepared.order, amount = '300') {
      const fields = {
        return_code: 'SUCCESS',
        result_code: 'PAY_SUCCESS',
        inst_no: scope.institutionNo,
        mch_no: scope.merchantNo,
        pay_trace_no: order.payTraceNo,
        pay_time: order.payTime,
        total_amount: amount,
        trade_no: trade,
        attach: order.paymentId,
      };
      return { ...fields, sign: signPaymentParameters(fields, key) };
    }
    await expect(service.notify(signed(prepared.order, '301'))).rejects.toBeInstanceOf(
      ChannelConflictError,
    );
    await expect(
      service.notify({ ...signed(prepared.order), sign: '0'.repeat(32) }),
    ).rejects.toThrow();
    expect(
      await Promise.all([
        service.notify(signed(prepared.order)),
        service.notify(signed(prepared.order)),
      ]),
    ).toEqual(['completed', 'completed']);
    expect(
      await payments.getPayment({ userId: input.userId, paymentRequestId: input.paymentId }),
    ).toMatchObject({ status: 'completed' });
    await clearExpiredChannelActions(pool, 100);
    expect((await store.get(input.paymentId, input.userId))?.qrContent).toBeUndefined();
    expect((await store.get(input.paymentId, input.userId))?.payTraceNo).toBe(
      prepared.order.payTraceNo,
    );
    expect(
      (
        await admin.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM v2_ledger WHERE ref_id=$1 AND kind='recharge'",
          [input.paymentId],
        )
      ).rows[0]!.count,
    ).toBe('1');
    expect(
      (
        await admin.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM v2_payment_channel_events WHERE payment_id=$1',
          [input.paymentId],
        )
      ).rows[0]!.count,
    ).toBe('1');
    const other = await payment();
    const second = (await store.prepare(other))!;
    await expect(service.notify(signed(second.order))).rejects.toThrow();
    expect(
      await payments.getPayment({ userId: other.userId, paymentRequestId: other.paymentId }),
    ).toMatchObject({ status: 'waiting' });
  });
  it('stops automatic queries after 24 hours but still credits a verified late callback', async () => {
    const userId = randomUUID();
    const callRef = randomUUID();
    const paymentId = randomUUID();
    await admin.query('INSERT INTO v2_users(id) VALUES($1)', [userId]);
    await admin.query(
      `INSERT INTO v2_billable_calls(id,user_id,agent_id,operation_id,call_id,request_fingerprint,pricing_policy_id,estimated_amount)
      VALUES($1,$2,'late-channel-agent',$3,$4,$5,'test-price',300)`,
      [callRef, userId, randomUUID(), randomUUID(), 'a'.repeat(64)],
    );
    await admin.query(
      `INSERT INTO v2_payment_requests(id,call_ref,user_id,amount,token_digest,state,created_at,updated_at,expires_at)
      VALUES($1,$2,$3,300,$4,'waiting',now()-interval '2 days',now()-interval '2 days',now()-interval '47 hours')`,
      [paymentId, callRef, userId, randomUUID().replaceAll('-', '').repeat(2)],
    );
    const trace = 'cbp' + paymentId.replaceAll('-', '');
    await admin.query(
      `INSERT INTO v2_payment_channel_orders(payment_id,user_id,amount,gateway_environment,institution_no,merchant_no,pay_trace_no,pay_time,pay_type,submission_state,created_at,expires_at,next_query_at)
      VALUES($1,$2,300,'test',$3,$4,$5,'20260905000000','wechat','pending',now()-interval '2 days',now()-interval '47 hours',now()-interval '1 day')`,
      [paymentId, userId, scope.institutionNo, scope.merchantNo, trace],
    );
    expect(
      (await store.leaseQueries({ ...scope, owner: randomUUID(), limit: 100 })).some(
        (row) => row.paymentId === paymentId,
      ),
    ).toBe(false);
    const gateway = new LeshouyingPaymentGateway(
      {
        environment: 'TEST',
        institutionNo: scope.institutionNo,
        merchantNo: scope.merchantNo,
        institutionKey: key,
        notifyUrl: 'https://callback.test',
        timeoutMs: 1000,
      },
      async () => {
        throw new Error('no network');
      },
    );
    const fields = {
      return_code: 'SUCCESS',
      result_code: 'PAY_SUCCESS',
      inst_no: scope.institutionNo,
      mch_no: scope.merchantNo,
      pay_trace_no: trace,
      pay_time: '20260905000000',
      total_amount: '300',
      trade_no: randomUUID(),
      attach: paymentId,
    };
    expect(
      await createPaymentChannelService({ store, payments, gateway }).notify({
        ...fields,
        sign: signPaymentParameters(fields, key),
      }),
    ).toBe('completed');
    expect(await payments.getPayment({ userId, paymentRequestId: paymentId })).toMatchObject({
      status: 'completed',
    });
  });
});
