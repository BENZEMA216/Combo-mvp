// 测试共用假件：忠实假 PG（按 repo/service 的真实 SQL 形态逐条模拟）+ 假对象存储 / 队列 / 事件流 / LLM。
// 「忠实」指：守卫条件（owner/状态/过期/乐观锁）与真实 SQL 语义一致，命中/未命中行数可断言。
import type {
  Bucket,
  LlmCallOptions,
  LlmGatewayPort,
  LlmResult,
  ObjectStorePort,
  QueuePort,
  SSEEventType,
} from '@cb/shared';
import type { QueryResultLike } from '../platform/infra/db.js';
import type { TxConn, TxPool } from '../platform/infra/db-tx.js';
import type { TaskEventBridge } from '../platform/sse/event-stream.js';
import { partsState, type PartsManifest } from '../modules/task/repo.js';

let seq = 0;
/** 递增的假 UUID（保持 id 可比较排序，模拟 UUID v7 时间有序）。 */
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

export interface TaskRowF {
  id: string;
  owner_user_id: string;
  current_step: string;
  status: string;
  description: string | null;
  meta: Record<string, unknown>;
  retry_count: number;
  last_error: unknown;
  lease_owner: string | null;
  lease_expires_at: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface UploadRowF {
  task_id: string;
  storage_key: string | null;
  status: string;
  pairing_code_hash: string;
  pairing_expires_at: string;
  parts: PartsManifest;
  raw_purged_at: string | null;
  meta: Record<string, unknown>;
}

export interface CapabilityRowF {
  id: string;
  task_id: string;
  owner_user_id: string;
  name: string;
  summary: string;
  kind: string;
  storage_key: string;
  published: boolean;
  published_at: string | null;
  share_token: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 忠实假 PG（tasks / uploads / capabilities 三表）。也可当 TxPool 用（BEGIN/COMMIT 透传）。 */
export class FakeDb implements TxPool {
  tasks = new Map<string, TaskRowF>();
  uploads = new Map<string, UploadRowF>();
  capabilities = new Map<string, CapabilityRowF>();
  /** 每条 UPDATE 影响行数历史（断言「单次写、命中/未命中」）。 */
  updateRowCounts: number[] = [];
  /** 事务轨迹（断言 BEGIN/COMMIT/ROLLBACK 收口）。 */
  txLog: string[] = [];

  async connect(): Promise<TxConn> {
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params),
      release: () => undefined,
    } as TxConn;
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
      this.txLog.push(s);
      return { rows: [], rowCount: null };
    }

    // ---------- tasks ----------
    if (s.startsWith('INSERT INTO tasks')) {
      const [owner, description, idemKey] = params as [string, string | null, string];
      for (const t of this.tasks.values()) {
        if (t.idempotency_key === idemKey) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
      }
      const id = nextId('task');
      const now = nowIso();
      this.tasks.set(id, {
        id,
        owner_user_id: owner,
        current_step: 'upload',
        status: 'running',
        description,
        meta: {},
        retry_count: 0,
        last_error: null,
        lease_owner: null,
        lease_expires_at: null,
        idempotency_key: idemKey,
        created_at: now,
        updated_at: now,
      });
      return { rows: [{ id }] as R[], rowCount: 1 };
    }

    if (s.includes('FROM tasks WHERE idempotency_key = $1')) {
      const key = params[0] as string;
      const t = [...this.tasks.values()].find((x) => x.idempotency_key === key);
      return t
        ? { rows: [{ id: t.id, owner_user_id: t.owner_user_id }] as R[], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }

    // transition（唯一状态变更入口）：WHERE id + 期望 (step,status) 乐观锁。
    if (
      s.includes('UPDATE tasks') &&
      s.includes('WHERE id = $1 AND current_step = $2 AND status = $3')
    ) {
      const [id, expStep, expStatus, step, status, errMode, errJson, retryMode] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string,
      ];
      const t = this.tasks.get(id);
      if (!t || t.current_step !== expStep || t.status !== expStatus) {
        this.updateRowCounts.push(0);
        return { rows: [], rowCount: 0 };
      }
      t.current_step = step ?? t.current_step;
      t.status = status ?? t.status;
      if (errMode === 'set') t.last_error = errJson ? JSON.parse(errJson) : null;
      else if (errMode === 'clear') t.last_error = null;
      if (retryMode === 'increment') t.retry_count += 1;
      else if (retryMode === 'reset') t.retry_count = 0;
      t.lease_owner = null;
      t.lease_expires_at = null;
      t.updated_at = nowIso();
      this.updateRowCounts.push(1);
      return { rows: [], rowCount: 1 };
    }

