import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  availableBalance,
  ledgerIdempotencyKeys,
  persistedMeteringIdempotencyKey,
  splitDeduction,
  type WalletView,
} from '../service.js';
import { createFakeBillingStore } from './fakes.js';

const USER = randomUUID();
const AGENT = 'agent-a';
const LIMIT = 500;

function makeStore(now?: () => number) {
  return createFakeBillingStore(now);
}

function seedWallet(
  state: ReturnType<typeof makeStore>['state'],
  userId: string,
  wallet: { principalBalance: number; bonusBalance: number; heldAmount: number },
) {
  state.wallets.set(userId, { ...wallet });
}

describe('pure accounting helpers', () => {
  it('available balance is principal plus bonus minus held', () => {
    const wallet: WalletView = {
      userId: USER,
      principalBalance: 1000,
      bonusBalance: 200,
      heldAmount: 300,
    };
    expect(availableBalance(wallet)).toBe(900);
  });

  it('splitDeduction drains the bonus bucket before the principal bucket', () => {
    const base = { userId: USER, heldAmount: 0 };
    expect(splitDeduction({ ...base, principalBalance: 1000, bonusBalance: 200 }, 500)).toEqual({
      bonus: 200,
      principal: 300,
    });
    expect(splitDeduction({ ...base, principalBalance: 1000, bonusBalance: 200 }, 100)).toEqual({
      bonus: 100,
      principal: 0,
    });
    expect(splitDeduction({ ...base, principalBalance: 1000, bonusBalance: 0 }, 100)).toEqual({
      bonus: 0,
      principal: 100,
    });
    expect(splitDeduction({ ...base, principalBalance: 1000, bonusBalance: -50 }, 100)).toEqual({
      bonus: 0,
      principal: 100,
    });
    expect(() => splitDeduction({ ...base, principalBalance: 0, bonusBalance: 0 }, -1)).toThrow(
      TypeError,
    );
  });

  it('ledger idempotency keys are deterministic per action', () => {
    expect(ledgerIdempotencyKeys.hold('agent-a', 't1')).toMatch(/^hold:v1:[0-9a-f]{64}$/);
    expect(ledgerIdempotencyKeys.hold('agent-a', 't1')).toBe(
      ledgerIdempotencyKeys.hold('agent-a', 't1'),
    );
    expect(ledgerIdempotencyKeys.hold('agent-a', 't2')).not.toBe(
      ledgerIdempotencyKeys.hold('agent-a', 't1'),
    );
    expect(ledgerIdempotencyKeys.settle('h1', 'bonus')).toBe('settle:h1:bonus');
    expect(ledgerIdempotencyKeys.release('h1')).toBe('release:h1');
    expect(ledgerIdempotencyKeys.recharge('settle:h1:bonus')).toMatch(/^recharge:v1:[0-9a-f]{64}$/);
    expect(persistedMeteringIdempotencyKey('meter:estimated:v1:h1')).toMatch(
      /^meter-reported:v1:[0-9a-f]{64}$/,
    );
  });
});

