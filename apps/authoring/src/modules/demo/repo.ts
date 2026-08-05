// Test demo 的三表原子落库：终态 task + processed upload + capability。
// 只使用 combo_api 已获授权的 tasks / uploads / capabilities，不依赖迁移所有者权限。
import { createHash } from 'node:crypto';
import type { TxPool } from '../../platform/infra/db-tx.js';
import { withTransaction } from '../../platform/infra/db-tx.js';
import { COMBO_MINIAPP_DEMO_MARKER } from './fixture.js';

export interface DemoSeedRowsInput {
  ownerUserId: string;
  taskId: string;
  capabilityId: string;
  storageKey: string;
  name: string;
  summary: string;
  kind: string;
  taskMeta: Record<string, unknown>;
  uploadParts: Record<string, unknown>;
  uploadMeta: Record<string, unknown>;
  capabilityMeta: Record<string, unknown>;
}

export interface DemoSeedRowsResult {
  taskId: string;
  capabilityId: string;
  reused: boolean;
}

const IDEMPOTENCY_PREFIX = 'test-demo-agent:combo-miniapp:v1:';

function idempotencyKey(ownerUserId: string): string {
  return `${IDEMPOTENCY_PREFIX}${ownerUserId}`;
}

/** 回读本账号既有夹具身份，避免重试生成新 ID，也保留 UUID v7 的列表顺序语义。 */
export async function readDemoSeedRows(
  pool: TxPool,
  ownerUserId: string,
): Promise<DemoSeedRowsResult | null> {
  const conn = await pool.connect();
  try {
    const result = await conn.query<{ task_id: string; capability_id: string }>(
      `SELECT t.id AS task_id, c.id AS capability_id
         FROM tasks t
         JOIN capabilities c
           ON c.task_id = t.id
          AND c.owner_user_id = t.owner_user_id
          AND c.meta @> $3::jsonb
        WHERE t.idempotency_key = $1
          AND t.owner_user_id = $2
          AND t.meta @> $3::jsonb
        ORDER BY c.created_at ASC
        LIMIT 1`,
      [idempotencyKey(ownerUserId), ownerUserId, JSON.stringify(COMBO_MINIAPP_DEMO_MARKER)],
    );
    const row = result.rows[0];
    return row ? { taskId: row.task_id, capabilityId: row.capability_id, reused: true } : null;
  } finally {
    conn.release();
  }
}

/** 幂等修复式 seed：重复调用会把同一夹具补齐到可继续体验的终态，不新增重复行。 */
export async function upsertDemoSeedRows(
  pool: TxPool,
  input: DemoSeedRowsInput,
): Promise<DemoSeedRowsResult> {
  return withTransaction(pool, async (tx) => {
    const taskIdempotencyKey = idempotencyKey(input.ownerUserId);
    const markerJson = JSON.stringify(COMBO_MINIAPP_DEMO_MARKER);
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO tasks
         (id, owner_user_id, current_step, status, description, meta, retry_count,
          last_error, lease_owner, lease_expires_at, idempotency_key)
       VALUES ($1, $2, 'extract', 'succeeded', $3, $4::jsonb, 0, NULL, NULL, NULL, $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        input.taskId,
        input.ownerUserId,
        'Test 示例 · Combo Miniapp 已生成',
        JSON.stringify(input.taskMeta),
        taskIdempotencyKey,
      ],
    );

    let taskId = inserted.rows[0]?.id;
    const reused = taskId === undefined;
    if (!taskId) {
      const repaired = await tx.query<{ id: string }>(
        `UPDATE tasks
            SET current_step = 'extract',
                status = 'succeeded',
                description = $3,
                meta = $4::jsonb,
                retry_count = 0,
                last_error = NULL,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = now()
          WHERE idempotency_key = $1
            AND owner_user_id = $2
            AND meta @> $5::jsonb
          RETURNING id`,
        [
          taskIdempotencyKey,
          input.ownerUserId,
          'Test 示例 · Combo Miniapp 已生成',
          JSON.stringify(input.taskMeta),
          markerJson,
        ],
      );
      taskId = repaired.rows[0]?.id;
    }
    if (!taskId) throw new Error('demo seed idempotency conflict');

    await tx.query(
      `INSERT INTO uploads
       (task_id, storage_key, status, pairing_code_hash, pairing_expires_at,
          parts, raw_purged_at, meta)
       VALUES ($1, NULL, 'processed', $2, now(), $3::jsonb, now(), $4::jsonb)
       ON CONFLICT (task_id) DO UPDATE
         SET storage_key = NULL,
             status = 'processed',
             parts = EXCLUDED.parts,
             raw_purged_at = COALESCE(uploads.raw_purged_at, now()),
             meta = EXCLUDED.meta,
             updated_at = now()`,
      [
        taskId,
        // pairing_code_hash 虽然不会再被使用，仍保持与真实行一致的 64 hex 形态。
        createHash('sha256').update(`combo:test-demo:pairing:${input.ownerUserId}`).digest('hex'),
        JSON.stringify(input.uploadParts),
        JSON.stringify(input.uploadMeta),
      ],
    );

    let capabilityId = input.capabilityId;
    if (reused) {
      const existingCapability = await tx.query<{ id: string }>(
        `SELECT id
           FROM capabilities
          WHERE task_id = $1
            AND owner_user_id = $2
            AND meta @> $3::jsonb
          ORDER BY created_at ASC
          LIMIT 1`,
        [taskId, input.ownerUserId, markerJson],
      );
      capabilityId = existingCapability.rows[0]?.id ?? capabilityId;
    }

    const capability = await tx.query<{ id: string }>(
      `INSERT INTO capabilities
         (id, task_id, owner_user_id, name, summary, kind, storage_key, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             summary = EXCLUDED.summary,
             kind = EXCLUDED.kind,
             storage_key = EXCLUDED.storage_key,
             meta = EXCLUDED.meta,
             updated_at = now()
       WHERE capabilities.task_id = EXCLUDED.task_id
         AND capabilities.owner_user_id = EXCLUDED.owner_user_id
       RETURNING id`,
      [
        capabilityId,
        taskId,
        input.ownerUserId,
        input.name,
        input.summary,
        input.kind,
        input.storageKey,
        JSON.stringify(input.capabilityMeta),
      ],
    );
    const persistedCapabilityId = capability.rows[0]?.id;
    if (!persistedCapabilityId) throw new Error('demo capability ownership conflict');

    return { taskId, capabilityId: persistedCapabilityId, reused };
  });
}
