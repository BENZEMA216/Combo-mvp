import { describe, expect, it } from 'vitest';
import { CapabilityDefinitionSchema } from '@cb/shared';
import { ALL_ENDPOINTS, endpointsForEnvironment } from '../bootstrap/routes.js';
import {
  COMBO_MINIAPP_DEMO_MARKER,
  comboMiniappDefinition,
  newDemoSeedId,
} from '../modules/demo/fixture.js';
import {
  DEMO_CAPABILITY_BUCKET,
  demoCapabilityStorageKey,
  seedComboMiniapp,
} from '../modules/demo/service.js';
import type { QueryableDb, TxConn, TxPool } from '../platform/infra/db-tx.js';
import { FakeObjectStore } from './fakes.js';

const OWNER = '01900000-0000-7000-8000-000000000031';

class DemoSeedDb implements TxPool, QueryableDb {
  readonly txLog: string[] = [];
  readonly sqlLog: string[] = [];
  readonly tasksByKey = new Map<
    string,
    { id: string; owner: string; meta: Record<string, unknown> }
  >();
  readonly uploads = new Set<string>();
  readonly uploadParts = new Map<string, Record<string, unknown>>();
  readonly capabilities = new Map<string, { taskId: string; owner: string }>();
  readonly capabilityMeta = new Map<string, Record<string, unknown>>();

