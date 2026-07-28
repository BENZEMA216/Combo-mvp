import { describe, expect, it } from 'vitest';
import type { CapabilityDefinition } from '@cb/shared';
import { createTurnRunner } from '../modules/agent/run-turn.js';
import { finishTurnCas, TURN_ABANDON_AFTER_MS } from '../modules/agent/turn-repo.js';
import { UsageRequestConflictError } from '../modules/billing/service.js';
import { createSession } from '../modules/session/repo.js';
import { createSessionEventBus } from '../platform/infra/event-bus.js';
import { createInterruptBus } from '../platform/infra/redis-interrupt-bus.js';
import {
  FakeDb,
  FakeObjectStore,
  FakeSessionEventLog,
  makeFakeAgentFactory,
  silentLog,
  waitFor,
  type FakeAgentScript,
} from './fakes.js';

const CREATOR = 'creator-user';
const CONSUMER = 'consumer-user';
const DEFINITION: CapabilityDefinition = {
  version: 1,
  name: '付费 Agent',
  summary: '用于验证计费',
  kind: 'writing',
  instructions: '完成任务。',
  inputs: [],
  starterPrompts: [],
  meta: {},
};

function usageId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

async function fixture(
  script: FakeAgentScript = {
    finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: '完成' }] }],
  },
  options: {
    ownerUserId?: string;
    freeUses?: number;
    unitPriceCents?: number;
    sweepIntervalMs?: number;
  } = {},
) {
  const db = new FakeDb();
  const ownerUserId = options.ownerUserId ?? CONSUMER;
  const capability = db.seedCapability({ owner_user_id: CREATOR, published: true });
  const session = await createSession(db, {
    capabilityId: capability.id,
    ownerUserId,
  });
  const handle = makeFakeAgentFactory(script);
  const eventLog = new FakeSessionEventLog();
  const interrupts = createInterruptBus();
  const runner = createTurnRunner({
    db,
    objectStore: new FakeObjectStore(),
    bus: createSessionEventBus(),
    eventLog,
    agentFactory: handle.factory,
    idleTimeoutMs: 60_000,
    interrupts,
    billingPolicy: {
      freeUses: options.freeUses ?? 3,
      unitPriceCents: options.unitPriceCents ?? 100,
    },
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
    log: silentLog,
  });
  const start = (sequence: number, text = `任务 ${sequence}`) =>
    runner.startTurn({
      session,
      definition: DEFINITION,
      text,
      usageId: usageId(sequence),
      capabilityOwnerUserId: CREATOR,
      log: silentLog,
    });
  return { db, capability, session, handle, eventLog, interrupts, runner, start };
}

async function waitForTerminalCount(db: FakeDb, count: number): Promise<void> {
  await waitFor(
    () => [...db.turns.values()].filter((turn) => turn.status !== 'running').length === count,
  );
}

function serializeTransactions(db: FakeDb): void {
  const originalConnect = db.connect.bind(db);
  let tail = Promise.resolve();
  db.connect = async () => {
    const connection = await originalConnect();
    const predecessor = tail;
    let unlock!: () => void;
    tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let ownsLock = false;
    let unlocked = false;
    const releaseLock = (): void => {
      if (!ownsLock || unlocked) return;
      unlocked = true;
      unlock();
    };
    return {
      query: async <R = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
        signal?: AbortSignal,
      ) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        if (normalized.startsWith('BEGIN')) {
          await predecessor;
          ownsLock = true;
        }
        const result = await connection.query<R>(sql, params, signal);
        if (normalized === 'COMMIT' || normalized === 'ROLLBACK') releaseLock();
        return result;
      },
      release: (destroy?: boolean) => {
        releaseLock();
        connection.release(destroy);
      },
    };
  };
}