describe('hold / settle accounting discipline', () => {
  it('replayed holds return the original hold without freezing twice', async () => {
    const { store, state } = makeStore();
    seedWallet(state, USER, { principalBalance: 1000, bonusBalance: 0, heldAmount: 0 });

    const first = await store.createHold({
      userId: USER,
      agentId: AGENT,
      turnId: 'turn-1',
      estimatedAmount: 300,
      overdraftHardLimitCents: LIMIT,
    });
    const second = await store.createHold({
      userId: USER,
      agentId: AGENT,
      turnId: 'turn-1',
      estimatedAmount: 300,
      overdraftHardLimitCents: LIMIT,
    });

    expect(first.kind).toBe('held');
    expect(second.kind).toBe('held');
    if (first.kind !== 'held' || second.kind !== 'held') return;
    expect(second.hold.id).toBe(first.hold.id);
    expect(second.replayed).toBe(true);
    expect(state.wallets.get(USER)!.heldAmount).toBe(300);
    expect(state.ledger).toHaveLength(1);
  });

  it('rejects hold key reuse with a different user, amount, or terminal state', async () => {
    const otherUser = randomUUID();
    const { store, state } = makeStore();
    seedWallet(state, USER, { principalBalance: 1000, bonusBalance: 0, heldAmount: 0 });
    seedWallet(state, otherUser, { principalBalance: 1000, bonusBalance: 0, heldAmount: 0 });
    const input = {
      userId: USER,
      agentId: AGENT,
      turnId: 'turn-conflict',
      estimatedAmount: 100,
      overdraftHardLimitCents: LIMIT,
    };
    const created = await store.createHold(input);
    if (created.kind !== 'held') throw new Error('hold failed');

    await expect(store.createHold({ ...input, userId: otherUser })).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    await expect(store.createHold({ ...input, estimatedAmount: 101 })).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    await store.settleHold({ holdId: created.hold.id, actualAmount: 80 });
    await expect(store.createHold(input)).resolves.toEqual({
      kind: 'conflict',
      reason: 'terminal_replay',
    });
    expect(state.wallets.get(otherUser)!.heldAmount).toBe(0);
    expect(state.ledger.filter((entry) => entry.kind === 'hold')).toHaveLength(1);
  });

  it('rejects with 402 semantics when available balance is short', async () => {
    const { store, state } = makeStore();
    seedWallet(state, USER, { principalBalance: 100, bonusBalance: 50, heldAmount: 100 });

    const outcome = await store.createHold({
      userId: USER,
      agentId: AGENT,
      turnId: 'turn-2',
      estimatedAmount: 100,
      overdraftHardLimitCents: LIMIT,
    });
    expect(outcome.kind).toBe('insufficient');
    if (outcome.kind !== 'insufficient') return;
    expect(availableBalance(outcome.wallet)).toBe(50);
  });

  it('hard-stops new holds once the net balance is below the overdraft limit', async () => {
    const { store, state } = makeStore();
    seedWallet(state, USER, { principalBalance: -501, bonusBalance: 0, heldAmount: 0 });

    const blocked = await store.createHold({
      userId: USER,
      agentId: AGENT,
      turnId: 'turn-3',
      estimatedAmount: 1,
      overdraftHardLimitCents: LIMIT,
    });
    expect(blocked.kind).toBe('overdraft_blocked');

    state.wallets.get(USER)!.principalBalance = -500;
    const allowed = await store.createHold({
      userId: USER,
      agentId: AGENT,
      turnId: 'turn-4',
      estimatedAmount: 1,
      overdraftHardLimitCents: LIMIT,
    });
    expect(allowed.kind).toBe('insufficient');
  });

  it('settles bonus-first, releases the difference, and replays without double charging', async () => {
    const { store, state } = makeStore();
    seedWallet(state, USER, { principalBalance: 1000, bonusBalance: 200, heldAmount: 0 });

    const held = await store.createHold({
      userId: USER,
      agentId: AGENT,
      turnId: 'turn-5',
      estimatedAmount: 500,
      overdraftHardLimitCents: LIMIT,
    });
    if (held.kind !== 'held') throw new Error('hold failed');

    const settled = await store.settleHold({ holdId: held.hold.id, actualAmount: 300 });
    expect(settled.kind).toBe('settled');
    if (settled.kind !== 'settled') return;
    expect(settled.deductions).toEqual({ bonus: 200, principal: 100 });
    expect(settled.replayed).toBe(false);
    expect(settled.estimatedUsageRecorded).toBe(true);

    const wallet = state.wallets.get(USER)!;
    expect(wallet).toEqual({ principalBalance: 900, bonusBalance: 0, heldAmount: 0 });

    const consumeEntries = state.ledger.filter((entry) => entry.kind === 'consume');
    expect(consumeEntries).toHaveLength(2);
    expect(consumeEntries.map((entry) => [entry.bucket, entry.amount]).sort()).toEqual([
      ['bonus', -200],
      ['principal', -100],
    ]);

    const replay = await store.settleHold({ holdId: held.hold.id, actualAmount: 300 });
    expect(replay.kind).toBe('settled');
    if (replay.kind !== 'settled') return;
    expect(replay.replayed).toBe(true);
    expect(replay.deductions).toEqual({ bonus: 200, principal: 100 });
    expect(replay.estimatedUsageRecorded).toBe(true);
    expect(state.wallets.get(USER)).toEqual(wallet);
    expect(state.ledger.filter((entry) => entry.kind === 'consume')).toHaveLength(2);
    await expect(store.settleHold({ holdId: held.hold.id, actualAmount: 301 })).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
  });

  it('does not record an estimated usage row when real usage exists for the turn', async () => {
    const { store, state } = makeStore();
    seedWallet(state, USER, { principalBalance: 1000, bonusBalance: 0, heldAmount: 0 });
    const held = await store.createHold({
      userId: USER,
      agentId: AGENT,
      turnId: 'turn-6',
      estimatedAmount: 100,
      overdraftHardLimitCents: LIMIT,
    });
    if (held.kind !== 'held') throw new Error('hold failed');

    await store.insertMeteringEvent({
      agentId: AGENT,
      userId: USER,
      turnId: 'turn-6',
      holdId: held.hold.id,
      dimension: 'llm_token_out',
      quantity: 42,
      source: 'gateway',
      idempotencyKey: 'meter-test-turn-6-output',
    });
    const settled = await store.settleHold({ holdId: held.hold.id, actualAmount: 100 });
    if (settled.kind !== 'settled') throw new Error('settle failed');
    expect(settled.estimatedUsageRecorded).toBe(false);
    expect(state.metering.filter((event) => event.source === 'estimated')).toHaveLength(0);
  });

  it('binds metering idempotency to the exact active hold scope', async () => {
    const { store, state } = makeStore();
    seedWallet(state, USER, { principalBalance: 1000, bonusBalance: 0, heldAmount: 0 });
    const held = await store.createHold({
      userId: USER,
      agentId: AGENT,
      turnId: 'turn-meter',
      estimatedAmount: 100,
      overdraftHardLimitCents: LIMIT,
    });
    if (held.kind !== 'held') throw new Error('hold failed');
    const event = {
      agentId: AGENT,
      userId: USER,
      turnId: 'turn-meter',
      holdId: held.hold.id,
      dimension: 'llm_token_out' as const,
      quantity: 42,
      model: 'model-a',
      unitCost: 2,
      source: 'gateway' as const,
      idempotencyKey: 'meter-turn-meter-output',
    };

    const first = await store.insertMeteringEvent(event);
    expect(first).toMatchObject({ kind: 'recorded', replayed: false });
    await expect(store.insertMeteringEvent(event)).resolves.toMatchObject({
      kind: 'recorded',
      replayed: true,
      id: first.kind === 'recorded' ? first.id : '',
    });
    await expect(store.insertMeteringEvent({ ...event, quantity: 43 })).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    await expect(
      store.insertMeteringEvent({
        ...event,
        userId: randomUUID(),
        idempotencyKey: 'meter-wrong-scope',
      }),
    ).resolves.toEqual({ kind: 'conflict', reason: 'hold_scope_mismatch' });

    await store.settleHold({ holdId: held.hold.id, actualAmount: 10 });
    await expect(
      store.insertMeteringEvent({ ...event, idempotencyKey: 'meter-after-settle' }),
    ).resolves.toEqual({ kind: 'conflict', reason: 'hold_not_active' });
    expect(state.metering.filter((row) => row.source === 'gateway')).toHaveLength(1);
  });

  it('rejects settling a released or expired hold', async () => {
    let clock = 1_000_000;
    const { store, state } = makeStore(() => clock);
    seedWallet(state, USER, { principalBalance: 1000, bonusBalance: 0, heldAmount: 0 });
    const held = await store.createHold({
      userId: USER,
      agentId: AGENT,
      turnId: 'turn-7',
      estimatedAmount: 100,
      overdraftHardLimitCents: LIMIT,
    });
    if (held.kind !== 'held') throw new Error('hold failed');

    clock += 6 * 60 * 1000;
    expect(await store.sweepExpiredHolds({ limit: 100 })).toBe(1);

    const outcome = await store.settleHold({ holdId: held.hold.id, actualAmount: 100 });
    expect(outcome.kind).toBe('invalid_state');
    if (outcome.kind !== 'invalid_state') return;
    expect(outcome.hold.status).toBe('expired');
  });
});

