// capabilities 表 SQL。库里只存轻量索引，完整可运行定义在 MinIO（storage_key）。
// owner 校验统一收在 SQL 的 owner_user_id 条件里：非本人与不存在同样 0 行（不暴露存在性）。
import type { CapabilityView, PublishResult } from '@cb/shared';
import { toIso, type Queryable } from '../../platform/infra/db.js';

interface CapabilityRow {
  id: string;
  task_id: string;
  name: string;
  summary: string;
  kind: string;
  published: boolean;
  published_at: string | Date | null;
  share_token: string | null;
  created_at: string | Date;
  storage_key?: string;
}

/** 读完整定义所需的 owner-scoped 索引与对象键。 */
export async function readCapabilityDefinitionRef(
  db: Queryable,
  capabilityId: string,
  ownerUserId: string,
): Promise<{ view: CapabilityView; storageKey: string } | null> {
  const res = await db.query<CapabilityRow>(
    `SELECT ${VIEW_COLUMNS}, storage_key
       FROM capabilities
      WHERE id = $1 AND owner_user_id = $2
        AND COALESCE(meta->>'origin', '') <> 'fallback'`,
    [capabilityId, ownerUserId],
  );
  const row = res.rows[0];
  return row?.storage_key ? { view: toView(row), storageKey: row.storage_key } : null;
}

const VIEW_COLUMNS = `id, task_id, name, summary, kind, published, published_at, share_token, created_at`;

function toView(row: CapabilityRow): CapabilityView {
  return {
    id: row.id,
    taskId: row.task_id,
    name: row.name,
    summary: row.summary,
    kind: row.kind,
    published: row.published,
    ...(row.published_at ? { publishedAt: toIso(row.published_at) } : {}),
    ...(row.share_token ? { shareToken: row.share_token } : {}),
    createdAt: toIso(row.created_at),
  };
}

/** 提取流水线落一个能力项（id 由调用方生成：先写 MinIO 定义再插行，storage_key 非空约束）。 */
export async function insertCapability(
  db: Queryable,
  input: {
    id: string;
    taskId: string;
    ownerUserId: string;
    name: string;
    summary: string;
    kind: string;
    storageKey: string;
    meta: Record<string, unknown>;
  },
): Promise<CapabilityView> {
  const res = await db.query<CapabilityRow>(
    `INSERT INTO capabilities (id, task_id, owner_user_id, name, summary, kind, storage_key, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING ${VIEW_COLUMNS}`,
    [
      input.id,
      input.taskId,
      input.ownerUserId,
      input.name,
      input.summary,
      input.kind,
      input.storageKey,
      JSON.stringify(input.meta),
    ],
  );
  return toView(res.rows[0]!);
}

/** 读单个能力项（owner 限定；非本人/不存在 → null）。 */
export async function readCapabilityView(
  db: Queryable,
  capabilityId: string,
  ownerUserId: string,
): Promise<CapabilityView | null> {
  const res = await db.query<CapabilityRow>(
    `SELECT ${VIEW_COLUMNS}
       FROM capabilities
      WHERE id = $1 AND owner_user_id = $2
        AND COALESCE(meta->>'origin', '') <> 'fallback'`,
    [capabilityId, ownerUserId],
  );
  const row = res.rows[0];
  return row ? toView(row) : null;
}

/** 能力项列表（owner 限定，可按 taskId 过滤，新→旧；cursor = 上一页末位 id）。 */
export async function listCapabilityViews(
  db: Queryable,
  input: { ownerUserId: string; taskId?: string; limit: number; cursorId?: string },
): Promise<{ items: CapabilityView[]; hasMore: boolean }> {
  const res = await db.query<CapabilityRow>(
    `SELECT ${VIEW_COLUMNS}
       FROM capabilities
      WHERE owner_user_id = $1
        AND COALESCE(meta->>'origin', '') <> 'fallback'
        AND ($2::uuid IS NULL OR task_id = $2)
        AND ($3::uuid IS NULL OR id < $3)
      ORDER BY id DESC
      LIMIT $4`,
    [input.ownerUserId, input.taskId ?? null, input.cursorId ?? null, input.limit + 1],
  );
  const hasMore = res.rows.length > input.limit;
  return { items: res.rows.slice(0, input.limit).map(toView), hasMore };
}

/**
 * 发布标记：published=true + published_at=now()；share_token 无则用传入值补上（有则保留旧值，
 * 分享链接跨发布/下架稳定）。非本人/不存在 → null。
 */
export async function publishCapability(
  db: Queryable,
  input: { capabilityId: string; ownerUserId: string; shareToken: string },
): Promise<PublishResult | null> {
  const res = await db.query<CapabilityRow>(
    `UPDATE capabilities
        SET published = true,
            published_at = now(),
            share_token = COALESCE(share_token, $3),
            updated_at = now()
      WHERE id = $1 AND owner_user_id = $2
        AND COALESCE(meta->>'origin', '') <> 'fallback'
      RETURNING ${VIEW_COLUMNS}`,
    [input.capabilityId, input.ownerUserId, input.shareToken],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    published: row.published,
    ...(row.published_at ? { publishedAt: toIso(row.published_at) } : {}),
    ...(row.share_token ? { shareToken: row.share_token } : {}),
  };
}

/** 取消发布：published=false、published_at 清空；share_token 保留（再发布沿用同一分享链接）。 */
export async function unpublishCapability(
  db: Queryable,
  input: { capabilityId: string; ownerUserId: string },
): Promise<PublishResult | null> {
  const res = await db.query<CapabilityRow>(
    `UPDATE capabilities
        SET published = false,
            published_at = NULL,
            updated_at = now()
      WHERE id = $1 AND owner_user_id = $2
      RETURNING ${VIEW_COLUMNS}`,
    [input.capabilityId, input.ownerUserId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    published: row.published,
    ...(row.share_token ? { shareToken: row.share_token } : {}),
  };
}