    // claimTask：SET lease_owner=$2 WHERE running+extract 且无有效租约。
    if (s.includes('UPDATE tasks') && s.includes('SET lease_owner = $2')) {
      const [id, leaseOwner, leaseMs] = params as [string, string, string];
      const t = this.tasks.get(id);
      const leaseValid = t?.lease_expires_at && new Date(t.lease_expires_at).getTime() > Date.now();
      if (!t || t.status !== 'running' || t.current_step !== 'extract' || leaseValid) {
        this.updateRowCounts.push(0);
        return { rows: [], rowCount: 0 };
      }
      t.lease_owner = leaseOwner;
      t.lease_expires_at = new Date(Date.now() + Number(leaseMs)).toISOString();
      t.updated_at = nowIso();
      this.updateRowCounts.push(1);
      return {
        rows: [{ owner_user_id: t.owner_user_id, retry_count: t.retry_count, meta: t.meta }] as R[],
        rowCount: 1,
      };
    }

    // renewLease：WHERE id=$1 AND lease_owner=$2 AND running。
    if (s.includes('UPDATE tasks') && s.includes('WHERE id = $1 AND lease_owner = $2')) {
      const [id, leaseOwner, leaseMs] = params as [string, string, string];
      const t = this.tasks.get(id);
      if (!t || t.lease_owner !== leaseOwner || t.status !== 'running') {
        this.updateRowCounts.push(0);
        return { rows: [], rowCount: 0 };
      }
      t.lease_expires_at = new Date(Date.now() + Number(leaseMs)).toISOString();
      this.updateRowCounts.push(1);
      return { rows: [], rowCount: 1 };
    }

    // saveTaskProgress：jsonb_set(meta,'{progress}')，仅 running。
    if (s.includes('UPDATE tasks') && s.includes("jsonb_set(meta, '{progress}'")) {
      const [id, progressJson] = params as [string, string];
      const t = this.tasks.get(id);
      if (!t || t.status !== 'running') {
        this.updateRowCounts.push(0);
        return { rows: [], rowCount: 0 };
      }
      t.meta = { ...t.meta, progress: JSON.parse(progressJson) };
      t.updated_at = nowIso();
      this.updateRowCounts.push(1);
      return { rows: [], rowCount: 1 };
    }

