// 任务状态机服务自检：transition 乐观锁收口、建任务幂等、失败重试。忠实假 PG，无真库。
import { describe, it, expect } from 'vitest';
import {
  createTask,
  purgeExpiredUploadParts,
  reconcileExpiredUploadTasks,
  retryTask,
  transition,
} from '../modules/task/service.js';
import { verifyPairingCode } from '../modules/task/pairing.js';
import { RAW_BUCKET, partObjectKey } from '../modules/task/pairing.js';
import { listCreationResumeTaskViews, trackExpiredUploadOrphanKey } from '../modules/task/repo.js';
import { FakeDb, FakeObjectStore, FakeQueue } from './fakes.js';

const OWNER = 'user-me';
const OTHER = 'user-other';

async function seedTask(
  db: FakeDb,
  key = 'idem-key-000001',
): Promise<{ taskId: string; code: string }> {
  const out = await createTask(db, db, { ownerUserId: OWNER, idempotencyKey: key });
  if (out.kind !== 'ok') throw new Error('seed failed');
  return { taskId: out.taskId, code: out.pairingCode };
}

describe('createTask（幂等）', () => {
  it('首次创建：tasks+uploads 各一行，配对码明文只出现在返回值', async () => {
    const db = new FakeDb();
    const out = await createTask(db, db, {
      ownerUserId: OWNER,
      idempotencyKey: 'idem-key-000001',
      description: '第一次上传',
    });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.replayed).toBe(false);
    expect(out.pairingCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const task = db.tasks.get(out.taskId)!;
    expect(task.current_step).toBe('upload');
    expect(task.status).toBe('running');
    const upload = db.uploads.get(out.taskId)!;
    expect(upload.pairing_code_hash).not.toContain(out.pairingCode); // 库里只有哈希
  });

  it('同 key 同 owner 重试：返回同一任务 + 轮换出的新码可用、旧码作废', async () => {
    const db = new FakeDb();
    const first = await seedTask(db);
    const replay = await createTask(db, db, {
      ownerUserId: OWNER,
      idempotencyKey: 'idem-key-000001',
    });
    expect(replay.kind).toBe('ok');
    if (replay.kind !== 'ok') return;
    expect(replay.replayed).toBe(true);
    expect(replay.taskId).toBe(first.taskId); // 不建第二个任务
    expect(db.tasks.size).toBe(1);
    // 新码生效、旧码作废（哈希被轮换覆盖）。
    expect((await verifyPairingCode(db, replay.pairingCode)).ok).toBe(true);
    expect((await verifyPairingCode(db, first.code)).ok).toBe(false);
  });

  it('同 key 不同 owner → conflict（不暴露他人任务）', async () => {
    const db = new FakeDb();
    await seedTask(db);
    const out = await createTask(db, db, { ownerUserId: OTHER, idempotencyKey: 'idem-key-000001' });
    expect(out.kind).toBe('conflict');
  });
});

describe('transition（状态变更唯一入口，乐观锁）', () => {
  it('期望现态命中才更新；不命中 0 行拒绝、原行不动', async () => {
    const db = new FakeDb();
    const { taskId } = await seedTask(db);
    // 错误的期望现态（任务实际在 upload/running）。
    const miss = await transition(
      db,
      taskId,
      { step: 'extract', status: 'running' },
      { status: 'failed' },
    );
    expect(miss).toBe(false);
    expect(db.tasks.get(taskId)!.status).toBe('running');
    // 正确期望：upload→extract。
    const hit = await transition(
      db,
      taskId,
      { step: 'upload', status: 'running' },
      { step: 'extract' },
    );
    expect(hit).toBe(true);
    expect(db.tasks.get(taskId)!.current_step).toBe('extract');
  });

  it('任何 transition 都清掉租约（执行权随状态变更终结）', async () => {
    const db = new FakeDb();
    const { taskId } = await seedTask(db);
    const t = db.tasks.get(taskId)!;
    t.current_step = 'extract';
    t.lease_owner = 'worker-a#1';
    t.lease_expires_at = new Date(Date.now() + 60_000).toISOString();
    await transition(db, taskId, { step: 'extract', status: 'running' }, { status: 'failed' });
    expect(t.lease_owner).toBeNull();
    expect(t.lease_expires_at).toBeNull();
  });
});

