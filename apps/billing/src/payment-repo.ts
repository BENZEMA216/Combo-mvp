import { randomUUID } from 'node:crypto';
import { type Pool } from 'pg';
import {
  CreatePaymentBodySchema,
  PaymentActionSchema,
  PaymentIdentifierSchema,
  PaymentRequestKeySchema,
} from '@cb/payment-protocol';
import {
  CallAdmissionInputSchema,
  paymentRequirement,
  paymentView,
  type CallAdmissionInput,
  type CallAdmissionOutcome,
  type PaymentRecord,
  type PaymentStore,
  type PaymentTokenCodec,
} from './payment-service.js';
import {
  lockWallet,
  userExists,
  walletStateIsSafe,
  withTransaction,
  type Queryable,
} from './repo.js';
import { availableBalance, ledgerIdempotencyKeys } from './service.js';
import { finishAttempt, insertAttempt, latestAttempt } from './payment-attempts.js';

interface CallRow {
  id: string;
  user_id: string;
  agent_id: string;
  operation_id: string;
  call_id: string;
  request_fingerprint: string;
  pricing_policy_id: string;
  estimated_amount: string;
  hold_id: string | null;
}
interface PaymentRow {
  id: string;
  call_ref: string;
  user_id: string;
  amount: string;
  state: PaymentRecord['state'];
  channel_transaction_id: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  completed_at: Date | null;
}
interface FundsRow {
  payment_id: string;
  call_ref: string;
  user_id: string;
  amount: string;
  state: 'available' | 'claimed' | 'released';
  expires_at: Date;
}

function record(row: PaymentRow): PaymentRecord {
  const amount = Number(row.amount);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 999_999_999_999_999)
    throw new Error('payment amount outside public range');
  return {
    id: row.id,
    userId: row.user_id,
    amount,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  };
}
async function lockCall(tx: Queryable, agentId: string, callId: string): Promise<void> {
  // Same advisory key as the legacy hold endpoint: the two paths cannot admit the same call.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
    `v2-hold:${agentId}:${callId}`,
  ]);
}
async function paymentForCall(tx: Queryable, callRef: string): Promise<PaymentRow | undefined> {
  return (
    await tx.query<PaymentRow>('SELECT * FROM v2_payment_requests WHERE call_ref = $1 FOR UPDATE', [
      callRef,
    ])
  ).rows[0];
}
function matches(call: CallRow, input: CallAdmissionInput): boolean {
  return (
    call.user_id === input.userId &&
    call.operation_id === input.operationId &&
    call.request_fingerprint === input.requestFingerprint &&
    call.pricing_policy_id === input.pricingPolicyId &&
    Number(call.estimated_amount) === input.estimatedAmount
  );
}
async function createHold(
  tx: Queryable,
  call: CallRow,
  reservedPaymentId?: string,
  attemptNumber = 1,
  executionId = call.call_id,
): Promise<string> {
  const hold = await tx.query<{ id: string }>(
    `INSERT INTO v2_holds (user_id, agent_id, turn_id, estimated_amount, created_at, expires_at)
    VALUES ($1, $2, $3, $4, statement_timestamp(), statement_timestamp() + interval '5 minutes') RETURNING id`,
    [call.user_id, call.agent_id, executionId, call.estimated_amount],
  );
  const id = hold.rows[0]!.id;
  if (reservedPaymentId) {
    await tx.query(
      `UPDATE v2_payment_fund_reservations SET state = 'claimed', hold_id = $2 WHERE payment_id = $1 AND state = 'available'`,
      [reservedPaymentId, id],
    );
    await tx.query(
      `INSERT INTO v2_ledger(user_id, kind, bucket, amount, ref_id, idempotency_key) VALUES ($1, 'release', NULL, $2, $3, $4)`,
      [
        call.user_id,
        call.estimated_amount,
        reservedPaymentId,
        `payment-claim:${reservedPaymentId}`,
      ],
    );
  } else {
    await tx.query(
      `UPDATE v2_wallets SET held_amount = held_amount + $2, updated_at = clock_timestamp() WHERE user_id = $1`,
      [call.user_id, call.estimated_amount],
    );
  }
  await tx.query(
    `INSERT INTO v2_ledger(user_id, kind, bucket, amount, ref_id, idempotency_key) VALUES ($1, 'hold', NULL, $2, $3, $4)`,
    [
      call.user_id,
      call.estimated_amount,
      id,
      ledgerIdempotencyKeys.hold(call.agent_id, executionId),
    ],
  );
  if (!call.hold_id)
    await tx.query('UPDATE v2_billable_calls SET hold_id = $2 WHERE id = $1', [call.id, id]);
  await insertAttempt(tx, call.id, attemptNumber, id, executionId);
  return id;
}