    // readTaskCore
    if (s.includes('SELECT id, owner_user_id, current_step, status, last_error, meta FROM tasks')) {
      const t = this.tasks.get(params[0] as string);
      if (!t) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: t.id,
            owner_user_id: t.owner_user_id,
            current_step: t.current_step,
            status: t.status,
            last_error: t.last_error,
            meta: t.meta,
          },
        ] as R[],
        rowCount: 1,
      };
    }

    // expireIncompleteUploadTasks：单条 CTE 原子置 upload=expired + task=failed；完整清单排除。
    if (
      s.startsWith('WITH candidates AS MATERIALIZED') &&
      s.includes("SET status = 'expired'") &&
      s.includes("SET status = 'failed'")
    ) {
      const [owner, taskId, limit, lastErrorJson] = params as [
        string | null,
        string | null,
        number,
        string,
      ];
      const candidates = [...this.tasks.values()]
        .filter((t) => {
          const u = this.uploads.get(t.id);
          return (
            !!u &&
            t.status === 'running' &&
            t.current_step === 'upload' &&
            u.status === 'pending' &&
            new Date(u.pairing_expires_at).getTime() <= Date.now() &&
            !partsState(u.parts).complete &&
            (owner === null || t.owner_user_id === owner) &&
            (taskId === null || t.id === taskId)
          );
        })
        .sort(
          (a, b) =>
            new Date(this.uploads.get(a.id)!.pairing_expires_at).getTime() -
            new Date(this.uploads.get(b.id)!.pairing_expires_at).getTime(),
        )
        .slice(0, limit);
      const rows = candidates.map((t) => {
        const u = this.uploads.get(t.id)!;
        u.status = 'expired';
        t.status = 'failed';
        t.last_error = JSON.parse(lastErrorJson);
        t.lease_owner = null;
        t.lease_expires_at = null;
        t.updated_at = nowIso();
        return { id: t.id };
      });
      return { rows: rows as R[], rowCount: rows.length };
    }

    // findStalledExtractTasks
    if (
      s.startsWith("SELECT id FROM tasks WHERE status = 'running' AND current_step = 'extract'")
    ) {
      const rows = [...this.tasks.values()]
        .filter((t) => {
          if (t.status !== 'running' || t.current_step !== 'extract') return false;
          if (t.lease_expires_at) return new Date(t.lease_expires_at).getTime() < Date.now();
          return new Date(t.updated_at).getTime() < Date.now() - 2 * 60 * 1000;
        })
        .map((t) => ({ id: t.id }));
      return { rows: rows as R[], rowCount: rows.length };
    }

    // TaskView 读（单个 / 列表）：JOIN uploads + capability_count。
    if (s.includes('FROM tasks t JOIN uploads u ON u.task_id = t.id')) {
      const shape = (t: TaskRowF): Record<string, unknown> => {
        const u = this.uploads.get(t.id)!;
        return {
          id: t.id,
          current_step: t.current_step,
          status: t.status,
          description: t.description,
          retry_count: t.retry_count,
          last_error: t.last_error,
          created_at: t.created_at,
          updated_at: t.updated_at,
          upload_status: u.status,
          parts: u.parts,
          pairing_expires_at: u.pairing_expires_at,
          capability_count: [...this.capabilities.values()].filter((c) => c.task_id === t.id)
            .length,
        };
      };
      if (s.includes('WHERE t.id = $1 AND t.owner_user_id = $2')) {
        const t = this.tasks.get(params[0] as string);
        if (!t || t.owner_user_id !== params[1] || !this.uploads.get(t.id)) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [shape(t)] as R[], rowCount: 1 };
      }
      // 列表：owner + 可选 cursor（id < $2）+ LIMIT $3，id 降序。
      const [owner, cursor, limit] = params as [string, string | null, number];
      const rows = [...this.tasks.values()]
        .filter((t) => t.owner_user_id === owner && (cursor === null || t.id < cursor))
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(shape);
      return { rows: rows as R[], rowCount: rows.length };
    }

    // ---------- uploads ----------
    if (s.startsWith('INSERT INTO uploads')) {
      const [taskId, hash, expiresAt] = params as [string, string, string];
      this.uploads.set(taskId, {
        task_id: taskId,
        storage_key: null,
        status: 'pending',
        pairing_code_hash: hash,
        pairing_expires_at: expiresAt,
        parts: {},
        raw_purged_at: null,
        meta: {},
      });
      return { rows: [], rowCount: 1 };
    }

    if (s.includes('WHERE u.pairing_code_hash = $1')) {
      const hash = params[0] as string;
      const u = [...this.uploads.values()].find((x) => x.pairing_code_hash === hash);
      if (!u) return { rows: [], rowCount: 0 };
      const t = this.tasks.get(u.task_id)!;
      return {
        rows: [
          {
            task_id: u.task_id,
            owner_user_id: t.owner_user_id,
            upload_status: u.status,
            expired: new Date(u.pairing_expires_at).getTime() <= Date.now(),
            current_step: t.current_step,
            status: t.status,
            parts: u.parts,
          },
        ] as R[],
        rowCount: 1,
      };
    }

    // v2 prepare：切换清单并把旧对象键登记为 stale。
    if (
      s.includes('UPDATE uploads') &&
      s.includes("'protocolVersion', 2") &&
      s.includes("'bundleId', $2")
    ) {
      const [taskId, bundleId, total] = params as [string, string, number];
      const u = this.uploads.get(taskId);
      if (!u || u.status !== 'pending' || new Date(u.pairing_expires_at).getTime() <= Date.now()) {
        return { rows: [], rowCount: 0 };
      }
      const stale = Array.isArray(u.meta.stale_object_keys)
        ? u.meta.stale_object_keys.filter((key): key is string => typeof key === 'string')
        : [];
      const oldKeys = Object.values(u.parts.landed ?? {});
      u.meta = {
        ...u.meta,
        stale_object_keys: [...stale, ...oldKeys],
        stale_cleanup_version:
          typeof u.meta.stale_cleanup_version === 'number' ? u.meta.stale_cleanup_version + 1 : 1,
      };
      u.parts = { protocolVersion: 2, bundleId, total, landed: {} };
      return { rows: [{ parts: u.parts }] as R[], rowCount: 1 };
    }

    // 写桶后未登记的通用 stale key 追踪。
    if (
      s.includes('UPDATE uploads') &&
      s.includes("'{stale_object_keys}'") &&
      !s.includes("'{stale_object_keys}', '[]'::jsonb")
    ) {
      const [taskId, objectKey] = params as [string, string];
      const u = this.uploads.get(taskId);
      if (!u) return { rows: [], rowCount: 0 };
      const existing = Array.isArray(u.meta.stale_object_keys)
        ? u.meta.stale_object_keys.filter((key): key is string => typeof key === 'string')
        : [];
      u.meta = {
        ...u.meta,
        stale_object_keys: existing.includes(objectKey) ? existing : [...existing, objectKey],
        stale_cleanup_version:
          typeof u.meta.stale_cleanup_version === 'number' ? u.meta.stale_cleanup_version + 1 : 1,
      };
      return { rows: [], rowCount: 1 };
    }

    // rotatePairingCode
    if (s.includes('UPDATE uploads') && s.includes('SET pairing_code_hash = $2')) {
      const [taskId, hash, expiresAt] = params as [string, string, string];
      const u = this.uploads.get(taskId);
      if (!u || u.status !== 'pending') {
        this.updateRowCounts.push(0);
        return { rows: [], rowCount: 0 };
      }
      u.pairing_code_hash = hash;
      u.pairing_expires_at = expiresAt;
      this.updateRowCounts.push(1);
      return { rows: [], rowCount: 1 };
    }

    // registerPart=null 后持久追踪 orphan key；追加推进 cleanup version 并清 purge 戳。
    if (
      s.includes('UPDATE uploads u') &&
      s.includes("'{expired_orphan_keys}'") &&
      s.includes("'{expired_cleanup_version}'")
    ) {
      const [taskId, objectKey] = params as [string, string];
      const u = this.uploads.get(taskId);
      const t = this.tasks.get(taskId);
      const trackable =
        !!u &&
        !!t &&
        (u.status === 'expired' ||
          (u.status === 'pending' &&
            new Date(u.pairing_expires_at).getTime() <= Date.now() &&
            t.current_step === 'upload' &&
            (t.status === 'running' || t.status === 'failed')));
      if (!trackable || !u || !t) return { rows: [], rowCount: 0 };
      const existing = Array.isArray(u.meta.expired_orphan_keys)
        ? u.meta.expired_orphan_keys.filter((key): key is string => typeof key === 'string')
        : [];
      u.meta = {
        ...u.meta,
        expired_orphan_keys: existing.includes(objectKey) ? existing : [...existing, objectKey],
        expired_cleanup_version:
          typeof u.meta.expired_cleanup_version === 'number'
            ? u.meta.expired_cleanup_version + 1
            : 1,
      };
      if (t.status === 'failed' && t.current_step === 'upload' && u.status === 'pending') {
        u.status = 'expired';
      }
      u.raw_purged_at = null;
      return { rows: [], rowCount: 1 };
    }

    // registerPart：landed 合并 + total 首次声明为准；仅 pending 且未过期。
    if (s.includes('UPDATE uploads') && s.includes('jsonb_build_object')) {
      const [taskId, idx, key, total, bundleId] = params as [
        string,
        string,
        string,
        number,
        string | null,
      ];
      const u = this.uploads.get(taskId);
      const declared = typeof u?.parts.total === 'number' ? u.parts.total : null;
      const compatible = bundleId
        ? u?.parts.bundleId === bundleId && declared === total
        : !u?.parts.bundleId && (declared === null || declared === total);
      if (
        !u ||
        u.status !== 'pending' ||
        new Date(u.pairing_expires_at).getTime() <= Date.now() ||
        !compatible
      ) {
        this.updateRowCounts.push(0);
        return { rows: [], rowCount: 0 };
      }
      u.parts = {
        ...(u.parts.protocolVersion ? { protocolVersion: u.parts.protocolVersion } : {}),
        ...(u.parts.bundleId ? { bundleId: u.parts.bundleId } : {}),
        total: typeof u.parts.total === 'number' ? u.parts.total : total,
        landed: { ...(u.parts.landed ?? {}), [idx]: key },
      };
      this.updateRowCounts.push(1);
      return { rows: [{ parts: u.parts }] as R[], rowCount: 1 };
    }

    // markUploadRaw（只置状态；storage_key 不再写入，收齐后不拼接完整原始件）
    if (s.includes('UPDATE uploads') && s.includes("SET status = 'raw'")) {
      const [taskId] = params as [string];
      const u = this.uploads.get(taskId);
      if (!u || u.status !== 'pending') {
        this.updateRowCounts.push(0);
        return { rows: [], rowCount: 0 };
      }
      u.status = 'raw';
      this.updateRowCounts.push(1);
      return { rows: [], rowCount: 1 };
    }

    // markUploadProcessed（raw_purged_at 只在 purged=true 时打戳，与真 SQL 的 CASE WHEN 一致）
    if (s.includes('UPDATE uploads') && s.includes("SET status = 'processed'")) {
      const [taskId, purged] = params as [string, boolean];
      const u = this.uploads.get(taskId);
      if (!u) {
        this.updateRowCounts.push(0);
        return { rows: [], rowCount: 0 };
      }
      u.status = 'processed';
      if (purged) u.raw_purged_at = nowIso();
      this.updateRowCounts.push(1);
      return { rows: [], rowCount: 1 };
    }

    // expired 原始对象清理成功戳；状态保留 expired 供诊断。
    if (s.includes('UPDATE uploads') && s.includes('SET raw_purged_at = now()')) {
      const [taskId, expectedVersion] = params as [string, number];
      const u = this.uploads.get(taskId);
      const version =
        typeof u?.meta.expired_cleanup_version === 'number' ? u.meta.expired_cleanup_version : 0;
      if (!u || u.status !== 'expired' || u.raw_purged_at !== null || version !== expectedVersion) {
        return { rows: [], rowCount: 0 };
      }
      u.raw_purged_at = nowIso();
      return { rows: [], rowCount: 1 };
    }

    // stale 对象清理成功后按版本清空追踪清单。
    if (s.includes('UPDATE uploads') && s.includes("'{stale_object_keys}', '[]'::jsonb")) {
      const [taskId, expectedVersion] = params as [string, number];
      const u = this.uploads.get(taskId);
      const version =
        typeof u?.meta.stale_cleanup_version === 'number' ? u.meta.stale_cleanup_version : 0;
      if (!u || version !== expectedVersion) return { rows: [], rowCount: 0 };
      u.meta = { ...u.meta, stale_object_keys: [] };
      return { rows: [], rowCount: 1 };
    }

    // mergeUploadMeta
    if (s.includes('UPDATE uploads') && s.includes('SET meta = meta ||')) {
      const [taskId, patch] = params as [string, string];
      const u = this.uploads.get(taskId);
      if (!u) return { rows: [], rowCount: 0 };
      u.meta = { ...u.meta, ...JSON.parse(patch) };
      return { rows: [], rowCount: 1 };
    }

    // readUploadForPipeline
    if (s.includes('SELECT storage_key, status, parts FROM uploads')) {
      const u = this.uploads.get(params[0] as string);
      if (!u) return { rows: [], rowCount: 0 };
      return {
        rows: [{ storage_key: u.storage_key, status: u.status, parts: u.parts }] as R[],
        rowCount: 1,
      };
    }

    // expired 且未打清理戳的持久重试队列。
    if (
      s.startsWith('SELECT task_id, storage_key, parts, meta,') &&
      s.includes("status = 'expired'")
    ) {
      const limit = params[0] as number;
      const rows = [...this.uploads.values()]
        .filter((u) => u.status === 'expired' && u.raw_purged_at === null)
        .slice(0, limit)
        .map((u) => ({
          task_id: u.task_id,
          storage_key: u.storage_key,
          parts: u.parts,
          meta: u.meta,
          cleanup_version:
            typeof u.meta.expired_cleanup_version === 'number' ? u.meta.expired_cleanup_version : 0,
        }));
      return { rows: rows as R[], rowCount: rows.length };
    }

    // 任意状态下 stale 对象的持久重试队列。
    if (s.startsWith('SELECT task_id, meta,') && s.includes("meta->'stale_object_keys'")) {
      const limit = params[0] as number;
      const rows = [...this.uploads.values()]
        .filter(
          (u) => Array.isArray(u.meta.stale_object_keys) && u.meta.stale_object_keys.length > 0,
        )
        .slice(0, limit)
        .map((u) => ({
          task_id: u.task_id,
          meta: u.meta,
          cleanup_version:
            typeof u.meta.stale_cleanup_version === 'number' ? u.meta.stale_cleanup_version : 0,
        }));
      return { rows: rows as R[], rowCount: rows.length };
    }

    // ---------- capabilities ----------
    if (s.startsWith('INSERT INTO capabilities')) {
      const [id, taskId, owner, name, summary, kind, storageKey, meta] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const row: CapabilityRowF = {
        id,
        task_id: taskId,
        owner_user_id: owner,
        name,
        summary,
        kind,
        storage_key: storageKey,
        published: false,
        published_at: null,
        share_token: null,
        meta: JSON.parse(meta),
        created_at: nowIso(),
      };
      this.capabilities.set(id, row);
      return { rows: [this.capabilityShape(row)] as R[], rowCount: 1 };
    }

    if (s.includes('FROM capabilities WHERE id = $1 AND owner_user_id = $2')) {
      const c = this.capabilities.get(params[0] as string);
      if (
        !c ||
        c.owner_user_id !== params[1] ||
        (s.includes("meta->>'origin'") && c.meta.origin === 'fallback')
      ) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [this.capabilityShape(c)] as R[], rowCount: 1 };
    }

    if (s.startsWith('SELECT id, meta FROM capabilities') && s.includes('id = ANY($2::uuid[])')) {
      const [owner, ids] = params as [string, string[]];
      const rows = ids
        .map((id) => this.capabilities.get(id))
        .filter((c): c is CapabilityRowF => c?.owner_user_id === owner)
        .map((c) => ({ id: c.id, meta: c.meta }));
      return { rows: rows as R[], rowCount: rows.length };
    }

    if (s.includes('FROM capabilities WHERE owner_user_id = $1')) {
      const [owner, taskId, cursor, limit] = params as [
        string,
        string | null,
        string | null,
        number,
      ];
      const rows = [...this.capabilities.values()]
        .filter(
          (c) =>
            c.owner_user_id === owner &&
            (!s.includes("meta->>'origin'") || c.meta.origin !== 'fallback') &&
            (taskId === null || c.task_id === taskId) &&
            (cursor === null || c.id < cursor),
        )
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map((c) => this.capabilityShape(c));
      return { rows: rows as R[], rowCount: rows.length };
    }

    if (s.includes('UPDATE capabilities') && s.includes('SET published = true')) {
      const [id, owner, token] = params as [string, string, string];
      const c = this.capabilities.get(id);
      if (
        !c ||
        c.owner_user_id !== owner ||
        (s.includes("meta->>'origin'") && c.meta.origin === 'fallback')
      ) {
        this.updateRowCounts.push(0);
        return { rows: [], rowCount: 0 };
      }
      c.published = true;
      c.published_at = nowIso();
      c.share_token = c.share_token ?? token;
      this.updateRowCounts.push(1);
      return { rows: [this.capabilityShape(c)] as R[], rowCount: 1 };
    }

    if (s.includes('UPDATE capabilities') && s.includes('SET published = false')) {
      const [id, owner] = params as [string, string];
      const c = this.capabilities.get(id);
      if (!c || c.owner_user_id !== owner) {
        this.updateRowCounts.push(0);
        return { rows: [], rowCount: 0 };
      }
      c.published = false;
      c.published_at = null;
      this.updateRowCounts.push(1);
      return { rows: [this.capabilityShape(c)] as R[], rowCount: 1 };
    }

    throw new Error(`FakeDb: unhandled SQL: ${s.slice(0, 140)}`);
  }

  private capabilityShape(c: CapabilityRowF): Record<string, unknown> {
    return {
      id: c.id,
      task_id: c.task_id,
      name: c.name,
      summary: c.summary,
      kind: c.kind,
      published: c.published,
      published_at: c.published_at,
      share_token: c.share_token,
      created_at: c.created_at,
    };
  }
}

