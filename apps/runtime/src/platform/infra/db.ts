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

interface CreatorAgentReadinessRow {
  current_user_name: string;
  session_user_name: string;
  can_login: boolean;
  superuser: boolean;
  bypass_rls: boolean;
  create_database: boolean;
  create_role: boolean;
  inherit_privileges: boolean;
  replicate: boolean;
  database_connect: boolean;
  database_create: boolean;
  database_temporary: boolean;
  exact_capabilities: boolean;
}

export function isExactCreatorAgentConsumerAuthority(
  row: CreatorAgentReadinessRow | undefined,
): boolean {
  return (
    row?.current_user_name === 'combo_agent_consumer_api' &&
    row.session_user_name === 'combo_agent_consumer_api' &&
    row.current_user_name === row.session_user_name &&
    row.can_login === true &&
    row.superuser === false &&
    row.bypass_rls === false &&
    row.create_database === false &&
    row.create_role === false &&
    row.inherit_privileges === false &&
    row.replicate === false &&
    row.database_connect === true &&
    row.database_create === false &&
    row.database_temporary === true &&
    row.exact_capabilities === true
  );
}

/** Readiness proves the URL uses the exact Consumer-only identity and capability boundary. */
export async function pingCreatorAgentDb(env: Env): Promise<boolean> {
  if (!env.CREATOR_AGENT_PUBLIC_ENABLED) return true;
  try {
    const client = await getCreatorAgentPool(env).connect();
    try {
      const result = await client.query<CreatorAgentReadinessRow>(
        `WITH expected_select(table_name, column_name) AS (
           VALUES
             ('agent_access_grants', 'agent_id'),
             ('agent_access_grants', 'consumer_subject_id'),
             ('agent_access_grants', 'creator_id'),
             ('agent_access_grants', 'state'),
             ('agent_conversations', 'agent_id'),
             ('agent_conversations', 'agent_version_id'),
             ('agent_conversations', 'consumer_subject_id'),
             ('agent_conversations', 'created_at'),
             ('agent_conversations', 'creator_id'),
             ('agent_conversations', 'expires_at'),
             ('agent_conversations', 'id'),
             ('agent_conversations', 'idempotency_key'),
             ('agent_conversations', 'request_digest'),
             ('agent_conversations', 'state'),
             ('agent_conversations', 'version_digest'),
             ('agent_invocations', 'consumer_subject_id'),
             ('agent_invocations', 'conversation_id'),
             ('agent_invocations', 'created_at'),
             ('agent_invocations', 'creator_id'),
             ('agent_invocations', 'error_code'),
             ('agent_invocations', 'id'),
             ('agent_invocations', 'result_digest'),
             ('agent_invocations', 'retry_of_invocation_id'),
             ('agent_invocations', 'state'),
             ('agent_invocations', 'terminal_at'),
             ('agent_messages', 'content_aad_version'),
             ('agent_messages', 'content_algorithm'),
             ('agent_messages', 'content_auth_tag'),
             ('agent_messages', 'content_cipher_digest'),
             ('agent_messages', 'content_ciphertext'),
             ('agent_messages', 'content_digest'),
             ('agent_messages', 'content_key_id'),
             ('agent_messages', 'content_nonce'),
             ('agent_messages', 'consumer_subject_id'),
             ('agent_messages', 'conversation_id'),
             ('agent_messages', 'created_at'),
             ('agent_messages', 'creator_id'),
             ('agent_messages', 'id'),
             ('agent_messages', 'invocation_id'),
             ('agent_messages', 'role'),
             ('agent_messages', 'turn_no'),
             ('agent_version_controls', 'availability'),
             ('agent_version_controls', 'creator_id'),
             ('agent_version_controls', 'version_id'),
             ('agent_versions', 'agent_id'),
             ('agent_versions', 'creator_id'),
             ('agent_versions', 'id'),
             ('agent_versions', 'version_digest'),
             ('agents', 'creator_id'),
             ('agents', 'id'),
             ('agents', 'lifecycle'),
             ('agents', 'public_slug'),
             ('deployments', 'agent_id'),
             ('deployments', 'creator_id'),
             ('deployments', 'desired_state'),
             ('deployments', 'environment'),
             ('deployments', 'generation'),
             ('deployments', 'id'),
             ('deployments', 'lease_fence'),
             ('deployments', 'observed_generation'),
             ('deployments', 'observed_state'),
             ('deployments', 'observed_worker_id'),
             ('deployments', 'serving_version_id'),
             ('consumer_event_outbox', 'conversation_id'),
             ('consumer_event_outbox', 'cursor'),
             ('consumer_event_outbox', 'event_type'),
             ('consumer_event_outbox', 'invocation_id'),
             ('consumer_event_outbox', 'owner_id'),
             ('consumer_event_outbox', 'payload'),
             ('consumer_event_outbox', 'retained_until'),
             ('consumer_event_streams', 'conversation_id'),
             ('consumer_event_streams', 'expired_through_cursor'),
             ('consumer_event_streams', 'latest_cursor'),
             ('consumer_event_streams', 'owner_id'),
             ('consumer_event_streams', 'updated_at')
         ), actual_select AS (
           SELECT relation.relname::text AS table_name,
                  attribute.attname::text AS column_name
             FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             JOIN pg_attribute AS attribute
               ON attribute.attrelid = relation.oid
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
            WHERE namespace.nspname = 'public'
              AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND has_column_privilege(
                    current_user,
                    relation.oid,
                    attribute.attnum,
                    'SELECT'
                  )
         )
         SELECT current_user AS current_user_name,
                session_user AS session_user_name,
                role.rolcanlogin AS can_login,
                role.rolsuper AS superuser,
                role.rolbypassrls AS bypass_rls,
                role.rolcreatedb AS create_database,
                role.rolcreaterole AS create_role,
                role.rolinherit AS inherit_privileges,
                role.rolreplication AS replicate,
                has_database_privilege(
                  current_user,
                  current_database(),
                  'CONNECT'
                ) AS database_connect,
                has_database_privilege(
                  current_user,
                  current_database(),
                  'CREATE'
                ) AS database_create,
                has_database_privilege(
                  current_user,
                  current_database(),
                  'TEMPORARY'
                ) AS database_temporary,
                (
                  has_schema_privilege(current_user, 'public', 'USAGE')
                  AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
                  AND NOT EXISTS (
                    SELECT 1
                      FROM pg_namespace AS namespace
                     WHERE namespace.nspname NOT IN ('information_schema', 'pg_catalog', 'public')
                       AND (
                         has_schema_privilege(current_user, namespace.oid, 'USAGE')
                         OR has_schema_privilege(current_user, namespace.oid, 'CREATE')
                       )
                  )
                  AND NOT EXISTS (
                    SELECT 1
                      FROM pg_auth_members AS membership
                     WHERE membership.member = role.oid
                        OR membership.roleid = role.oid
                  )
                  AND NOT EXISTS (
                    SELECT expected.table_name, expected.column_name FROM expected_select AS expected
                    EXCEPT
                    SELECT actual.table_name, actual.column_name FROM actual_select AS actual
                  )
                  AND NOT EXISTS (
                    SELECT actual.table_name, actual.column_name FROM actual_select AS actual
                    EXCEPT
                    SELECT expected.table_name, expected.column_name FROM expected_select AS expected
                  )
                  AND NOT EXISTS (
                    SELECT 1
                      FROM pg_class AS relation
                      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
                     WHERE namespace.nspname = 'public'
                       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
                       AND (
                         has_table_privilege(current_user, relation.oid, 'SELECT')
                         OR has_table_privilege(current_user, relation.oid, 'INSERT')
                         OR has_table_privilege(current_user, relation.oid, 'UPDATE')
                         OR has_table_privilege(current_user, relation.oid, 'DELETE')
                         OR has_table_privilege(current_user, relation.oid, 'TRUNCATE')
                         OR has_table_privilege(current_user, relation.oid, 'REFERENCES')
                         OR has_table_privilege(current_user, relation.oid, 'TRIGGER')
                       )
                  )
                  AND NOT EXISTS (
                    SELECT 1
                      FROM pg_class AS sequence
                      JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
                     WHERE namespace.nspname = 'public'
                       AND sequence.relkind = 'S'
                       AND (
                         has_sequence_privilege(current_user, sequence.oid, 'USAGE')
                         OR has_sequence_privilege(current_user, sequence.oid, 'SELECT')
                         OR has_sequence_privilege(current_user, sequence.oid, 'UPDATE')
                       )
                  )
                  AND NOT EXISTS (
                    SELECT 1
                      FROM pg_class AS relation
                      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
                      JOIN pg_attribute AS attribute
                        ON attribute.attrelid = relation.oid
                       AND attribute.attnum > 0
                       AND NOT attribute.attisdropped
                     WHERE namespace.nspname = 'public'
                       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
                       AND (
                         has_column_privilege(
                           current_user,
                           relation.oid,
                           attribute.attnum,
                           'INSERT'
                         )
                         OR has_column_privilege(
                           current_user,
                           relation.oid,
                           attribute.attnum,
                           'UPDATE'
                         )
                         OR has_column_privilege(
                           current_user,
                           relation.oid,
                           attribute.attnum,
                           'REFERENCES'
                         )
                       )
                  )
                  AND has_function_privilege(
                    current_user,
                    'creator_agent_create_opening_conversation_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,bigint,integer,text,text,bigint,text)',
                    'EXECUTE'
                  )
                  AND has_function_privilege(
                    current_user,
                    'creator_agent_issue_runtime_product_ids_v2(integer)',
                    'EXECUTE'
                  )
                  AND has_function_privilege(
                    current_user,
                    'creator_agent_preflight_consumer_message_v2(uuid,uuid,text,text)',
                    'EXECUTE'
                  )
                  AND has_function_privilege(
                    current_user,
                    'creator_agent_finalize_consumer_message_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer,jsonb,text)',
                    'EXECUTE'
                  )
                  AND NOT has_function_privilege(
                    current_user,
                    'creator_agent_create_opening_conversation(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,bigint,integer)',
                    'EXECUTE'
                  )
                  AND NOT EXISTS (
                    SELECT 1
                      FROM pg_proc AS procedure
                      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
                     WHERE namespace.nspname NOT IN ('information_schema', 'pg_catalog')
                       AND procedure.prosecdef
                       AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')
                       AND procedure.oid NOT IN (
                         'public.creator_agent_create_opening_conversation_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,bigint,integer,text,text,bigint,text)'::regprocedure,
                         'public.creator_agent_issue_runtime_product_ids_v2(integer)'::regprocedure,
                         'public.creator_agent_preflight_consumer_message_v2(uuid,uuid,text,text)'::regprocedure,
                         'public.creator_agent_finalize_consumer_message_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer,jsonb,text)'::regprocedure
                       )
                  )
                ) AS exact_capabilities
           FROM pg_roles AS role
          WHERE role.rolname = current_user`,
      );
      return isExactCreatorAgentConsumerAuthority(result.rows[0]);
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