  async connect(): Promise<TxConn> {
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params),
      release: () => undefined,
    };
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.sqlLog.push(normalized);
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      this.txLog.push(normalized);
      return { rows: [], rowCount: null };
    }
    if (normalized.startsWith('SELECT t.id AS task_id, c.id AS capability_id')) {
      const [key, owner, markerJson] = params as [string, string, string];
      const marker = JSON.parse(markerJson) as Record<string, unknown>;
      const task = this.tasksByKey.get(key);
      if (
        !task ||
        task.owner !== owner ||
        !Object.entries(marker).every(([name, value]) => task.meta[name] === value)
      ) {
        return { rows: [], rowCount: 0 };
      }
      const capability = [...this.capabilities.entries()].find(
        ([id, row]) =>
          row.taskId === task.id &&
          row.owner === owner &&
          Object.entries(marker).every(
            ([name, value]) => this.capabilityMeta.get(id)?.[name] === value,
          ),
      );
      return capability
        ? {
            rows: [{ task_id: task.id, capability_id: capability[0] }] as R[],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('INSERT INTO tasks')) {
      const [id, owner, , metaJson, key] = params as [string, string, string, string, string];
      if (this.tasksByKey.has(key)) return { rows: [], rowCount: 0 };
      this.tasksByKey.set(key, {
        id,
        owner,
        meta: JSON.parse(metaJson) as Record<string, unknown>,
      });
      return { rows: [{ id }] as R[], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE tasks')) {
      const [key, owner, , metaJson, markerJson] = params as [
        string,
        string,
        string,
        string,
        string,
      ];
      const row = this.tasksByKey.get(key);
      const marker = JSON.parse(markerJson) as Record<string, unknown>;
      const matches =
        row?.owner === owner &&
        Object.entries(marker).every(([name, value]) => row.meta[name] === value);
      if (!row || !matches) return { rows: [], rowCount: 0 };
      row.meta = JSON.parse(metaJson) as Record<string, unknown>;
      return { rows: [{ id: row.id }] as R[], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO uploads')) {
      const taskId = params[0] as string;
      this.uploads.add(taskId);
      this.uploadParts.set(taskId, JSON.parse(params[2] as string) as Record<string, unknown>);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO capabilities')) {
      const [id, taskId, owner] = params as [string, string, string];
      const existing = this.capabilities.get(id);
      if (existing && (existing.taskId !== taskId || existing.owner !== owner)) {
        return { rows: [], rowCount: 0 };
      }
      this.capabilities.set(id, { taskId, owner });
      this.capabilityMeta.set(id, JSON.parse(params[7] as string) as Record<string, unknown>);
      return { rows: [{ id }] as R[], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT id FROM capabilities WHERE task_id = $1')) {
      const [taskId, owner, markerJson] = params as [string, string, string];
      const marker = JSON.parse(markerJson) as Record<string, unknown>;
      const row = [...this.capabilities.entries()].find(
        ([id, capability]) =>
          capability.taskId === taskId &&
          capability.owner === owner &&
          Object.entries(marker).every(
            ([name, value]) => this.capabilityMeta.get(id)?.[name] === value,
          ),
      );
      return row ? { rows: [{ id: row[0] }] as R[], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    throw new Error(`unhandled demo SQL: ${normalized}`);
  }
}

describe('Test-only Combo Miniapp seed', () => {
  it('只在 COMBO_ENVIRONMENT=test 暴露，并带 trusted Origin + auth 两层守卫', () => {
    const production = endpointsForEnvironment({ COMBO_ENVIRONMENT: 'production' });
    const review = endpointsForEnvironment({ COMBO_ENVIRONMENT: 'review' });
    const test = endpointsForEnvironment({ COMBO_ENVIRONMENT: 'test' });

    expect(production).toEqual(ALL_ENDPOINTS);
    expect(review).toEqual(ALL_ENDPOINTS);
    expect(test).toHaveLength(ALL_ENDPOINTS.length + 1);
    const endpoint = test.find((item) => item.url === '/test/demo-agents/combo-miniapp');
    expect(endpoint?.method).toBe('POST');
    expect(endpoint?.preHandlers).toHaveLength(2);
  });

  it('夹具定义可被共享契约解析，首次资源 ID 使用时间有序 UUID v7', () => {
    expect(CapabilityDefinitionSchema.parse(comboMiniappDefinition())).toMatchObject({
      version: 1,
      name: 'Combo Miniapp 设计助手',
      kind: '产品设计',
    });
    const nowMs = 1_700_000_000_000;
    const taskId = newDemoSeedId(nowMs);
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(taskId[14]).toBe('7');
    expect(BigInt(`0x${taskId.replaceAll('-', '').slice(0, 12)}`)).toBe(BigInt(nowMs));
    expect(taskId).not.toBe(newDemoSeedId(nowMs));
  });

  it('重复调用复用同一 task/capability，并把定义写入 combo-artifacts', async () => {
    const db = new DemoSeedDb();
    const objectStore = new FakeObjectStore();

    const first = await seedComboMiniapp(db, objectStore, OWNER);
    const second = await seedComboMiniapp(db, objectStore, OWNER);

    expect(first).toMatchObject({ reused: false });
    expect(second).toEqual({ ...first, reused: true });
    expect(db.tasksByKey).toHaveLength(1);
    expect(db.uploads).toEqual(new Set([first.taskId]));
    expect(db.uploadParts.get(first.taskId)).toMatchObject({
      protocolVersion: 2,
      total: 12,
      bundleId: expect.stringMatching(/^[0-9a-f]{64}$/),
      landed: expect.objectContaining({ '0': expect.any(String), '11': expect.any(String) }),
    });
    expect(db.capabilities).toHaveLength(1);
    expect(db.capabilityMeta.get(first.capabilityId)).toMatchObject({
      source: 'test-demo',
      fixture: 'combo-miniapp',
      fixtureVersion: 1,
    });
    expect(db.txLog).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
    expect(db.sqlLog.some((sql) => sql.includes("status = 'succeeded'"))).toBe(true);
    expect(db.sqlLog.some((sql) => sql.includes("status = 'processed'"))).toBe(true);

    const raw = await objectStore.getObjectText(
      DEMO_CAPABILITY_BUCKET,
      demoCapabilityStorageKey(first.capabilityId),
    );
    expect(CapabilityDefinitionSchema.parse(JSON.parse(raw))).toMatchObject({
      name: 'Combo Miniapp 设计助手',
      meta: {
        source: 'test-demo',
        fixture: 'combo-miniapp',
        fixtureVersion: 1,
        sampleOnly: true,
      },
    });
  });

  it('同账号下幂等键若不带完整 demo marker，失败关闭且不接管真实任务', async () => {
    const db = new DemoSeedDb();
    const objectStore = new FakeObjectStore();
    const key = `test-demo-agent:combo-miniapp:v1:${OWNER}`;
    db.tasksByKey.set(key, {
      id: newDemoSeedId(),
      owner: OWNER,
      meta: { source: 'real-upload' },
    });

    await expect(seedComboMiniapp(db, objectStore, OWNER)).rejects.toThrow(
      'demo seed idempotency conflict',
    );
    expect(db.uploads.size).toBe(0);
    expect(db.capabilities.size).toBe(0);
    expect(db.tasksByKey.get(key)?.meta).toEqual({ source: 'real-upload' });
    expect(db.sqlLog.some((sql) => sql.includes('meta @> $5::jsonb'))).toBe(true);
    expect(COMBO_MINIAPP_DEMO_MARKER).toMatchObject({
      source: 'test-demo',
      fixture: 'combo-miniapp',
      fixtureVersion: 1,
    });
  });
});
