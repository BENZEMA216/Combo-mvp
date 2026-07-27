import {
  withTransaction,
  type Queryable,
  type RuntimeDb,
  type TransactionOptions,
} from '../../platform/infra/db.js';
import { appendTurnMessage, SessionBusyError, toIso } from '../session/repo.js';

export const TURN_ABANDON_AFTER_MS = 1_800_000;
export const TURN_SWEEP_INTERVAL_MS = 60_000;

type TurnStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export type TerminalTurnStatus = Exclude<TurnStatus, 'running'>;
export interface TurnLastError {
  code: string;
  message: string;
}
interface TurnDbRow {
  id: string;
  session_id: string;
  status: TurnStatus;
  last_error: unknown;
  created_at: string | Date;
  finished_at: string | Date | null;
}
export interface TurnRow {
  id: string;
  sessionId: string;
  status: TurnStatus;
  createdAt: string;
  finishedAt: string | null;
}
export interface TerminalTurn {
  id: string;
  sessionId: string;
  status: TerminalTurnStatus;
  lastError: TurnLastError | null;
}

function toTurnRow(row: TurnDbRow): TurnRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    createdAt: toIso(row.created_at),
    finishedAt: row.finished_at === null ? null : toIso(row.finished_at),
  };
}

function toLastError(value: unknown): TurnLastError | null {
  if (typeof value !== 'object' || value === null) return null;
  const error = value as { code?: unknown; message?: unknown };
  return typeof error.code === 'string' && typeof error.message === 'string'
    ? { code: error.code, message: error.message }
    : null;
}

function toTerminalTurn(row: TurnDbRow): TerminalTurn {
  if (row.status === 'running') throw new Error('expected a terminal Turn');
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    lastError: toLastError(row.last_error),
  };
}

export async function createTurn(
  db: Queryable,
  input: { id: string; sessionId: string },
): Promise<TurnRow> {
  let result;
  try {
    result = await db.query<TurnDbRow>(
      `INSERT INTO turns (id, session_id, status)
       VALUES ($1, $2, 'running')
       RETURNING id, session_id, status, last_error, created_at, finished_at`,
      [input.id, input.sessionId],
    );
  } catch (error) {
    const pg = error as { code?: unknown; constraint?: unknown };
    if (pg.code === '23505' && pg.constraint === 'uq_turns_session_running') {
      throw new SessionBusyError();
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) throw new Error('createTurn: insert returned no row');
  return toTurnRow(row);
}

export async function finishTurnCas(
  db: Queryable,
  input: {
    id: string;
    status: Exclude<TurnStatus, 'running'>;
    lastError?: { code: string; message: string } | null;
  },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE turns SET status = $2, finished_at = now(), last_error = $3::jsonb
      WHERE id = $1 AND status = 'running'`,
    [input.id, input.status, input.lastError ? JSON.stringify(input.lastError) : null],
  );
  return result.rowCount === 1;
}

export async function lockTurnSession(db: Queryable, sessionId: string): Promise<void> {
  const locked = await db.query<{ id: string }>(
    `SELECT id FROM sessions WHERE id = $1 FOR UPDATE`,
    [sessionId],
  );
  if (!locked.rows[0]) throw new Error('turn session disappeared');
}

export async function lockRunningTurn(
  db: Queryable,
  id: string,
  sessionId: string,
): Promise<boolean> {
  const locked = await db.query<{ id: string }>(
    `SELECT id FROM turns
      WHERE id = $1 AND session_id = $2 AND status = 'running'
      FOR UPDATE`,
    [id, sessionId],
  );
  return locked.rows[0] !== undefined;
}

export async function finishTurnWithMessage(
  db: RuntimeDb,
  input: {
    id: string;
    sessionId: string;
    idx: number;
    status: 'failed' | 'interrupted';
    content: unknown[];
    lastError: { code: string; message: string };
  },
  options: { beforeFinish?: () => Promise<void>; transaction?: TransactionOptions } = {},
): Promise<boolean> {
  return withTransaction(
    db,
    async (transaction) => {
      // 开轮、归档和收尾统一先锁 Session，再触碰 Turn，避免反向锁序。
      await lockTurnSession(transaction, input.sessionId);
      if (!(await lockRunningTurn(transaction, input.id, input.sessionId))) return false;
      await options.beforeFinish?.();
      const won = await finishTurnCas(transaction, {
        id: input.id,
        status: input.status,
        lastError: input.lastError,
      });
      if (!won) return false;
      await appendTurnMessage(transaction, {
        sessionId: input.sessionId,
        turnId: input.id,
        idx: input.idx,
        role: 'assistant',
        content: input.content,
        status: 'failed',
      });
      return true;
    },
    options.transaction,
  );
}

export async function hasRunningTurn(db: Queryable, sessionId: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM turns WHERE session_id = $1 AND status = 'running') AS exists`,
    [sessionId],
  );
  return result.rows[0]?.exists ?? false;
}

