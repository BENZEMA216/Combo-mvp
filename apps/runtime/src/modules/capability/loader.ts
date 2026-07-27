// 能力加载：capabilities 行（权限闸）→ 按 storage_key 从 MinIO 读定义 → schema 校验。
//   放行条件：owner 是本人 OR published=true；否则与不存在同样 not_found（不暴露存在性）。
//   version 不认识 → unsupported_version（「能力格式过新」）而不是猜着解析。
import { CapabilityDefinitionSchema, type CapabilityDefinition } from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import type { RuntimeObjectStore } from '../../platform/infra/object-store.js';
import { toIso } from '../session/repo.js';

/** 能力定义所在桶（与 authoring 提取流水线写入侧一致）。 */
export const CAPABILITY_BUCKET = 'combo-artifacts' as const;

/** 能力行摘要（库里那行轻量索引，试用端消费的子集）。 */
export interface CapabilitySummary {
  id: string;
  name: string;
  summary: string;
  kind: string;
  published: boolean;
  ownerUserId: string;
}

export type LoadCapabilityResult =
  | { kind: 'ok'; capability: CapabilitySummary; definition: CapabilityDefinition }
  | { kind: 'not_found' }
  | { kind: 'unsupported_version' }
  | { kind: 'invalid_definition' };

export type CapabilityAccess = 'consume' | 'owner';

interface CapabilityDbRow {
  id: string;
  owner_user_id: string;
  name: string;
  summary: string;
  kind: string;
  storage_key: string;
  published: boolean;
  created_at: string | Date;
}

/**
 * 加载一个能力的完整可运行定义（开会话/发消息前必过）。
 * userId：当前登录用户——本人可试未发布项，他人只能试已发布项。
 */
export async function loadCapability(
  db: Queryable,
  objectStore: RuntimeObjectStore,
  capabilityId: string,
  userId: string,
  access: CapabilityAccess = 'consume',
): Promise<LoadCapabilityResult> {
  const res = await db.query<CapabilityDbRow>(
    `SELECT id, owner_user_id, name, summary, kind, storage_key, published, created_at
       FROM capabilities
      WHERE id = $1
      LIMIT 1`,
    [capabilityId],
  );
  const row = res.rows[0];
  if (!row) return { kind: 'not_found' };
  if (row.owner_user_id !== userId && (access === 'owner' || !row.published)) {
    return { kind: 'not_found' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await objectStore.getObjectText(CAPABILITY_BUCKET, row.storage_key));
  } catch {
    return { kind: 'invalid_definition' };
  }

  // version 前置判定：不是当前认识的 1 → 格式过新（与「结构坏了」区分，报不同人话）。
  const version = (raw as { version?: unknown } | null)?.version;
  if (version !== 1) return { kind: 'unsupported_version' };

  const parsed = CapabilityDefinitionSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid_definition' };

  return {
    kind: 'ok',
    capability: {
      id: row.id,
      name: row.name,
      summary: row.summary,
      kind: row.kind,
      published: row.published,
      ownerUserId: row.owner_user_id,
    },
    definition: parsed.data,
  };
}

/** 会话详情里的能力摘要读（会话已过 owner 校验，这里不再做权限闸）。 */
export async function readCapabilitySummary(
  db: Queryable,
  capabilityId: string,
): Promise<Pick<CapabilitySummary, 'id' | 'name' | 'summary' | 'kind'> | null> {
  const res = await db.query<Pick<CapabilityDbRow, 'id' | 'name' | 'summary' | 'kind'>>(
    `SELECT id, name, summary, kind FROM capabilities WHERE id = $1 LIMIT 1`,
    [capabilityId],
  );
  const row = res.rows[0];
  return row ? { id: row.id, name: row.name, summary: row.summary, kind: row.kind } : null;
}

/** 试用入口列表项：我的全部 + 别人已发布的。 */
export interface TrialCapabilityItem {
  id: string;
  name: string;
  summary: string;
  kind: string;
  published: boolean;
  /** 是否本人创作（前端区分「我的 / 市集」分组）。 */
  owned: boolean;
  createdAt: string;
}

/** 试用入口列表：我的全部 + 已发布的，新→旧。 */
export async function listTrialCapabilities(
  db: Queryable,
  userId: string,
): Promise<TrialCapabilityItem[]> {
  const res = await db.query<CapabilityDbRow>(
    `SELECT id, owner_user_id, name, summary, kind, storage_key, published, created_at
       FROM capabilities
      WHERE owner_user_id = $1 OR published = true
      ORDER BY created_at DESC
      LIMIT 100`,
    [userId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    summary: r.summary,
    kind: r.kind,
    published: r.published,
    owned: r.owner_user_id === userId,
    createdAt: toIso(r.created_at),
  }));
}