describe('retryTask', () => {
  it('failed 才可重试：retry_count+1、清错误、回 running、extract 步重新入队', async () => {
    const db = new FakeDb();
    const queue = new FakeQueue();
    const { taskId } = await seedTask(db);
    const t = db.tasks.get(taskId)!;
    t.current_step = 'extract';
    t.status = 'failed';
    t.last_error = { userMessage: '上次挂了' };
    const out = await retryTask(db, queue, { taskId, ownerUserId: OWNER, traceId: 'tr' });
    expect(out.kind).toBe('ok');
    expect(t.status).toBe('running');
    expect(t.retry_count).toBe(1);
    expect(t.last_error).toBeNull();
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]!.taskId).toBe(taskId);
  });

  it('running 态不可重试；非 owner 视同不存在', async () => {
    const db = new FakeDb();
    const queue = new FakeQueue();
    const { taskId } = await seedTask(db);
    expect((await retryTask(db, queue, { taskId, ownerUserId: OWNER, traceId: 't' })).kind).toBe(
      'not_retriable',
    );
    expect((await retryTask(db, queue, { taskId, ownerUserId: OTHER, traceId: 't' })).kind).toBe(
      'not_found',
    );
    expect(queue.enqueued).toHaveLength(0);
  });

  it('upload 失败不可原地重试，避免用已过期配对码重新回到无限 running', async () => {
    const db = new FakeDb();
    const queue = new FakeQueue();
    const { taskId } = await seedTask(db);
    const t = db.tasks.get(taskId)!;
    t.status = 'failed';
    t.last_error = { userMessage: '上传等待已超时，请重新上传。' };

    const out = await retryTask(db, queue, {
      taskId,
      ownerUserId: OWNER,
      traceId: 't-upload-retry',
    });

    expect(out.kind).toBe('not_retriable');
    expect(t.status).toBe('failed');
    expect(queue.enqueued).toHaveLength(0);
  });
});

describe('reconcileExpiredUploadTasks', () => {
  it('配对过期的 upload/running 持久化为失败；新任务与其他 owner 不受影响', async () => {
    const db = new FakeDb();
    const expired = await seedTask(db, 'idem-expired');
    const fresh = await seedTask(db, 'idem-fresh');
    const other = await createTask(db, db, {
      ownerUserId: OTHER,
      idempotencyKey: 'idem-other',
    });
    if (other.kind !== 'ok') throw new Error('seed other failed');
    db.uploads.get(expired.taskId)!.pairing_expires_at = new Date(Date.now() - 1_000).toISOString();
    db.uploads.get(fresh.taskId)!.pairing_expires_at = new Date(Date.now() + 60_000).toISOString();
    db.uploads.get(other.taskId)!.pairing_expires_at = new Date(Date.now() - 1_000).toISOString();

    const repaired = await reconcileExpiredUploadTasks(db, {
      ownerUserId: OWNER,
      traceId: 'trace-expired-upload',
    });

    expect(repaired).toBe(1);
    const failed = db.tasks.get(expired.taskId)!;
    expect(failed.status).toBe('failed');
    expect(db.uploads.get(expired.taskId)!.status).toBe('expired');
    expect(failed.last_error).toEqual({
      userMessage: '上传等待已超时，请重新上传。',
      retriable: false,
      action: 'change_input',
      traceId: 'trace-expired-upload',
    });
    expect(db.tasks.get(fresh.taskId)!.status).toBe('running');
    expect(db.tasks.get(other.taskId)!.status).toBe('running');
  });

  it('完整清单虽已到期仍留给收齐流转，不被过期对账覆盖', async () => {
    const db = new FakeDb();
    const { taskId } = await seedTask(db, 'idem-complete');
    const upload = db.uploads.get(taskId)!;
    upload.parts = { total: 1, landed: { '0': partObjectKey(taskId, 0) } };
    upload.pairing_expires_at = new Date(Date.now() - 1_000).toISOString();

    const repaired = await reconcileExpiredUploadTasks(db, { traceId: 'trace-complete' });

    expect(repaired).toBe(0);
    expect(db.tasks.get(taskId)!.status).toBe('running');
    expect(upload.status).toBe('pending');
  });

  it('upload 已 raw 或配对窗口已延期时不覆盖新状态', async () => {
    const db = new FakeDb();
    const raw = await seedTask(db, 'idem-raw');
    const extended = await seedTask(db, 'idem-extended');
    db.uploads.get(raw.taskId)!.status = 'raw';
    db.uploads.get(raw.taskId)!.pairing_expires_at = new Date(Date.now() - 1_000).toISOString();
    db.uploads.get(extended.taskId)!.pairing_expires_at = new Date(
      Date.now() + 60_000,
    ).toISOString();

    const repaired = await reconcileExpiredUploadTasks(db, { traceId: 'trace-guarded' });

    expect(repaired).toBe(0);
    expect(db.tasks.get(raw.taskId)!.status).toBe('running');
    expect(db.tasks.get(extended.taskId)!.status).toBe('running');
  });

  it('失败转换由单条 CTE 同时落 upload=expired 与 task=failed', async () => {
    const db = new FakeDb();
    const { taskId } = await seedTask(db, 'idem-atomic');
    db.uploads.get(taskId)!.pairing_expires_at = new Date(Date.now() - 1_000).toISOString();

    const originalQuery = db.query.bind(db);
    const statements: string[] = [];
    db.query = (async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.includes("SET status = 'expired'")) statements.push(normalized);
      return originalQuery(sql, params);
    }) as typeof db.query;

    const repaired = await reconcileExpiredUploadTasks(db, { traceId: 'trace-atomic' });

    expect(repaired).toBe(1);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('FOR UPDATE OF t, u SKIP LOCKED');
    expect(db.uploads.get(taskId)!.status).toBe('expired');
    expect(db.tasks.get(taskId)!.status).toBe('failed');
  });
});