describe('hold sweeper', () => {
  it('expires overdue holds, unfreezes the wallet, and appends release entries', async () => {
    let clock = 1_000_000;
    const { store, state } = makeStore(() => clock);
    seedWallet(state, USER, { principalBalance: 1000, bonusBalance: 0, heldAmount: 0 });

    const fresh = await store.createHold({
      userId: USER,
      agentId: AGENT,
      turnId: 'turn-8',
      estimatedAmount: 100,
      overdraftHardLimitCents: LIMIT,
    });
    const stale = await store.createHold({
      userId: USER,
      agentId: AGENT,
      turnId: 'turn-9',
      estimatedAmount: 200,
      overdraftHardLimitCents: LIMIT,
    });
    if (fresh.kind !== 'held' || stale.kind !== 'held') throw new Error('hold failed');

    clock += 4 * 60 * 1000;
    expect(await store.sweepExpiredHolds({ limit: 100 })).toBe(0);
    clock += 2 * 60 * 1000;
    expect(await store.sweepExpiredHolds({ limit: 100 })).toBe(2);
    // 二次清扫无重复动作。
    expect(await store.sweepExpiredHolds({ limit: 100 })).toBe(0);

    expect(state.wallets.get(USER)!.heldAmount).toBe(0);
    expect(state.holds.get(fresh.hold.id)!.status).toBe('expired');
    expect(state.holds.get(stale.hold.id)!.status).toBe('expired');
    expect(state.ledger.filter((entry) => entry.kind === 'release')).toHaveLength(2);
  });
});

