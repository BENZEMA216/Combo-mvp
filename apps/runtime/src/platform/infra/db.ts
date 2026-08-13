// PostgreSQL 连接池（pg）+ 最小事务抽象。
//   惰性建池（无 Docker 也能跑 tsc/单测）；池层错误吞掉，错误在调用点处理。
//   Queryable/TxPool 是 pg 的最小子集：单测注入忠实假 PG，不依赖真库。
import { Pool, type PoolClient } from 'pg';
import type { Env } from '../config/env.js';

/** 仅依赖 query 的最小 DB 句柄（pg 子集），事务内/池层通用。 */
export interface QueryResultLike<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}
export interface Queryable {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    signal?: AbortSignal,
  ): Promise<QueryResultLike<R>>;
}

/** 单连接（pg.PoolClient 子集）：可 query + release。 */
export interface TxConn extends Queryable {
  /** destroy=true 时销毁可能仍有未决查询的连接，不把它放回池中。 */
  release(destroy?: boolean): void;
}

/** 能领出单连接做事务的池。 */
export interface TxPool {
  connect(): Promise<TxConn>;
}

/** runtime 各 repo 统一依赖的 DB 句柄：可直查 + 可开事务。 */
export type RuntimeDb = Queryable & TxPool;

let pool: Pool | undefined;
let creatorAgentPool: Pool | undefined;

function createPool(connectionString: string): Pool {
  const created = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });
  created.on('error', () => {
    /* swallow idle-client errors; handled at query call sites */
  });
  return created;
}

/** PG 连接池单例。 */
export function getPool(env: Env): Pool {
  if (!pool) pool = createPool(env.DATABASE_URL);
  return pool;
}

/** Creator-hosted Consumer transaction pool; always uses its future dedicated role URL. */
export function getCreatorAgentPool(env: Env): Pool {
  if (!env.CREATOR_AGENT_PUBLIC_ENABLED || !env.CREATOR_AGENT_DATABASE_URL) {
    throw new Error('Creator Agent database is disabled');
  }
  if (!creatorAgentPool) creatorAgentPool = createPool(env.CREATOR_AGENT_DATABASE_URL);
  return creatorAgentPool;
}

/** 把 pg.Pool 适配成 RuntimeDb（生产用）；测试直接注入 FakeDb。 */
function pgQuery<R>(
  target: Pool | PoolClient,
  sql: string,
  params?: unknown[],
  signal?: AbortSignal,
): Promise<QueryResultLike<R>> {
  if (signal?.aborted) return Promise.reject(operationAborted());
  const pending = target.query(sql, params) as unknown as Promise<QueryResultLike<R>>;
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(operationAborted()));
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function toRuntimeDb(p: Pool): RuntimeDb {
  return {
    query: <R>(sql: string, params?: unknown[], signal?: AbortSignal) =>
      pgQuery<R>(p, sql, params, signal),
    async connect(): Promise<TxConn> {
      const client: PoolClient = await p.connect();
      return {
        query: <R>(sql: string, params?: unknown[], signal?: AbortSignal) =>
          pgQuery<R>(client, sql, params, signal),
        release: (destroy = false) => client.release(destroy),
      };
    },
  };
}

export interface TransactionOptions {
  /** 取消连接等待和事务内的每条 PostgreSQL 查询。 */
  signal?: AbortSignal;
  /** 同时设置事务内的 lock_timeout 与 statement_timeout。 */
  timeoutMs?: number;
  /** 为跨表详情读取建立同一 REPEATABLE READ、READ ONLY 快照。 */
  readOnlySnapshot?: boolean;
}

function operationAborted(): Error {
  return new DOMException('database operation aborted', 'AbortError');
}

async function connectWithSignal(db: TxPool, signal?: AbortSignal): Promise<TxConn> {
  if (!signal) return db.connect();
  if (signal.aborted) throw operationAborted();
  const pending = db.connect();
  return new Promise<TxConn>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(operationAborted()));
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (connection) => {
        if (settled) {
          connection.release(true);
          return;
        }
        finish(() => resolve(connection));
      },
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * 在单连接事务内执行 fn。可选信号会传给连接等待和全部查询；超时配置由 PostgreSQL
 * 自己执行，因此关闭流程不会只在应用层放弃一个仍持锁的事务。
 */
export async function withTransaction<T>(
  db: TxPool,
  fn: (tx: Queryable) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error('transaction timeout must be a positive integer');
  }
  const conn = await connectWithSignal(db, options.signal);
  let released = false;
  const release = (destroy = false): void => {
    if (released) return;
    released = true;
    conn.release(destroy);
  };
  const transaction: Queryable = {
    async query<R>(sql: string, params?: unknown[]): Promise<QueryResultLike<R>> {
      if (options.signal?.aborted) throw operationAborted();
      const result = await conn.query<R>(sql, params, options.signal);
      // node-postgres does not cancel every transport phase. This post-query fence
      // prevents a query that returns after the deadline from advancing to a write
      // or COMMIT; server-side statement_timeout bounds queries already submitted.
      if (options.signal?.aborted) throw operationAborted();
      return result;
    },
  };
  try {
    await transaction.query(
      options.readOnlySnapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
    );
    if (options.timeoutMs !== undefined) {
      const value = `${options.timeoutMs}ms`;
      await transaction.query(
        `SELECT set_config('lock_timeout', $1, true),
                set_config('statement_timeout', $1, true)`,
        [value],
      );
    }
    try {
      const result = await fn(transaction);
      await transaction.query('COMMIT');
      return result;
    } catch (err) {
      if (options.signal?.aborted) {
        // The aborted query may still be unwinding in libpq. Destroy the connection
        // instead of issuing an unbounded ROLLBACK or returning it to the pool.
        release(true);
      } else {
        const rollbackSignal = AbortSignal.timeout(Math.min(options.timeoutMs ?? 2_000, 2_000));
        await conn.query('ROLLBACK', undefined, rollbackSignal).catch(() => release(true));
      }
      throw err;
    }
  } finally {
    release(options.signal?.aborted === true);
  }
}

/** ready 探针：SELECT 1（连不上/超时 → down）。 */
export async function pingDb(env: Env): Promise<boolean> {
  try {
    const client = await getPool(env).connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}

/** Readiness proves the URL did not accidentally use any known broad legacy/control-plane role. */
export async function pingCreatorAgentDb(env: Env): Promise<boolean> {
  if (!env.CREATOR_AGENT_PUBLIC_ENABLED) return true;
  try {
    const client = await getCreatorAgentPool(env).connect();
    try {
      const result = await client.query<{ current_user: string }>('SELECT current_user');
      const role = result.rows[0]?.current_user;
      return (
        typeof role === 'string' &&
        !['combo_api', 'combo_worker', 'combo_runtime', 'combo_agent_api'].includes(role)
      );
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}

/** 优雅关闭连接池。 */
export async function closeDb(): Promise<void> {
  await Promise.all([
    pool?.end().catch(() => undefined),
    creatorAgentPool?.end().catch(() => undefined),
  ]);
  pool = undefined;
  creatorAgentPool = undefined;
}