export async function getRunningTurnId(db: Queryable, sessionId: string): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM turns
      WHERE session_id = $1 AND status = 'running'
      LIMIT 1`,
    [sessionId],
  );
  return result.rows[0]?.id ?? null;
}

/** 详情页刷新恢复使用；运行态以 PostgreSQL 为真源，Redis 只负责事件补发。 */
export async function getActiveTurn(
  db: Queryable,
  sessionId: string,
): Promise<{ id: string; createdAt: string } | null> {
  const result = await db.query<{ id: string; created_at: string | Date }>(
    `SELECT id, created_at FROM turns
      WHERE session_id = $1 AND status = 'running'
      LIMIT 1`,
    [sessionId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, createdAt: toIso(row.created_at) } : null;
}

/** Session 行锁持有者用它恢复最近一次已提交终态的 Redis 事件。 */
export async function getLatestTerminalTurn(
  db: Queryable,
  sessionId: string,
): Promise<TerminalTurn | null> {
  const result = await db.query<TurnDbRow>(
    `SELECT id, session_id, status, last_error, created_at, finished_at
       FROM turns
      WHERE session_id = $1 AND status <> 'running'
      ORDER BY finished_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 1`,
    [sessionId],
  );
  const row = result.rows[0];
  return row ? toTerminalTurn(row) : null;
}

export async function sweepExpiredTurns(
  db: RuntimeDb,
  cutoff: Date,
  options: {
    beforeFinish?: (turn: { id: string; sessionId: string }) => Promise<void>;
  } = {},
): Promise<TerminalTurn[]> {
  const candidates = await db.query<{ id: string; session_id: string }>(
    `SELECT id, session_id FROM turns
      WHERE status = 'running' AND created_at < $1
      ORDER BY created_at, id`,
    [cutoff],
  );
  const swept: TerminalTurn[] = [];
  for (const candidate of candidates.rows) {
    const won = await withTransaction(db, async (tx) => {
      // All terminal paths that write a Message lock Session before Turn. This
      // avoids a FK lock deadlock with local completion, which uses the same order.
      await lockTurnSession(tx, candidate.session_id);
      if (!(await lockRunningTurn(tx, candidate.id, candidate.session_id))) return false;
      await options.beforeFinish?.({ id: candidate.id, sessionId: candidate.session_id });
      const lastError: TurnLastError = {
        code: 'TURN_ABANDONED',
        message: '轮次运行超时，已由清扫器终止。',
      };
      const updated = await tx.query(
        `UPDATE turns SET status = 'failed', finished_at = now(),
                last_error = $2::jsonb
          WHERE id = $1 AND status = 'running'`,
        [candidate.id, JSON.stringify(lastError)],
      );
      if (updated.rowCount !== 1) return false;
      await tx.query(
        `INSERT INTO messages (session_id, turn_id, idx, seq, role, content, status)
         SELECT $1, $2, COALESCE(MAX(idx), 0) + 1, NULL, 'assistant', $3::jsonb, 'failed'
           FROM messages WHERE turn_id = $2`,
        [
          candidate.session_id,
          candidate.id,
          JSON.stringify([{ type: 'text', text: '服务异常中断,本轮已终止,请重试。' }]),
        ],
      );
      return true;
    });
    if (won) {
      swept.push({
        id: candidate.id,
        sessionId: candidate.session_id,
        status: 'failed',
        lastError: {
          code: 'TURN_ABANDONED',
          message: '轮次运行超时，已由清扫器终止。',
        },
      });
    }
  }
  return swept;
}
