// tasks / uploads 两表 SQL + TaskView 组装。本模块所有落库语句收在这里；
// 常规任务状态轴变更走 service.transition；过期上传是跨 tasks/uploads 的一致性例外，
// 由本文件的加锁 CTE 原子落 upload=expired + task=failed，避免两表间 TOCTOU。
import type { ErrorBody, TaskStatus, TaskStep, TaskView, UploadStatus } from '@cb/shared';
import { toIso, type Queryable } from '../../platform/infra/db.js';
import type { Tx } from '../../platform/infra/db-tx.js';

/** uploads.parts 登记表形态：声明总数 + 已落地分片（index → MinIO 对象键）。 */
export interface PartsManifest {
  protocolVersion?: 2;
  bundleId?: string;
  total?: number | null;
  landed?: Record<string, string>;
}

/** 从 parts 登记表算已落地数 / 是否收齐（0..total-1 连续全到齐才算齐）。 */
export function partsState(parts: PartsManifest | null | undefined): {
  total: number | null;
  landed: number;
  complete: boolean;
  orderedKeys: string[];
} {
  const landedMap = parts?.landed ?? {};
  const indices = Object.keys(landedMap)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);
  const total = typeof parts?.total === 'number' && parts.total > 0 ? parts.total : null;
  const complete = total !== null && indices.length === total && indices.every((n, i) => n === i);
  return {
    total,
    landed: indices.length,
    complete,
    orderedKeys: indices.map((i) => landedMap[String(i)]!),
  };
}

// ---------------------------------------------------------------------------
// 建任务（tasks + uploads 同事务两行；幂等键冲突由 service.createTask 处理）
// ---------------------------------------------------------------------------

export interface InsertTaskInput {
  ownerUserId: string;
  description?: string;
  idempotencyKey: string;
}

/** 插 tasks 行（幂等键冲突 → null，调用方回读已存在任务）。 */
export async function insertTask(tx: Tx, input: InsertTaskInput): Promise<string | null> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO tasks (owner_user_id, description, idempotency_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [input.ownerUserId, input.description ?? null, input.idempotencyKey],
  );
  return res.rows[0]?.id ?? null;
}