describe('listCreationResumeTaskViews', () => {
  it('有界返回 running 与所有可操作失败，不混入普通终态或其他 owner', async () => {
    const db = new FakeDb();
    const running = await seedTask(db, 'idem-resume-running');
    const retry = await seedTask(db, 'idem-resume-retry');
    const changeInput = await seedTask(db, 'idem-resume-change-input');
    const legacyExpired = await seedTask(db, 'idem-resume-legacy-expired');
    const waiting = await seedTask(db, 'idem-resume-waiting');
    const other = await createTask(db, db, {
      ownerUserId: OTHER,
      idempotencyKey: 'idem-resume-other',
    });
    if (other.kind !== 'ok') throw new Error('seed other failed');

    const runningRow = db.tasks.get(running.taskId)!;
    runningRow.updated_at = '2026-07-20T12:00:00.000Z';
    const retryRow = db.tasks.get(retry.taskId)!;
    retryRow.status = 'failed';
    retryRow.updated_at = '2026-07-22T12:00:00.000Z';
    retryRow.last_error = {
      userMessage: '可以重试',
      retriable: true,
      action: 'retry',
      traceId: 'trace-retry',
    };
    const changeInputRow = db.tasks.get(changeInput.taskId)!;
    changeInputRow.status = 'failed';
    changeInputRow.updated_at = '2026-07-21T12:00:00.000Z';
    changeInputRow.last_error = {
      userMessage: '请重新上传',
      retriable: false,
      action: 'change_input',
      traceId: 'trace-change-input',
    };
    const legacyExpiredRow = db.tasks.get(legacyExpired.taskId)!;
    legacyExpiredRow.status = 'failed';
    legacyExpiredRow.updated_at = '2026-07-21T18:00:00.000Z';
    legacyExpiredRow.last_error = null;
    db.uploads.get(legacyExpired.taskId)!.status = 'expired';
    const waitingRow = db.tasks.get(waiting.taskId)!;
    waitingRow.status = 'failed';
    waitingRow.updated_at = '2026-07-23T12:00:00.000Z';
    waitingRow.last_error = {
      userMessage: '后台处理中',
      retriable: false,
      action: 'wait',
      traceId: 'trace-wait',
    };

    const tasks = await listCreationResumeTaskViews(db, { ownerUserId: OWNER, limit: 3 });

    expect(tasks.map((task) => task.id)).toEqual([
      retry.taskId,
      legacyExpired.taskId,
      changeInput.taskId,
    ]);
  });

  it('没有可操作任务时只回退最近一条，供异步结果验收', async () => {
    const db = new FakeDb();
    const older = await seedTask(db, 'idem-resume-older');
    const latest = await seedTask(db, 'idem-resume-latest');
    const olderRow = db.tasks.get(older.taskId)!;
    olderRow.status = 'succeeded';
    olderRow.updated_at = '2026-07-20T12:00:00.000Z';
    const latestRow = db.tasks.get(latest.taskId)!;
    latestRow.status = 'failed';
    latestRow.updated_at = '2026-07-21T12:00:00.000Z';
    latestRow.last_error = {
      userMessage: '暂不可操作',
      retriable: false,
      action: 'none',
      traceId: 'trace-none',
    };

    const tasks = await listCreationResumeTaskViews(db, { ownerUserId: OWNER, limit: 20 });

    expect(tasks.map((task) => task.id)).toEqual([latest.taskId]);
  });
});