describe('admin recharge', () => {
  it('credits the principal bucket and replays by idempotency key', async () => {
    const { store, state } = makeStore();

    const first = await store.adminRecharge({
      userId: USER,
      amount: 1000,
      idempotencyKey: 'admin-recharge-1',
      refId: 'ops-ticket-1',
    });
    if (first.kind !== 'credited') throw new Error('recharge failed');
    expect(first.replayed).toBe(false);
    expect(first.wallet.principalBalance).toBe(1000);

    const replay = await store.adminRecharge({
      userId: USER,
      amount: 1000,
      idempotencyKey: 'admin-recharge-1',
      refId: 'ops-ticket-1',
    });
    if (replay.kind !== 'credited') throw new Error('recharge replay failed');
    expect(replay.replayed).toBe(true);
    expect(replay.wallet.principalBalance).toBe(1000);
    expect(state.ledger.filter((entry) => entry.kind === 'recharge')).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      kind: 'recharge',
      bucket: 'principal',
      amount: 1000,
      refId: 'ops-ticket-1',
    });
  });

  it('rejects recharge key reuse with a different user, amount, or reference', async () => {
    const otherUser = randomUUID();
    const { store, state } = makeStore();
    const original = {
      userId: USER,
      amount: 1000,
      idempotencyKey: 'admin-recharge-conflict',
      refId: 'ops-ticket-1',
    };
    const first = await store.adminRecharge(original);
    expect(first.kind).toBe('credited');

    for (const changed of [
      { ...original, userId: otherUser },
      { ...original, amount: 1001 },
      { ...original, refId: 'ops-ticket-2' },
      { userId: USER, amount: 1000, idempotencyKey: original.idempotencyKey },
    ]) {
      await expect(store.adminRecharge(changed)).resolves.toEqual({
        kind: 'conflict',
        reason: 'idempotency_mismatch',
      });
    }
    expect(state.wallets.get(USER)!.principalBalance).toBe(1000);
    expect(state.wallets.has(otherUser)).toBe(false);
    expect(state.ledger.filter((entry) => entry.kind === 'recharge')).toHaveLength(1);
  });

  it('rejects a recharge that would make a wallet unsafe to represent', async () => {
    const { store, state } = makeStore();
    seedWallet(state, USER, {
      principalBalance: Number.MAX_SAFE_INTEGER,
      bonusBalance: 0,
      heldAmount: 0,
    });

    await expect(
      store.adminRecharge({
        userId: USER,
        amount: 1,
        idempotencyKey: 'admin-recharge-overflow',
      }),
    ).resolves.toEqual({ kind: 'conflict', reason: 'balance_range_exceeded' });
    expect(state.wallets.get(USER)!.principalBalance).toBe(Number.MAX_SAFE_INTEGER);
    expect(state.ledger).toHaveLength(0);
  });
});
