import type { ObjectStorePort } from '@cb/shared';
import { createHash } from 'node:crypto';
import type { TxPool } from '../../platform/infra/db-tx.js';
import { COMBO_MINIAPP_DEMO_MARKER, comboMiniappDefinition, newDemoSeedId } from './fixture.js';
import { readDemoSeedRows, upsertDemoSeedRows, type DemoSeedRowsResult } from './repo.js';

export const DEMO_CAPABILITY_BUCKET = 'combo-artifacts' as const;

export function demoCapabilityStorageKey(capabilityId: string): string {
  return `capabilities/${capabilityId}/definition.json`;
}

export async function seedComboMiniapp(
  pool: TxPool,
  objectStore: ObjectStorePort,
  ownerUserId: string,
): Promise<DemoSeedRowsResult> {
  const existing = await readDemoSeedRows(pool, ownerUserId);
  const taskId = existing?.taskId ?? newDemoSeedId();
  const capabilityId = existing?.capabilityId ?? newDemoSeedId();
  const definition = comboMiniappDefinition();
  const storageKey = demoCapabilityStorageKey(capabilityId);
  const bundleId = createHash('sha256')
    .update(`combo:test-demo:bundle:${ownerUserId}`)
    .digest('hex');
  const totalParts = 12;
  const landed = Object.fromEntries(
    Array.from({ length: totalParts }, (_, index) => [
      String(index),
      `uploads/${taskId}/${bundleId}/part-${index}`,
    ]),
  );

  // 与真实 pipeline 同序：先落完整定义，再提交指向它的数据库行；失败重试覆盖同一对象键。
  await objectStore.putObject(
    DEMO_CAPABILITY_BUCKET,
    storageKey,
    new TextEncoder().encode(JSON.stringify(definition)),
    { contentType: 'application/json' },
  );

  return upsertDemoSeedRows(pool, {
    ownerUserId,
    taskId,
    capabilityId,
    storageKey,
    name: definition.name,
    summary: definition.summary,
    kind: definition.kind,
    taskMeta: {
      ...COMBO_MINIAPP_DEMO_MARKER,
      seed: true,
      extractedCount: 1,
    },
    uploadParts: {
      protocolVersion: 2,
      bundleId,
      total: totalParts,
      landed,
    },
    uploadMeta: {
      ...COMBO_MINIAPP_DEMO_MARKER,
      seed: true,
      sessionCount: 12,
      segmentCount: 96,
    },
    capabilityMeta: {
      ...definition.meta,
      reuseScore: 0.86,
      sourceSessions: 12,
    },
  });
}