/** 假对象存储（内存 Map；只实现流水线/配对用到的方法）。 */
export class FakeObjectStore implements ObjectStorePort {
  objects = new Map<string, Uint8Array>();

  private k(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }
  async putObject(bucket: Bucket, key: string, body: Uint8Array): Promise<{ key: string }> {
    this.objects.set(this.k(bucket, key), body);
    return { key };
  }
  async getObjectText(bucket: Bucket, key: string): Promise<string> {
    const v = this.objects.get(this.k(bucket, key));
    if (!v) throw new Error(`FakeObjectStore: missing ${bucket}/${key}`);
    return new TextDecoder().decode(v);
  }
  async getObject(bucket: Bucket, key: string): Promise<Uint8Array> {
    const v = this.objects.get(this.k(bucket, key));
    if (!v) throw new Error(`FakeObjectStore: missing ${bucket}/${key}`);
    return v;
  }
  async delete(bucket: Bucket, key: string): Promise<void> {
    this.objects.delete(this.k(bucket, key));
  }
  async presignPut(): Promise<{ url: string; key: string }> {
    throw new Error('not used');
  }
  async presignGet(): Promise<{ url: string }> {
    throw new Error('not used');
  }
  async list(): Promise<[]> {
    return [];
  }
  async head(): Promise<null> {
    return null;
  }
}