export function createPgPaymentStore(
  pool: Pool,
  options: { tokens: PaymentTokenCodec; checkoutBaseUrl: string },
): PaymentStore {
  const base = options.checkoutBaseUrl.replace(/\/+$/, '');
  const baseUrl = new URL(base);
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash)
    throw new Error('checkout base URL must not contain credentials, query or fragment');
  PaymentActionSchema.parse({
    kind: 'open_url',
    url: `${base}/payments/check`,
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const view = (row: PaymentRow) => paymentView(record(row), base, new Date());

  return {
    finishCall: (input) => finishAttempt(pool, input),
    async admitCall(raw) {
      const input = CallAdmissionInputSchema.parse(raw);
      return withTransaction(pool, async (tx): Promise<CallAdmissionOutcome> => {
        await lockCall(tx, input.agentId, input.callId);
        let call = (
          await tx.query<CallRow>(
            'SELECT * FROM v2_billable_calls WHERE agent_id = $1 AND call_id = $2 FOR UPDATE',
            [input.agentId, input.callId],
          )
        ).rows[0];
        if (call && !matches(call, input)) return { kind: 'conflict' };
        if (call?.hold_id) {
          const attempt = await latestAttempt(tx, call.id);
          if (attempt?.state === 'failed_no_charge' && attempt.attempt_no < 20) {
            const wallet = await lockWallet(tx, input.userId);
            if (availableBalance(wallet) < input.estimatedAmount) return { kind: 'conflict' };
            const executionId = `attempt-${randomUUID()}`;
            const holdId = await createHold(
              tx,
              call,
              undefined,
              attempt.attempt_no + 1,
              executionId,
            );
            return { kind: 'admitted', holdId, executionId, replayed: false };
          }
          return {
            kind: 'admitted',
            holdId: attempt?.hold_id ?? call.hold_id,
            replayed: true,
            ...(attempt ? { executionId: attempt.execution_id } : {}),
          };
        }
        const legacy = await tx.query(
          'SELECT id FROM v2_holds WHERE agent_id = $1 AND turn_id = $2 FOR UPDATE',
          [input.agentId, input.callId],
        );
        if (legacy.rowCount) return { kind: 'conflict' };
        if (!(await userExists(tx, input.userId))) return { kind: 'not_found' };
        if (!call) {
          call = (
            await tx.query<CallRow>(
              `INSERT INTO v2_billable_calls(user_id, agent_id, operation_id, call_id, request_fingerprint, pricing_policy_id, estimated_amount)
            VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
              [
                input.userId,
                input.agentId,
                input.operationId,
                input.callId,
                input.requestFingerprint,
                input.pricingPolicyId,
                input.estimatedAmount,
              ],
            )
          ).rows[0]!;
        }
        const payment = await paymentForCall(tx, call.id);
        const funds = (
          await tx.query<FundsRow>(
            'SELECT * FROM v2_payment_fund_reservations WHERE call_ref = $1 FOR UPDATE',
            [call.id],
          )
        ).rows[0];
        const wallet = await lockWallet(tx, input.userId);
        if (funds?.state === 'available' && funds.expires_at > new Date()) {
          return {
            kind: 'admitted',
            holdId: await createHold(tx, call, funds.payment_id),
            replayed: false,
            executionId: call.call_id,
          };
        }
        if (funds?.state === 'available') return { kind: 'conflict' };
        // Once a payment requirement exists, its payment path owns this admission. An ordinary
        // top-up must not start the call while an independent checkout can still succeed.
        if (payment && payment.state !== 'completed') {
          return payment.expires_at > new Date()
            ? {
                kind: 'payment_required',
                requirement: paymentRequirement(record(payment), options.tokens),
              }
            : { kind: 'conflict' };
        }
        if (availableBalance(wallet) >= input.estimatedAmount)
          return {
            kind: 'admitted',
            holdId: await createHold(tx, call),
            executionId: call.call_id,
            replayed: false,
          };
        if (payment) return { kind: 'conflict' };
        const id = randomUUID();
        const inserted = (
          await tx.query<PaymentRow>(
            `INSERT INTO v2_payment_requests(id, call_ref, user_id, amount, token_digest, created_at, updated_at, expires_at)
          VALUES ($1,$2,$3,$4,$5,statement_timestamp(),statement_timestamp(),statement_timestamp() + interval '15 minutes') RETURNING *`,
            [
              id,
              call.id,
              input.userId,
              input.estimatedAmount,
              options.tokens.digest(options.tokens.issue(id)),
            ],
          )
        ).rows[0]!;
        return {
          kind: 'payment_required',
          requirement: paymentRequirement(record(inserted), options.tokens),
        };
      });
    },

    async createPayment(input) {
      const { paymentToken, requestKey } = CreatePaymentBodySchema.parse({
        paymentToken: input.paymentToken,
        requestKey: input.requestKey,
      });
      return withTransaction(pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          `v2-payment-key:${input.userId}:${requestKey}`,
        ]);
        const payment = (
          await tx.query<PaymentRow>(
            'SELECT * FROM v2_payment_requests WHERE user_id = $1 AND token_digest = $2 FOR UPDATE',
            [input.userId, options.tokens.digest(paymentToken)],
          )
        ).rows[0];
        if (!payment) return { kind: 'not_found' };
        const oldKey = (
          await tx.query<{ payment_id: string }>(
            'SELECT payment_id FROM v2_payment_request_keys WHERE user_id = $1 AND request_key = $2',
            [input.userId, requestKey],
          )
        ).rows[0];
        if (oldKey && oldKey.payment_id !== payment.id) return { kind: 'conflict' };
        if (payment.state === 'required' && payment.expires_at <= new Date())
          return { kind: 'conflict' };
        if (!oldKey)
          await tx.query(
            'INSERT INTO v2_payment_request_keys(user_id, request_key, payment_id) VALUES ($1,$2,$3)',
            [input.userId, requestKey, payment.id],
          );
        const replayed = payment.state !== 'required';
        if (!replayed) {
          const updated = (
            await tx.query<PaymentRow>(
              `UPDATE v2_payment_requests SET state = 'waiting', updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
              [payment.id],
            )
          ).rows[0]!;
          return { kind: 'payment', payment: view(updated), replayed: false };
        }
        return { kind: 'payment', payment: view(payment), replayed: true };
      });
    },

    async getPayment(input) {
      PaymentIdentifierSchema.parse(input.paymentRequestId);
      const row = (
        await pool.query<PaymentRow>(
          `SELECT * FROM v2_payment_requests WHERE user_id = $1 AND id::text = $2 AND state <> 'required'`,
          [input.userId, input.paymentRequestId],
        )
      ).rows[0];
      return row ? view(row) : null;
    },
    async findPayment(input) {
      PaymentRequestKeySchema.parse(input.requestKey);
      const row = (
        await pool.query<PaymentRow>(
          `SELECT p.* FROM v2_payment_requests p JOIN v2_payment_request_keys k ON k.payment_id = p.id AND k.user_id = p.user_id WHERE k.user_id = $1 AND k.request_key = $2 AND p.state <> 'required'`,
          [input.userId, input.requestKey],
        )
      ).rows[0];
      return row ? view(row) : null;
    },

    async confirmPayment(input) {
      if (
        !Number.isSafeInteger(input.amountCents) ||
        input.amountCents < 1 ||
        typeof input.channelTransactionId !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(input.channelTransactionId)
      )
        return { kind: 'conflict' };
      return withTransaction(pool, async (tx) => {
        const scope = (
          await tx.query<CallRow>(
            'SELECT c.* FROM v2_billable_calls c JOIN v2_payment_requests p ON p.call_ref = c.id WHERE p.id::text = $1',
            [input.paymentRequestId],
          )
        ).rows[0];
        if (!scope) return { kind: 'not_found' };
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          `v2-payment-channel:${input.channelTransactionId}`,
        ]);
        await lockCall(tx, scope.agent_id, scope.call_id);
        const payment = (await paymentForCall(tx, scope.id))!;
        if (Number(payment.amount) !== input.amountCents || payment.state === 'required')
          return { kind: 'conflict' };
        if (payment.state === 'completed')
          return payment.channel_transaction_id === input.channelTransactionId
            ? { kind: 'completed', replayed: true }
            : { kind: 'conflict' };
        const collision = await tx.query(
          'SELECT 1 FROM v2_payment_requests WHERE channel_transaction_id = $1',
          [input.channelTransactionId],
        );
        if (collision.rowCount) return { kind: 'conflict' };
        const wallet = await lockWallet(tx, payment.user_id);
        if (
          !walletStateIsSafe(
            BigInt(wallet.principalBalance) + BigInt(payment.amount),
            BigInt(wallet.bonusBalance),
            BigInt(wallet.heldAmount) + BigInt(payment.amount),
          )
        )
          return { kind: 'conflict' };
        await tx.query(
          `UPDATE v2_wallets SET principal_balance = principal_balance + $2, held_amount = held_amount + $2, updated_at = clock_timestamp() WHERE user_id = $1`,
          [payment.user_id, payment.amount],
        );
        await tx.query(
          `INSERT INTO v2_ledger(user_id, kind, bucket, amount, ref_id, idempotency_key) VALUES ($1,'recharge','principal',$2,$3,$4), ($1,'hold',NULL,$2,$3,$5)`,
          [
            payment.user_id,
            payment.amount,
            payment.id,
            `payment-credit:${payment.id}`,
            `payment-reserve:${payment.id}`,
          ],
        );
        await tx.query(
          `INSERT INTO v2_payment_fund_reservations(payment_id, call_ref, user_id, amount, created_at, expires_at) VALUES ($1,$2,$3,$4,statement_timestamp(),statement_timestamp() + interval '7 days')`,
          [payment.id, payment.call_ref, payment.user_id, payment.amount],
        );
        await tx.query(
          `UPDATE v2_payment_requests SET state = 'completed', channel_transaction_id = $2, completed_at = statement_timestamp(), updated_at = statement_timestamp() WHERE id = $1`,
          [payment.id, input.channelTransactionId],
        );
        return { kind: 'completed', replayed: false };
      });
    },

    async releaseExpiredFunds(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error('invalid sweep limit');
      const candidates = await pool.query<CallRow>(
        `SELECT c.* FROM v2_billable_calls c JOIN v2_payment_fund_reservations f ON f.call_ref = c.id WHERE f.state = 'available' AND f.expires_at <= clock_timestamp() ORDER BY f.expires_at LIMIT $1`,
        [limit],
      );
      let count = 0;
      for (const call of candidates.rows) {
        count += await withTransaction(pool, async (tx) => {
          await lockCall(tx, call.agent_id, call.call_id);
          const funds = (
            await tx.query<FundsRow>(
              `SELECT * FROM v2_payment_fund_reservations WHERE call_ref = $1 AND state = 'available' AND expires_at <= clock_timestamp() FOR UPDATE`,
              [call.id],
            )
          ).rows[0];
          if (!funds) return 0;
          await lockWallet(tx, funds.user_id);
          await tx.query(
            `UPDATE v2_wallets SET held_amount = held_amount - $2, updated_at = clock_timestamp() WHERE user_id = $1`,
            [funds.user_id, funds.amount],
          );
          await tx.query(
            `UPDATE v2_payment_fund_reservations SET state = 'released' WHERE payment_id = $1`,
            [funds.payment_id],
          );
          await tx.query(
            `INSERT INTO v2_ledger(user_id, kind, bucket, amount, ref_id, idempotency_key) VALUES ($1,'release',NULL,$2,$3,$4)`,
            [funds.user_id, funds.amount, funds.payment_id, `payment-expire:${funds.payment_id}`],
          );
          return 1;
        });
      }
      return count;
    },
  };
}