describe('purgeExpiredUploadParts', () => {
  it('删除全部已登记原始对象后才打 raw_purged_at，expired 状态保留', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const { taskId } = await seedTask(db, 'idem-purge-success');
    const key0 = partObjectKey(taskId, 0);
    const key1 = partObjectKey(taskId, 1);
    const upload = db.uploads.get(taskId)!;
    upload.status = 'expired';
    upload.parts = { total: 3, landed: { '0': key0, '1': key1 } };
    await store.putObject(RAW_BUCKET, key0, new TextEncoder().encode('part-0'));
    await store.putObject(RAW_BUCKET, key1, new TextEncoder().encode('part-1'));

    await expect(purgeExpiredUploadParts(db, store)).resolves.toEqual({
      purged: 1,
      failedTaskIds: [],
    });
    await expect(store.getObjectText(RAW_BUCKET, key0)).rejects.toThrow();
    await expect(store.getObjectText(RAW_BUCKET, key1)).rejects.toThrow();
    expect(upload.raw_purged_at).not.toBeNull();
    expect(upload.status).toBe('expired');
  });

  it('删除失败不打戳，下一轮可重试并最终完成', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const { taskId } = await seedTask(db, 'idem-purge-retry');
    const key = partObjectKey(taskId, 0);
    const upload = db.uploads.get(taskId)!;
    upload.status = 'expired';
    upload.parts = { total: 2, landed: { '0': key } };
    await store.putObject(RAW_BUCKET, key, new TextEncoder().encode('sensitive'));
    const realDelete = store.delete.bind(store);
    store.delete = async () => {
      throw new Error('minio unavailable');
    };

    await expect(purgeExpiredUploadParts(db, store)).resolves.toEqual({
      purged: 0,
      failedTaskIds: [taskId],
    });
    expect(upload.raw_purged_at).toBeNull();
    await expect(store.getObjectText(RAW_BUCKET, key)).resolves.toBe('sensitive');

    store.delete = realDelete;
    await expect(purgeExpiredUploadParts(db, store)).resolves.toEqual({
      purged: 1,
      failedTaskIds: [],
    });
    expect(upload.raw_purged_at).not.toBeNull();
    await expect(store.getObjectText(RAW_BUCKET, key)).rejects.toThrow();
  });

  it('清理期间并发新增 orphan 会推进版本，旧清单不得误打清理戳', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const { taskId } = await seedTask(db, 'idem-purge-version');
    const firstKey = partObjectKey(taskId, 0);
    const lateKey = partObjectKey(taskId, 1);
    const upload = db.uploads.get(taskId)!;
    upload.status = 'expired';
    upload.parts = { total: 2, landed: { '0': firstKey } };
    await store.putObject(RAW_BUCKET, firstKey, new TextEncoder().encode('first'));

    const realDelete = store.delete.bind(store);
    let injected = false;
    store.delete = async (bucket, key) => {
      await realDelete(bucket, key);
      if (!injected) {
        injected = true;
        await store.putObject(RAW_BUCKET, lateKey, new TextEncoder().encode('late'));
        await trackExpiredUploadOrphanKey(db, { taskId, objectKey: lateKey });
      }
    };

    // 候选读取的是 version 0；删除期间追加 lateKey 推进到 1，因此本轮不能打戳。
    await expect(purgeExpiredUploadParts(db, store)).resolves.toEqual({
      purged: 0,
      failedTaskIds: [],
    });
    expect(upload.raw_purged_at).toBeNull();
    expect(upload.meta).toMatchObject({
      expired_orphan_keys: [lateKey],
      expired_cleanup_version: 1,
    });
    await expect(store.getObjectText(RAW_BUCKET, lateKey)).resolves.toBe('late');

    store.delete = realDelete;
    await expect(purgeExpiredUploadParts(db, store)).resolves.toEqual({
      purged: 1,
      failedTaskIds: [],
    });
    expect(upload.raw_purged_at).not.toBeNull();
    await expect(store.getObjectText(RAW_BUCKET, lateKey)).rejects.toThrow();
  });
});
