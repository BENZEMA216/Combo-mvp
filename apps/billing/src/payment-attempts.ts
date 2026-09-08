import type { Pool } from 'pg';
import { withTransaction, type Queryable } from './repo.js';
import { CallAttemptResultSchema, type CallAttemptResult } from './payment-service.js';

export interface CallAttempt {
  call_ref: string;
  attempt_no: number;
  hold_id: string;
  execution_id: string;
  state: 'running' | 'succeeded' | 'failed_no_charge' | 'unknown';
  failure_reason: string | null;
}
export async function latestAttempt(
  tx: Queryable,
  callRef: string,
): Promise<CallAttempt | undefined> {
  return (
    await tx.query<CallAttempt>(
      'SELECT * FROM v2_call_attempts WHERE call_ref=$1 ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE',
      [callRef],
    )
  ).rows[0];
}
export async function insertAttempt(
  tx: Queryable,
  callRef: string,
  attempt: number,
  holdId: string,
  executionId: string,
): Promise<void> {
  await tx.query(
    'INSERT INTO v2_call_attempts(call_ref,attempt_no,hold_id,execution_id) VALUES($1,$2,$3,$4)',
    [callRef, attempt, holdId, executionId],
  );
}

/** Only trusted Gateway outcomes may close an attempt; no bodies or model output are stored. */
export async function finishAttempt(
  pool: Pool,
  raw: CallAttemptResult,
): Promise<'recorded' | 'conflict' | 'not_found'> {
  const input = CallAttemptResultSchema.parse(raw);
  return withTransaction(pool, async (tx) => {
    const found = (
      await tx.query<{ id: string; agent_id: string; call_id: string; hold_id: string }>(
        `SELECT * FROM v2_billable_calls WHERE hold_id=$1
      OR id=(SELECT call_ref FROM v2_call_attempts WHERE hold_id=$1)`,
        [input.holdId],
      )
    ).rows[0];
    if (!found) return 'not_found';
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [
      `v2-hold:${found.agent_id}:${found.call_id}`,
    ]);
    await tx.query('SELECT id FROM v2_billable_calls WHERE id=$1 FOR UPDATE', [found.id]);
    let attempt = (
      await tx.query<CallAttempt>('SELECT * FROM v2_call_attempts WHERE hold_id=$1 FOR UPDATE', [
        input.holdId,
      ])
    ).rows[0];
    if (attempt && attempt.state !== 'running')
      return attempt.state === input.outcome &&
        attempt.failure_reason === (input.failureReason ?? null)
        ? 'recorded'
        : 'conflict';
    const hold = (
      await tx.query<{ status: string; actual_amount: string | null }>(
        'SELECT status,actual_amount FROM v2_holds WHERE id=$1 FOR UPDATE',
        [input.holdId],
      )
    ).rows[0];
    if (!hold) return 'not_found';
    if (input.outcome === 'succeeded' && hold.status !== 'settled') return 'conflict';
    if (input.outcome === 'failed_no_charge') {
      if (hold.status !== 'settled' || hold.actual_amount !== '0') return 'conflict';
      const usage = await tx.query('SELECT 1 FROM v2_metering_events WHERE hold_id=$1 LIMIT 1', [
        input.holdId,
      ]);
      if (usage.rowCount) return 'conflict';
    }
    // Historical calls are never inferred to have failed merely from a zero amount. An
    // authenticated, explicit Gateway failure receipt is required before they can be retried.
    if (!attempt) {
      if (found.hold_id !== input.holdId || input.outcome !== 'failed_no_charge') return 'conflict';
      await insertAttempt(tx, found.id, 1, input.holdId, found.call_id);
    }
    await tx.query(
      'UPDATE v2_call_attempts SET state=$2,failure_reason=$3,finished_at=clock_timestamp() WHERE hold_id=$1',
      [input.holdId, input.outcome, input.failureReason ?? null],
    );
    return 'recorded';
  });
}