describe('Agent 使用计费', () => {
  it('前三次成功使用免费，第四次余额不足且不创建 Turn、Message 或 Agent', async () => {
    const { db, handle, runner, start } = await fixture();
    for (let index = 1; index <= 3; index += 1) {
      expect((await start(index)).status).toBe('started');
      await waitForTerminalCount(db, index);
    }
    const turnCount = db.turns.size;
    const messageCount = db.messages.length;

    await expect(start(4)).resolves.toEqual({
      status: 'recharge_required',
      balanceCents: 0n,
      requiredCents: 100n,
    });
    expect(db.turns.size).toBe(turnCount);
    expect(db.messages).toHaveLength(messageCount);
    expect(handle.calls).toHaveLength(3);
    expect(db.billingFreeAllowances.values().next().value).toMatchObject({
      free_used_count: 3,
      free_reserved_count: 0,
    });
    await runner.dispose();
  });

  it('Capability owner 不消耗免费额度或钱包', async () => {
    const { db, runner, start } = await fixture(undefined, { ownerUserId: CREATOR });
    for (let index = 1; index <= 5; index += 1) {
      expect((await start(index)).status).toBe('started');
      await waitForTerminalCount(db, index);
    }
    expect(db.billingFreeAllowances.size).toBe(0);
    expect(db.billingAccounts.get(CREATOR)).toMatchObject({
      balance_cents: 0n,
      reserved_cents: 0n,
    });
    expect([...db.usageCharges.values()].map((charge) => charge.charge_source)).toEqual([
      'owner',
      'owner',
      'owner',
      'owner',
      'owner',
    ]);
    expect(db.walletLedger.size).toBe(0);
    await runner.dispose();
  });

  it('免费额度耗尽后从全局钱包结算一次并追加不可变 debit', async () => {
    const { db, runner, start } = await fixture();
    db.seedBillingAccount(CONSUMER, 300n);
    for (let index = 1; index <= 4; index += 1) {
      expect((await start(index)).status).toBe('started');
      await waitForTerminalCount(db, index);
    }
    expect(db.billingAccounts.get(CONSUMER)).toMatchObject({
      balance_cents: 200n,
      reserved_cents: 0n,
    });
    expect([...db.usageCharges.values()].at(-1)).toMatchObject({
      charge_source: 'wallet',
      status: 'completed',
      settled_cents: 100n,
    });
    expect([...db.walletLedger.values()]).toMatchObject([
      { entry_type: 'usage_debit', amount_cents: -100n },
    ]);
    await runner.dispose();
  });

  it('相同 usageId 重试返回原 Message，不重复启动；不同指纹拒绝', async () => {
    const { db, handle, runner, start } = await fixture();
    const first = await start(1, '同一任务');
    expect(first.status).toBe('started');
    await waitForTerminalCount(db, 1);
    const replay = await start(1, '同一任务');
    expect(replay.status).toBe('replayed');
    if (first.status !== 'recharge_required' && replay.status !== 'recharge_required') {
      expect(replay.userMessage.id).toBe(first.userMessage.id);
      expect(replay.userMessage.turnId).toBe(first.userMessage.turnId);
    }
    expect(db.turns.size).toBe(1);
    expect(handle.calls).toHaveLength(1);
    await expect(start(1, '篡改后的任务')).rejects.toBeInstanceOf(UsageRequestConflictError);
    await runner.dispose();
  });

  it('并发提交相同 usageId 时只有一个 Turn，另一请求重放原 Message', async () => {
    const context = await fixture({ hangUntilAbort: true });
    serializeTransactions(context.db);
    const [first, second] = await Promise.all([
      context.start(1, '并发任务'),
      context.start(1, '并发任务'),
    ]);
    expect([first.status, second.status].sort()).toEqual(['replayed', 'started']);
    expect(context.db.turns.size).toBe(1);
    await waitFor(() => context.handle.calls.length === 1);
    expect(context.handle.calls).toHaveLength(1);
    expect(await context.runner.interrupt(context.session.id)).toBe(true);
    await waitForTerminalCount(context.db, 1);
    await context.runner.dispose();
  });

  it('失败与人工打断都会释放钱包预留且不写 debit', async () => {
    const failed = await fixture({ promptError: new Error('model unavailable') }, { freeUses: 0 });
    failed.db.seedBillingAccount(CONSUMER, 100n);
    expect((await failed.start(1)).status).toBe('started');
    await waitForTerminalCount(failed.db, 1);
    expect(failed.db.billingAccounts.get(CONSUMER)).toMatchObject({
      balance_cents: 100n,
      reserved_cents: 0n,
    });
    expect([...failed.db.usageCharges.values()][0]?.status).toBe('released');
    expect(failed.db.walletLedger.size).toBe(0);
    await failed.runner.dispose();

    const interrupted = await fixture({ hangUntilAbort: true }, { freeUses: 0 });
    interrupted.db.seedBillingAccount(CONSUMER, 100n);
    expect((await interrupted.start(1)).status).toBe('started');
    await waitFor(() => interrupted.handle.calls.length === 1);
    expect(interrupted.db.billingAccounts.get(CONSUMER)).toMatchObject({
      balance_cents: 0n,
      reserved_cents: 100n,
    });
    expect(await interrupted.runner.interrupt(interrupted.session.id)).toBe(true);
    await waitForTerminalCount(interrupted.db, 1);
    expect(interrupted.db.billingAccounts.get(CONSUMER)).toMatchObject({
      balance_cents: 100n,
      reserved_cents: 0n,
    });
    expect(interrupted.db.walletLedger.size).toBe(0);
    await interrupted.runner.dispose();
  });

  it('关闭 Sandbox 的 peer 只确认精确 Turn 终态，并由 owner 释放钱包预留', async () => {
    const context = await fixture({ hangUntilAbort: true }, { freeUses: 0 });
    context.db.seedBillingAccount(CONSUMER, 100n);
    expect((await context.start(1)).status).toBe('started');
    await waitFor(() => context.handle.calls.length === 1);
    const runId = [...context.db.turns.values()][0]!.id;

    const peer = createTurnRunner({
      db: context.db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: context.eventLog,
      agentFactory: makeFakeAgentFactory().factory,
      idleTimeoutMs: 60_000,
      interrupts: context.interrupts,
      sandboxCleanupTimeoutMs: 500,
      billingPolicy: { freeUses: 0, unitPriceCents: 100 },
      log: silentLog,
    });

    expect(await peer.interrupt(context.session.id)).toBe(true);
    await waitForTerminalCount(context.db, 1);
    expect(context.db.turns.get(runId)?.status).toBe('interrupted');
    expect(context.db.billingAccounts.get(CONSUMER)).toMatchObject({
      balance_cents: 100n,
      reserved_cents: 0n,
    });
    expect([...context.db.usageCharges.values()][0]).toMatchObject({
      turn_id: runId,
      status: 'released',
    });
    expect(context.db.walletLedger.size).toBe(0);

    await peer.dispose();
    await context.runner.dispose();
  });

  it('Runtime 关停只在终态事务提交时释放钱包预留', async () => {
    const context = await fixture({ hangUntilAbort: true }, { freeUses: 0 });
    context.db.seedBillingAccount(CONSUMER, 100n);
    expect((await context.start(1)).status).toBe('started');
    await waitFor(() => context.handle.calls.length === 1);
    const runId = [...context.db.turns.values()][0]!.id;
    expect(context.db.billingAccounts.get(CONSUMER)).toMatchObject({
      balance_cents: 0n,
      reserved_cents: 100n,
    });

    await context.runner.dispose();

    expect(context.db.turns.get(runId)?.status).toBe('interrupted');
    expect(context.db.billingAccounts.get(CONSUMER)).toMatchObject({
      balance_cents: 100n,
      reserved_cents: 0n,
    });
    expect([...context.db.usageCharges.values()][0]).toMatchObject({
      turn_id: runId,
      status: 'released',
    });
    expect(context.db.walletLedger.size).toBe(0);
  });

  it('超时清扫先取得 Turn 终态栅栏，再释放钱包预留', async () => {
    const { db, runner, start } = await fixture(
      { hangUntilAbort: true },
      { freeUses: 0, sweepIntervalMs: 5 },
    );
    db.seedBillingAccount(CONSUMER, 100n);
    expect((await start(1)).status).toBe('started');
    const turn = [...db.turns.values()][0]!;
    turn.created_at = new Date(Date.now() - TURN_ABANDON_AFTER_MS - 1).toISOString();
    await waitFor(() => turn.status !== 'running');
    expect(db.billingAccounts.get(CONSUMER)).toMatchObject({
      balance_cents: 100n,
      reserved_cents: 0n,
    });
    expect([...db.usageCharges.values()][0]?.status).toBe('released');
    expect(db.walletLedger.size).toBe(0);
    await runner.dispose();
  });

  it('启动和周期补偿会按已有权威终态修复崩溃遗留的预留', async () => {
    const original = await fixture({ hangUntilAbort: true }, { freeUses: 0 });
    original.db.seedBillingAccount(CONSUMER, 100n);
    expect((await original.start(1)).status).toBe('started');
    const turn = [...original.db.turns.values()][0]!;
    expect(await finishTurnCas(original.db, { id: turn.id, status: 'failed' })).toBe(true);
    expect(original.db.billingAccounts.get(CONSUMER)?.reserved_cents).toBe(100n);

    const reconciler = createTurnRunner({
      db: original.db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: new FakeSessionEventLog(),
      agentFactory: makeFakeAgentFactory().factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      billingPolicy: { freeUses: 0, unitPriceCents: 100 },
      sweepIntervalMs: 5,
      log: silentLog,
    });
    await waitFor(() => original.db.billingAccounts.get(CONSUMER)?.reserved_cents === 0n);
    expect(original.db.billingAccounts.get(CONSUMER)?.balance_cents).toBe(100n);
    expect([...original.db.usageCharges.values()][0]?.status).toBe('released');
    await reconciler.dispose();
    await original.runner.dispose();
  });
});
