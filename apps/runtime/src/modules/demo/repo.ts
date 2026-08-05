// Test 演示数据仓储：只读 Capability 身份和已有 Studio Session，不扩大 Runtime 数据库权限。
import type { Queryable } from '../../platform/infra/db.js';
import type { SessionRow } from '../session/repo.js';
import { COMBO_MINIAPP_FIXTURE } from './fixture.js';

interface SessionDbRow {
  id: string;
  capability_id: string;
  owner_user_id: string;
  mode: 'studio';
  title: string | null;
  status: 'active';
  created_at: string | Date;
  updated_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** 只有当前用户自己的固定 Test 演示 Capability 才能进入种子路径。 */
export async function ownsComboMiniappDemoCapability(
  db: Queryable,
  capabilityId: string,
  ownerUserId: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `SELECT id
       FROM capabilities
      WHERE id = $1
        AND owner_user_id = $2
        AND meta @> $3::jsonb
      LIMIT 1`,
    [capabilityId, ownerUserId, JSON.stringify(COMBO_MINIAPP_FIXTURE)],
  );
  return Boolean(result.rows[0]);
}

/** 创建前读取 active Studio，用于把幂等复用状态明确返回给 Test 前端。 */
export async function readActiveDemoStudioSession(
  db: Queryable,
  capabilityId: string,
  ownerUserId: string,
): Promise<SessionRow | null> {
  const result = await db.query<SessionDbRow>(
    `SELECT id, capability_id, owner_user_id, mode, title, status, created_at, updated_at
       FROM sessions
      WHERE capability_id = $1
        AND owner_user_id = $2
        AND mode = 'studio'
        AND status = 'active'
      LIMIT 1`,
    [capabilityId, ownerUserId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    capabilityId: row.capability_id,
    ownerUserId: row.owner_user_id,
    mode: row.mode,
    title: row.title,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}