/** 假队列（记录 enqueue 调用）。 */
export class FakeQueue implements QueuePort {
  enqueued: Array<{ queue: string; taskId: string }> = [];
  async enqueue(queue: string, taskId: string): Promise<void> {
    this.enqueued.push({ queue, taskId });
  }
  async remove(): Promise<void> {}
}

/** 假事件桥（记录 worker 推的帧）。 */
export class FakeStream implements TaskEventBridge {
  frames: Array<{ taskId: string; event: SSEEventType; payload: unknown }> = [];
  async publish(
    taskId: string,
    frame: { event: SSEEventType; payload: unknown },
  ): Promise<string | null> {
    this.frames.push({ taskId, ...frame });
    return `${this.frames.length}-0`;
  }
  events(taskId: string): SSEEventType[] {
    return this.frames.filter((f) => f.taskId === taskId).map((f) => f.event);
  }
}

/** 假 LLM 网关：按脚本回文本 / 降级 / 抛错。 */
export class FakeLlm implements LlmGatewayPort {
  calls: string[] = [];
  constructor(
    private readonly script: (prompt: string, callIndex: number) => LlmResult | Error = () => ({
      degraded: true,
      usage: { promptTokens: 0, completionTokens: 0, costMicros: 0 },
    }),
  ) {}
  async complete(prompt: string, _opts: LlmCallOptions): Promise<LlmResult> {
    const r = this.script(prompt, this.calls.length);
    this.calls.push(prompt);
    if (r instanceof Error) throw r;
    return r;
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<{ deltaText: string }> {
    throw new Error('not used');
  }
  async embed(): Promise<LlmResult> {
    throw new Error('not used');
  }
}

/** 造一个 LLM 成功结果。 */
export function llmText(text: string): LlmResult {
  return {
    text,
    degraded: false,
    usage: { promptTokens: 10, completionTokens: 20, costMicros: 5 },
  };
}