/** 插 uploads 行（与 task 一对一；库里只存配对码哈希，明文只随建任务响应返一次）。 */
export async function insertUpload(
  tx: Tx,
  input: { taskId: string; pairingCodeHash: string; pairingExpiresAt: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO uploads (task_id, pairing_code_hash, pairing_expires_at)
     VALUES ($1, $2, $3)`,
    [input.taskId, input.pairingCodeHash, input.pairingExpiresAt],
  );
}

/** 按幂等键回读已存在任务（双击/网络重试命中 ON CONFLICT 后走这里）。 */
export async function findTaskByIdempotencyKey(
  db: Queryable,
  idempotencyKey: string,
): Promise<{ id: string; ownerUserId: string } | null> {
  const res = await db.query<{ id: string; owner_user_id: string }>(
    `SELECT id, owner_user_id FROM tasks WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = res.rows[0];
  return row ? { id: row.id, ownerUserId: row.owner_user_id } : null;
}

/**
 * 幂等回放时轮换配对码（明文码无法从哈希还原，重放必须发新码才能凑齐响应契约）。
 * 仅未收齐的 pending 上传可轮换；已推进的上传不动（回放方拿旧 TaskView 即可）。
 */
export async function rotatePairingCode(
  db: Queryable,
  input: { taskId: string; pairingCodeHash: string; pairingExpiresAt: string },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE uploads
        SET pairing_code_hash = $2, pairing_expires_at = $3, updated_at = now()
      WHERE task_id = $1 AND status = 'pending'`,
    [input.taskId, input.pairingCodeHash, input.pairingExpiresAt],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// TaskView 读（联 uploads + capabilities 计数）
// ---------------------------------------------------------------------------

interface TaskViewRow {
  id: string;
  current_step: string;
  status: string;
  description: string | null;
  retry_count: number;
  last_error: unknown;
  created_at: string | Date;
  updated_at: string | Date;
  upload_status: string;
  parts: PartsManifest | null;
  pairing_expires_at: string | Date;
  capability_count: number | string;
}

const TASK_VIEW_SELECT = `
  SELECT t.id, t.current_step, t.status, t.description, t.retry_count, t.last_error,
         t.created_at, t.updated_at,
         u.status AS upload_status, u.parts, u.pairing_expires_at,
         (SELECT count(*) FROM capabilities c WHERE c.task_id = t.id) AS capability_count
    FROM tasks t
    JOIN uploads u ON u.task_id = t.id`;

function toTaskView(row: TaskViewRow): TaskView {
  const { total, landed } = partsState(row.parts);
  const lastError = row.last_error as ErrorBody | null;
  return {
    id: row.id,
    currentStep: row.current_step as TaskStep,
    status: row.status as TaskStatus,
    ...(row.description ? { description: row.description } : {}),
    retryCount: row.retry_count,
    ...(lastError ? { lastError } : {}),
    upload: {
      status: row.upload_status as UploadStatus,
      partsExpected: total,
      partsLanded: landed,
      pairingExpiresAt: toIso(row.pairing_expires_at),
    },
    capabilityCount: Number(row.capability_count),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** 读单任务视图（owner 限定；非本人/不存在 → null，不暴露存在性）。 */
export async function readTaskView(
  db: Queryable,
  taskId: string,
  ownerUserId: string,
): Promise<TaskView | null> {
  const res = await db.query<TaskViewRow>(
    `${TASK_VIEW_SELECT}
   WHERE t.id = $1 AND t.owner_user_id = $2`,
    [taskId, ownerUserId],
  );
  const row = res.rows[0];
  return row ? toTaskView(row) : null;
}

/**
 * 任务列表（owner 限定，新→旧）。cursor = 上一页末位任务 id（UUID v7 时间有序，id 序即时间序）；
 * 取 limit+1 判 hasMore。
 */
export async function listTaskViews(
  db: Queryable,
  input: { ownerUserId: string; limit: number; cursorId?: string },
): Promise<{ items: TaskView[]; hasMore: boolean }> {
  const res = await db.query<TaskViewRow>(
    `${TASK_VIEW_SELECT}
   WHERE t.owner_user_id = $1 AND ($2::uuid IS NULL OR t.id < $2)
   ORDER BY t.id DESC
   LIMIT $3`,
    [input.ownerUserId, input.cursorId ?? null, input.limit + 1],
  );
  const hasMore = res.rows.length > input.limit;
  return { items: res.rows.slice(0, input.limit).map(toTaskView), hasMore };
}

/**
 * Shell 恢复入口的有界任务集。
 *
 * 优先返回仍在运行，或失败后仍有明确用户动作（重试 / 修改输入 / 升级处理）的任务；
 * 若没有任何可恢复任务，才回退到最近一条终态，供异步离开的用户回来验收结果。
 * 这里不复用通用分页列表，避免 Shell 为找一个旧任务逐页扫描完整历史。
 */
export async function listCreationResumeTaskViews(
  db: Queryable,
  input: { ownerUserId: string; limit: number },
): Promise<TaskView[]> {
  const actionable = await db.query<TaskViewRow>(
    `${TASK_VIEW_SELECT}
   WHERE t.owner_user_id = $1
     AND (
       t.status = 'running'
       OR (
         t.status = 'failed'
         AND (
           t.last_error->>'action' = ANY($2::text[])
           OR (t.current_step = 'upload' AND u.status = 'expired')
         )
       )
     )
   ORDER BY t.updated_at DESC, t.id DESC
   LIMIT $3`,
    [input.ownerUserId, ['retry', 'change_input', 'escalate'], input.limit],
  );
  if (actionable.rows.length > 0) return actionable.rows.map(toTaskView);

  const fallback = await db.query<TaskViewRow>(
    `${TASK_VIEW_SELECT}
   WHERE t.owner_user_id = $1
   ORDER BY t.updated_at DESC, t.id DESC
   LIMIT 1`,
    [input.ownerUserId],
  );
  return fallback.rows.map(toTaskView);
}

/**
 * parts 清单是否已经完整的 SQL 判定。
 *
 * 与 partsState 保持同一语义：total 为正整数、landed 键数恰等于 total，且 0..total-1
 * 连续存在。用 CASE 保护 int cast，旧脏数据只会被视为“不完整”，不会让整轮对账报错。
 */
const COMPLETE_PARTS_SQL = `
  CASE
    WHEN jsonb_typeof(u.parts->'total') = 'number'
      AND COALESCE(u.parts->>'total', '') ~ '^[1-9][0-9]*$'
      AND COALESCE(jsonb_typeof(u.parts->'landed'), 'object') = 'object' THEN
      (SELECT count(*) FROM jsonb_object_keys(COALESCE(u.parts->'landed', '{}'::jsonb)))
        = (u.parts->>'total')::int
      AND NOT EXISTS (
        SELECT 1
          FROM generate_series(0, (u.parts->>'total')::int - 1) AS expected(idx)
         WHERE NOT (COALESCE(u.parts->'landed', '{}'::jsonb) ? expected.idx::text)
      )
    ELSE false
  END`;

/**
 * 原子收口配对窗口已结束且清单未收齐的 upload/running 任务。
 *
 * 单条 PostgreSQL 语句先 FOR UPDATE 同时锁住 tasks/uploads 候选，再把 upload 置 expired、
 * task 置 failed。这样 registerPart、收齐流转和配对码延期都会在锁后重新判断条件，不会出现
 * “SELECT 时过期、UPDATE 前已 raw/已延期”却仍覆盖成功上传的 TOCTOU 竞态。完整清单即使仍是
 * pending 也明确排除，给 landPart 的 mark raw/transition 窗口留出恢复空间。
 */
export async function expireIncompleteUploadTasks(
  db: Queryable,
  input: {
    lastError: ErrorBody;
    ownerUserId?: string;
    taskId?: string;
    limit?: number;
  },
): Promise<string[]> {
  const res = await db.query<{ id: string }>(
    `WITH candidates AS MATERIALIZED (
       SELECT t.id
         FROM tasks t
         JOIN uploads u ON u.task_id = t.id
        WHERE t.status = 'running'
          AND t.current_step = 'upload'
          AND u.status = 'pending'
          AND u.pairing_expires_at <= now()
          AND NOT (${COMPLETE_PARTS_SQL})
          AND ($1::uuid IS NULL OR t.owner_user_id = $1)
          AND ($2::uuid IS NULL OR t.id = $2)
        ORDER BY u.pairing_expires_at ASC
        LIMIT $3
        FOR UPDATE OF t, u SKIP LOCKED
     ), expired_uploads AS (
       UPDATE uploads u
          SET status = 'expired', updated_at = now()
         FROM candidates c
        WHERE u.task_id = c.id
          AND u.status = 'pending'
          AND u.pairing_expires_at <= now()
       RETURNING u.task_id
     )
     UPDATE tasks t
        SET status = 'failed',
            last_error = $4::jsonb,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
       FROM expired_uploads e
      WHERE t.id = e.task_id
        AND t.status = 'running'
        AND t.current_step = 'upload'
     RETURNING t.id`,
    [
      input.ownerUserId ?? null,
      input.taskId ?? null,
      input.limit ?? 100,
      JSON.stringify(input.lastError),
    ],
  );
  return res.rows.map((row) => row.id);
}

export interface ExpiredUploadPurgeCandidate {
  taskId: string;
  objectKeys: string[];
  cleanupVersion: number;
}

function expiredOrphanKeys(meta: Record<string, unknown> | null): string[] {
  const value = meta?.expired_orphan_keys;
  return Array.isArray(value)
    ? value.filter((key): key is string => typeof key === 'string' && key.length > 0)
    : [];
}

function staleObjectKeys(meta: Record<string, unknown> | null): string[] {
  const value = meta?.stale_object_keys;
  return Array.isArray(value)
    ? value.filter((key): key is string => typeof key === 'string' && key.length > 0)
    : [];
}

/** 仍需清理原始对象的 expired 上传；raw_purged_at 为空就是可重试追踪真源。 */
export async function listExpiredUploadPurgeCandidates(
  db: Queryable,
  limit = 100,
): Promise<ExpiredUploadPurgeCandidate[]> {
  const res = await db.query<{
    task_id: string;
    storage_key: string | null;
    parts: PartsManifest | null;
    meta: Record<string, unknown> | null;
    cleanup_version: number | string;
  }>(
    `SELECT task_id, storage_key, parts, meta,
            CASE
              WHEN COALESCE(meta->>'expired_cleanup_version', '') ~ '^[0-9]+$'
                THEN (meta->>'expired_cleanup_version')::bigint
              ELSE 0
            END AS cleanup_version
       FROM uploads
      WHERE status = 'expired' AND raw_purged_at IS NULL
      ORDER BY updated_at ASC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((row) => ({
    taskId: row.task_id,
    objectKeys: [
      ...(row.storage_key ? [row.storage_key] : []),
      ...partsState(row.parts).orderedKeys,
      ...expiredOrphanKeys(row.meta),
      ...staleObjectKeys(row.meta),
    ],
    cleanupVersion: Number(row.cleanup_version),
  }));
}

export interface StaleUploadPurgeCandidate {
  taskId: string;
  objectKeys: string[];
  cleanupVersion: number;
}

/** 任意状态下由快照替换/登记竞态产生的旧对象；版本号保证清理期间新增 key 不会丢。 */
export async function listStaleUploadPurgeCandidates(
  db: Queryable,
  limit = 100,
): Promise<StaleUploadPurgeCandidate[]> {
  const res = await db.query<{
    task_id: string;
    meta: Record<string, unknown> | null;
    cleanup_version: number | string;
  }>(
    `SELECT task_id, meta,
            CASE
              WHEN COALESCE(meta->>'stale_cleanup_version', '') ~ '^[0-9]+$'
                THEN (meta->>'stale_cleanup_version')::bigint
              ELSE 0
            END AS cleanup_version
       FROM uploads
      WHERE jsonb_typeof(meta->'stale_object_keys') = 'array'
        AND jsonb_array_length(meta->'stale_object_keys') > 0
      ORDER BY updated_at ASC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((row) => ({
    taskId: row.task_id,
    objectKeys: staleObjectKeys(row.meta),
    cleanupVersion: Number(row.cleanup_version),
  }));
}

export async function clearStaleUploadObjects(
  db: Queryable,
  taskId: string,
  expectedCleanupVersion: number,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE uploads
        SET meta = jsonb_set(meta, '{stale_object_keys}', '[]'::jsonb, true),
            updated_at = now()
      WHERE task_id = $1
        AND CASE
              WHEN COALESCE(meta->>'stale_cleanup_version', '') ~ '^[0-9]+$'
                THEN (meta->>'stale_cleanup_version')::bigint
              ELSE 0
            END = $2`,
    [taskId, expectedCleanupVersion],
  );
  return (res.rowCount ?? 0) > 0;
}

/** 全部对象真删成功后才打清理戳；expired 状态保留，便于失败任务诊断。 */
export async function markExpiredUploadPurged(
  db: Queryable,
  taskId: string,
  expectedCleanupVersion: number,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE uploads
        SET raw_purged_at = now(), updated_at = now()
      WHERE task_id = $1
        AND status = 'expired'
        AND raw_purged_at IS NULL
        AND CASE
              WHEN COALESCE(meta->>'expired_cleanup_version', '') ~ '^[0-9]+$'
                THEN (meta->>'expired_cleanup_version')::bigint
              ELSE 0
            END = $2`,
    [taskId, expectedCleanupVersion],
  );
  return (res.rowCount ?? 0) > 0;
}

/** 读任务 owner + 状态轴（SSE 建流 owner 校验 / retry 前置检查用）。 */
export async function readTaskCore(
  db: Queryable,
  taskId: string,
): Promise<{
  id: string;
  ownerUserId: string;
  currentStep: TaskStep;
  status: TaskStatus;
  lastError: ErrorBody | null;
  meta: Record<string, unknown>;
} | null> {
  const res = await db.query<{
    id: string;
    owner_user_id: string;
    current_step: string;
    status: string;
    last_error: unknown;
    meta: Record<string, unknown> | null;
  }>(`SELECT id, owner_user_id, current_step, status, last_error, meta FROM tasks WHERE id = $1`, [
    taskId,
  ]);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    currentStep: row.current_step as TaskStep,
    status: row.status as TaskStatus,
    lastError: (row.last_error as ErrorBody | null) ?? null,
    meta: row.meta ?? {},
  };
}

// ---------------------------------------------------------------------------
// 配对上传（uploads 登记；配对码验证）
// ---------------------------------------------------------------------------

/** 按配对码哈希找上传行（助手侧无登录态的鉴权真源）。 */
export async function findUploadByCodeHash(
  db: Queryable,
  codeHash: string,
): Promise<{
  taskId: string;
  ownerUserId: string;
  uploadStatus: UploadStatus;
  expired: boolean;
  taskStep: TaskStep;
  taskStatus: TaskStatus;
  parts: PartsManifest;
} | null> {
  const res = await db.query<{
    task_id: string;
    owner_user_id: string;
    upload_status: string;
    expired: boolean;
    current_step: string;
    status: string;
    parts: PartsManifest | null;
  }>(
    `SELECT u.task_id, t.owner_user_id, u.status AS upload_status,
            (u.pairing_expires_at <= now()) AS expired,
            t.current_step, t.status, u.parts
       FROM uploads u
       JOIN tasks t ON t.id = u.task_id
      WHERE u.pairing_code_hash = $1`,
    [codeHash],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    taskId: row.task_id,
    ownerUserId: row.owner_user_id,
    uploadStatus: row.upload_status as UploadStatus,
    expired: row.expired,
    taskStep: row.current_step as TaskStep,
    taskStatus: row.status as TaskStatus,
    parts: row.parts ?? {},
  };
}

/** 建立或替换 v2 上传清单；替换时把旧对象键持久登记为待清理对象。 */
export async function replaceUploadManifest(
  db: Queryable,
  input: { taskId: string; bundleId: string; totalParts: number },
): Promise<PartsManifest | null> {
  const res = await db.query<{ parts: PartsManifest }>(
    `UPDATE uploads
        SET meta = jsonb_set(
              jsonb_set(
                meta,
                '{stale_object_keys}',
                COALESCE(meta->'stale_object_keys', '[]'::jsonb)
                  || COALESCE(
                       (SELECT jsonb_agg(value)
                          FROM jsonb_each_text(COALESCE(parts->'landed', '{}'::jsonb))),
                       '[]'::jsonb
                     ),
                true
              ),
              '{stale_cleanup_version}',
              to_jsonb(
                CASE
                  WHEN COALESCE(meta->>'stale_cleanup_version', '') ~ '^[0-9]+$'
                    THEN (meta->>'stale_cleanup_version')::bigint + 1
                  ELSE 1
                END
              ),
              true
            ),
            parts = jsonb_build_object(
              'protocolVersion', 2,
              'bundleId', $2::text,
              'total', $3::int,
              'landed', '{}'::jsonb
            ),
            updated_at = now()
      WHERE task_id = $1 AND status = 'pending' AND pairing_expires_at > now()
      RETURNING parts`,
    [input.taskId, input.bundleId, input.totalParts],
  );
  return res.rows[0]?.parts ?? null;
}

/**
 * 登记一片已落地分片进 parts（重复分片幂等覆盖同一 index）。
 * 受保护更新：仅 pending 且配对未过期的上传可登记；total 以首次声明为准（后续声明不覆盖）。
 * 返回登记后的 parts；0 行（已推进/已过期）→ null。
 */
export async function registerPart(
  db: Queryable,
  input: {
    taskId: string;
    partIndex: number;
    objectKey: string;
    totalParts: number;
    bundleId?: string;
  },
): Promise<PartsManifest | null> {
  const res = await db.query<{ parts: PartsManifest }>(
    `UPDATE uploads
        SET parts = parts || jsonb_build_object(
              'total', COALESCE(parts->'total', to_jsonb($4::int)),
              'landed', COALESCE(parts->'landed', '{}'::jsonb)
                        || jsonb_build_object($2::text, $3::text)
            ),
            updated_at = now()
      WHERE task_id = $1 AND status = 'pending' AND pairing_expires_at > now()
        AND (
          (
            $5::text IS NULL
            AND NOT (parts ? 'bundleId')
            AND (NOT (parts ? 'total') OR (parts->'total')::int = $4::int)
          )
          OR (
            parts->>'bundleId' = $5::text
            AND (parts->'total')::int = $4::int
          )
        )
      RETURNING parts`,
    [
      input.taskId,
      String(input.partIndex),
      input.objectKey,
      input.totalParts,
      input.bundleId ?? null,
    ],
  );
  return res.rows[0]?.parts ?? null;
}

/** 任何写桶后未登记的对象都进入持久清理清单，避免并发替换留下原文。 */
export async function trackStaleUploadObject(
  db: Queryable,
  input: { taskId: string; objectKey: string },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE uploads
        SET meta = jsonb_set(
              jsonb_set(
                meta,
                '{stale_object_keys}',
                CASE
                  WHEN COALESCE(meta->'stale_object_keys', '[]'::jsonb)
                         @> jsonb_build_array($2::text)
                    THEN COALESCE(meta->'stale_object_keys', '[]'::jsonb)
                  ELSE COALESCE(meta->'stale_object_keys', '[]'::jsonb)
                         || jsonb_build_array($2::text)
                END,
                true
              ),
              '{stale_cleanup_version}',
              to_jsonb(
                CASE
                  WHEN COALESCE(meta->>'stale_cleanup_version', '') ~ '^[0-9]+$'
                    THEN (meta->>'stale_cleanup_version')::bigint + 1
                  ELSE 1
                END
              ),
              true
            ),
            updated_at = now()
      WHERE task_id = $1`,
    [input.taskId, input.objectKey],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * putObject 已成功但 registerPart 因到期/expired 失败时，把当前 key 持久登记进可重试清理清单。
 * 每次追加都递增 cleanup version 并清 raw_purged_at：worker 若正拿旧清单清理，其打戳会因
 * version 不匹配而失败，下一轮必须重读并删除新 key。pending+已过期先只登记，随后原子对账
 * 会把它置 expired；旧版已 task.failed/upload.pending 的行在这里顺带归一为 expired。
 */
export async function trackExpiredUploadOrphanKey(
  db: Queryable,
  input: { taskId: string; objectKey: string },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE uploads u
        SET meta = jsonb_set(
              jsonb_set(
                u.meta,
                '{expired_orphan_keys}',
                CASE
                  WHEN (
                    CASE
                      WHEN jsonb_typeof(u.meta->'expired_orphan_keys') = 'array'
                        THEN u.meta->'expired_orphan_keys'
                      ELSE '[]'::jsonb
                    END
                  ) @> jsonb_build_array($2::text)
                    THEN CASE
                      WHEN jsonb_typeof(u.meta->'expired_orphan_keys') = 'array'
                        THEN u.meta->'expired_orphan_keys'
                      ELSE '[]'::jsonb
                    END
                  ELSE (
                    CASE
                      WHEN jsonb_typeof(u.meta->'expired_orphan_keys') = 'array'
                        THEN u.meta->'expired_orphan_keys'
                      ELSE '[]'::jsonb
                    END
                  ) || jsonb_build_array($2::text)
                END,
                true
              ),
              '{expired_cleanup_version}',
              to_jsonb(
                CASE
                  WHEN COALESCE(u.meta->>'expired_cleanup_version', '') ~ '^[0-9]+$'
                    THEN (u.meta->>'expired_cleanup_version')::bigint + 1
                  ELSE 1
                END
              ),
              true
            ),
            status = CASE
              WHEN t.status = 'failed' AND t.current_step = 'upload' AND u.status = 'pending'
                THEN 'expired'
              ELSE u.status
            END,
            raw_purged_at = NULL,
            updated_at = now()
       FROM tasks t
      WHERE u.task_id = $1
        AND t.id = u.task_id
        AND (
          u.status = 'expired'
          OR (
            u.status = 'pending'
            AND u.pairing_expires_at <= now()
            AND t.current_step = 'upload'
            AND t.status IN ('running', 'failed')
          )
        )`,
    [input.taskId, input.objectKey],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 分片收齐：置 status='raw'（仅 pending 可置，并发收齐只有一个赢家）。
 * 不写 storage_key：收齐后不再拼接完整原始件，worker 直接按 parts 登记表逐片消费；
 * storage_key 列保留只为兼容历史行（清理时若非空仍会删它指向的对象）。
 */
export async function markUploadRaw(db: Queryable, taskId: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE uploads
        SET status = 'raw', updated_at = now()
      WHERE task_id = $1 AND status = 'pending'`,
    [taskId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// 流水线侧（worker）
// ---------------------------------------------------------------------------

/** 读上传明细（worker 拉原文 / 清理分片用）。 */
export async function readUploadForPipeline(
  db: Queryable,
  taskId: string,
): Promise<{
  storageKey: string | null;
  status: UploadStatus;
  parts: PartsManifest | null;
} | null> {
  const res = await db.query<{
    storage_key: string | null;
    status: string;
    parts: PartsManifest | null;
  }>(`SELECT storage_key, status, parts FROM uploads WHERE task_id = $1`, [taskId]);
  const row = res.rows[0];
  if (!row) return null;
  return { storageKey: row.storage_key, status: row.status as UploadStatus, parts: row.parts };
}

/**
 * 上传处理完成：置 processed；raw_purged_at 只在原始件真正删除成功时打戳
 * （合规留档字段不允许说谎——清理失败时留空，由下轮补清逻辑或人工处理）。
 */
export async function markUploadProcessed(
  db: Queryable,
  taskId: string,
  purged: boolean,
): Promise<void> {
  await db.query(
    `UPDATE uploads
        SET status = 'processed',
            raw_purged_at = CASE WHEN $2 THEN now() ELSE raw_purged_at END,
            updated_at = now()
      WHERE task_id = $1`,
    [taskId, purged],
  );
}

/** 上传元信息合并写（解析统计 / 去敏报告等）。 */
export async function mergeUploadMeta(
  db: Queryable,
  taskId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `UPDATE uploads SET meta = meta || $2::jsonb, updated_at = now() WHERE task_id = $1`,
    [taskId, JSON.stringify(patch)],
  );
}

/** worker 领取租约有效期。 */
export const TASK_LEASE_MS = 10 * 60 * 1000;

/**
 * 认领任务（防双跑）：仅 running+extract 且无有效租约的任务可被认领。
 * 0 行 = 已被别的 worker 认领（有效租约仍在）或任务已不在可跑态 → 调用方直接跳过。
 */
export async function claimTask(
  db: Queryable,
  input: { taskId: string; leaseOwner: string; leaseMs?: number },
): Promise<{ ownerUserId: string; retryCount: number; meta: Record<string, unknown> } | null> {
  const res = await db.query<{
    owner_user_id: string;
    retry_count: number;
    meta: Record<string, unknown> | null;
  }>(
    `UPDATE tasks
        SET lease_owner = $2,
            lease_expires_at = now() + ($3 || ' milliseconds')::interval,
            updated_at = now()
      WHERE id = $1
        AND status = 'running' AND current_step = 'extract'
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      RETURNING owner_user_id, retry_count, meta`,
    [input.taskId, input.leaseOwner, String(input.leaseMs ?? TASK_LEASE_MS)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { ownerUserId: row.owner_user_id, retryCount: row.retry_count, meta: row.meta ?? {} };
}

/** 续租（长流水线在安全点续期，防被对账循环误判过期接管）。 */
export async function renewLease(
  db: Queryable,
  input: { taskId: string; leaseOwner: string; leaseMs?: number },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE tasks
        SET lease_expires_at = now() + ($3 || ' milliseconds')::interval, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [input.taskId, input.leaseOwner, String(input.leaseMs ?? TASK_LEASE_MS)],
  );
  return (res.rowCount ?? 0) > 0;
}

/** 持久化进度快照（SSE state_snapshot 真源；仅 running 期写，终态后不再动）。 */
export async function saveTaskProgress(
  db: Queryable,
  taskId: string,
  progress: unknown,
): Promise<void> {
  await db.query(
    `UPDATE tasks
        SET meta = jsonb_set(meta, '{progress}', $2::jsonb, true), updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [taskId, JSON.stringify(progress)],
  );
}

/**
 * 租约对账（worker 每 60s 跑一轮）：找出 running+extract 且租约已过期的任务重新入队。
 * lease 为空但长时间无更新的任务也算（覆盖「transition 成功但 enqueue 丢失」的缝隙）。
 */
export async function findStalledExtractTasks(db: Queryable): Promise<string[]> {
  const res = await db.query<{ id: string }>(
    `SELECT id
       FROM tasks
      WHERE status = 'running' AND current_step = 'extract'
        AND (
          (lease_expires_at IS NOT NULL AND lease_expires_at < now())
          OR (lease_expires_at IS NULL AND updated_at < now() - interval '2 minutes')
        )`,
  );
  return res.rows.map((r) => r.id);
}
