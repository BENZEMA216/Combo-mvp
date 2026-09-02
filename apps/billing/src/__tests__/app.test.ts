import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createFakeBillingStore } from './fakes.js';

const INTERNAL = 'internal-token-0123456789';
const ADMIN = 'admin-token-0123456789';
const USER = randomUUID();
const AGENT = 'agent-a';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function makeApp(now?: () => number) {
  const { store, state } = createFakeBillingStore(now);
  app = await buildApp({
    store,
    internalToken: INTERNAL,
    adminToken: ADMIN,
    overdraftHardLimitCents: 500,
  });
  return { app, state };
}

const internalAuth = { authorization: `Bearer ${INTERNAL}` };
const adminAuth = { authorization: `Bearer ${ADMIN}` };

async function recharge(instance: FastifyInstance, amount: number, key: string) {
  return instance.inject({
    method: 'POST',
    url: '/billing/admin/recharges',
    headers: adminAuth,
    payload: { user_id: USER, amount, idempotency_key: key },
  });
}

async function hold(instance: FastifyInstance, turnId: string, estimatedAmount: number) {
  return instance.inject({
    method: 'POST',
    url: '/billing/holds',
    headers: internalAuth,
    payload: { user_id: USER, agent_id: AGENT, turn_id: turnId, estimated_amount: estimatedAmount },
  });
}

describe('billing auth guards', () => {
  it('rejects missing or wrong bearer tokens on every protected route', async () => {
    const { app: instance } = await makeApp();

    const protectedCalls: Array<() => Promise<unknown>> = [
      () => instance.inject({ method: 'GET', url: `/billing/wallets/${USER}` }),
      () =>
        instance.inject({
          method: 'POST',
          url: '/billing/holds',
          payload: { user_id: USER, agent_id: AGENT, turn_id: 't1', estimated_amount: 100 },
        }),
      () =>
        instance.inject({
          method: 'POST',
          url: '/billing/settlements',
          payload: { hold_id: randomUUID(), actual_amount: 1 },
        }),
      () =>
        instance.inject({
          method: 'POST',
          url: '/metering/events',
          payload: {
            agent_id: AGENT,
            user_id: USER,
            turn_id: 't1',
            dimension: 'llm_token_in',
            quantity: 1,
            source: 'gateway',
          },
        }),
      () =>
        instance.inject({
          method: 'POST',
          url: '/billing/admin/recharges',
          payload: { user_id: USER, amount: 100, idempotency_key: 'k1' },
        }),
    ];
    for (const call of protectedCalls) {
      const response = (await call()) as { statusCode: number };
      expect(response.statusCode).toBe(401);
    }

    const wrongToken = await instance.inject({
      method: 'GET',
      url: `/billing/wallets/${USER}`,
      headers: { authorization: 'Bearer wrong-token-value' },
    });
    expect(wrongToken.statusCode).toBe(401);

    // 管理路由不接受内部 token，反之亦然。
    const cross = await instance.inject({
      method: 'POST',
      url: '/billing/admin/recharges',
      headers: internalAuth,
      payload: { user_id: USER, amount: 100, idempotency_key: 'k2' },
    });
    expect(cross.statusCode).toBe(401);
    const crossBack = await instance.inject({
      method: 'GET',
      url: `/billing/wallets/${USER}`,
      headers: adminAuth,
    });
    expect(crossBack.statusCode).toBe(401);
  });
});

describe('billing HTTP flow', () => {
  it('runs recharge → hold → settle end to end with idempotent replays', async () => {
    const { app: instance, state } = await makeApp();

    const emptyWallet = await instance.inject({
      method: 'GET',
      url: `/billing/wallets/${USER}`,
      headers: internalAuth,
    });
    expect(emptyWallet.statusCode).toBe(200);
    expect(emptyWallet.json()).toMatchObject({
      data: { principalBalance: 0, bonusBalance: 0, heldAmount: 0, availableBalance: 0 },
    });

    const credited = await recharge(instance, 10_000, 'seed-1');
    expect(credited.statusCode).toBe(201);
    expect(credited.json()).toMatchObject({
      data: { replayed: false, wallet: { principalBalance: 10_000 } },
    });

    const creditedReplay = await recharge(instance, 10_000, 'seed-1');
    expect(creditedReplay.statusCode).toBe(200);
    expect(creditedReplay.json()).toMatchObject({ data: { replayed: true } });

    const held = await hold(instance, 'turn-1', 400);
    expect(held.statusCode).toBe(201);
    const heldBody = held.json() as {
      data: { hold_id: string; status: string; replayed: boolean };
    };
    expect(heldBody.data).toMatchObject({ status: 'held', replayed: false });

    const heldReplay = await hold(instance, 'turn-1', 400);
    expect(heldReplay.statusCode).toBe(200);
    expect(heldReplay.json()).toMatchObject({
      data: { hold_id: heldBody.data.hold_id, replayed: true },
    });
    expect(state.wallets.get(USER)!.heldAmount).toBe(400);

    const settled = await instance.inject({
      method: 'POST',
      url: '/billing/settlements',
      headers: internalAuth,
      payload: { hold_id: heldBody.data.hold_id, actual_amount: 250 },
    });
    expect(settled.statusCode).toBe(200);
    expect(settled.json()).toMatchObject({
      data: {
        status: 'settled',
        actual_amount: 250,
        deductions: { bonus: 0, principal: 250 },
        released_amount: 150,
        estimated_usage_recorded: true,
        replayed: false,
      },
    });

    const settledReplay = await instance.inject({
      method: 'POST',
      url: '/billing/settlements',
      headers: internalAuth,
      payload: { hold_id: heldBody.data.hold_id, actual_amount: 250 },
    });
    expect(settledReplay.json()).toMatchObject({
      data: {
        replayed: true,
        deductions: { bonus: 0, principal: 250 },
        estimated_usage_recorded: true,
      },
    });

    const wallet = await instance.inject({
      method: 'GET',
      url: `/billing/wallets/${USER}`,
      headers: internalAuth,
    });
    expect(wallet.json()).toMatchObject({
      data: { principalBalance: 9750, heldAmount: 0, availableBalance: 9750 },
    });
  });

  it('returns 409 when an idempotency key changes payload or reopens a terminal turn', async () => {
    const otherUser = randomUUID();
    const { app: instance, state } = await makeApp();
    await recharge(instance, 1000, 'seed-conflict');
    const created = await hold(instance, 'turn-conflict', 100);
    const holdId = (created.json() as { data: { hold_id: string } }).data.hold_id;

    const changedAmount = await hold(instance, 'turn-conflict', 101);
    expect(changedAmount.statusCode).toBe(409);
    expect(changedAmount.json()).toMatchObject({ data: { reason: 'idempotency_mismatch' } });
    const changedUser = await instance.inject({
      method: 'POST',
      url: '/billing/holds',
      headers: internalAuth,
      payload: {
        user_id: otherUser,
        agent_id: AGENT,
        turn_id: 'turn-conflict',
        estimated_amount: 100,
      },
    });
    expect(changedUser.statusCode).toBe(409);

    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/billing/settlements',
          headers: internalAuth,
          payload: { hold_id: holdId, actual_amount: 80 },
        })
      ).statusCode,
    ).toBe(200);
    const changedSettle = await instance.inject({
      method: 'POST',
      url: '/billing/settlements',
      headers: internalAuth,
      payload: { hold_id: holdId, actual_amount: 81 },
    });
    expect(changedSettle.statusCode).toBe(409);
    const terminalReplay = await hold(instance, 'turn-conflict', 100);
    expect(terminalReplay.statusCode).toBe(409);
    expect(terminalReplay.json()).toMatchObject({ data: { reason: 'terminal_replay' } });

    const rechargeConflict = await recharge(instance, 1001, 'seed-conflict');
    expect(rechargeConflict.statusCode).toBe(409);
    expect(state.wallets.get(USER)!.principalBalance).toBe(920);
  });

  it('answers 402 with the current wallet when balance is insufficient', async () => {
    const { app: instance } = await makeApp();
    await recharge(instance, 100, 'seed-2');

    const response = await hold(instance, 'turn-x', 500);
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      error: { code: 'payment_required' },
      data: { reason: 'insufficient', wallet: { principalBalance: 100, availableBalance: 100 } },
    });
  });

  it('returns 404 for unknown holds and 409 for non-held holds', async () => {
    const { app: instance } = await makeApp();

    const missing = await instance.inject({
      method: 'POST',
      url: '/billing/settlements',
      headers: internalAuth,
      payload: { hold_id: randomUUID(), actual_amount: 1 },
    });
    expect(missing.statusCode).toBe(404);

    await recharge(instance, 1000, 'seed-3');
    const held = await hold(instance, 'turn-y', 100);
    const holdId = (held.json() as { data: { hold_id: string } }).data.hold_id;
    await instance.inject({
      method: 'POST',
      url: '/billing/settlements',
      headers: internalAuth,
      payload: { hold_id: holdId, actual_amount: 100 },
    });
    // 已 settled 重放是幂等成功；手动构造 expired 只能靠清扫，走 invalid_state 分支在 service 测试覆盖。
    const replay = await instance.inject({
      method: 'POST',
      url: '/billing/settlements',
      headers: internalAuth,
      payload: { hold_id: holdId, actual_amount: 100 },
    });
    expect(replay.statusCode).toBe(200);
  });

  it('accepts metering events and links them to holds', async () => {
    const { app: instance, state } = await makeApp();
    await recharge(instance, 1000, 'seed-4');
    const held = await hold(instance, 'turn-z', 100);
    const holdId = (held.json() as { data: { hold_id: string } }).data.hold_id;

    const event = await instance.inject({
      method: 'POST',
      url: '/metering/events',
      headers: internalAuth,
      payload: {
        agent_id: AGENT,
        user_id: USER,
        turn_id: 'turn-z',
        hold_id: holdId,
        dimension: 'llm_token_out',
        quantity: 128,
        model: 'deepseek-chat',
        unit_cost: 1,
        source: 'gateway',
        idempotency_key: 'meter-turn-z-output',
      },
    });
    expect(event.statusCode).toBe(201);
    const eventId = (event.json() as { data: { id: string } }).data.id;

    const replay = await instance.inject({
      method: 'POST',
      url: '/metering/events',
      headers: internalAuth,
      payload: {
        agent_id: AGENT,
        user_id: USER,
        turn_id: 'turn-z',
        hold_id: holdId,
        dimension: 'llm_token_out',
        quantity: 128,
        model: 'deepseek-chat',
        unit_cost: 1,
        source: 'gateway',
        idempotency_key: 'meter-turn-z-output',
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ data: { id: eventId, replayed: true } });

    const mismatch = await instance.inject({
      method: 'POST',
      url: '/metering/events',
      headers: internalAuth,
      payload: {
        agent_id: AGENT,
        user_id: USER,
        turn_id: 'turn-z',
        hold_id: holdId,
        dimension: 'llm_token_out',
        quantity: 129,
        model: 'deepseek-chat',
        unit_cost: 1,
        source: 'gateway',
        idempotency_key: 'meter-turn-z-output',
      },
    });
    expect(mismatch.statusCode).toBe(409);

    const settled = await instance.inject({
      method: 'POST',
      url: '/billing/settlements',
      headers: internalAuth,
      payload: { hold_id: holdId, actual_amount: 100 },
    });
    expect(settled.json()).toMatchObject({ data: { estimated_usage_recorded: false } });
    expect(state.metering.filter((row) => row.source === 'estimated')).toHaveLength(0);
    expect(state.metering.filter((row) => row.source === 'gateway')).toHaveLength(1);
  });

  it('validates request shapes with 400', async () => {
    const { app: instance } = await makeApp();

    const badUser = await instance.inject({
      method: 'GET',
      url: '/billing/wallets/not-a-uuid',
      headers: internalAuth,
    });
    expect(badUser.statusCode).toBe(400);

    const badHold = await instance.inject({
      method: 'POST',
      url: '/billing/holds',
      headers: internalAuth,
      payload: { user_id: USER, agent_id: 'UPPER', turn_id: 't', estimated_amount: 1 },
    });
    expect(badHold.statusCode).toBe(400);

    const controlCharacterTurn = await instance.inject({
      method: 'POST',
      url: '/billing/holds',
      headers: internalAuth,
      payload: { user_id: USER, agent_id: AGENT, turn_id: 'turn\n2', estimated_amount: 1 },
    });
    expect(controlCharacterTurn.statusCode).toBe(400);

    const loneSurrogateTurn = await instance.inject({
      method: 'POST',
      url: '/billing/holds',
      headers: internalAuth,
      payload: { user_id: USER, agent_id: AGENT, turn_id: 'turn\ud800', estimated_amount: 1 },
    });
    expect(loneSurrogateTurn.statusCode).toBe(400);

    const negativeAmount = await instance.inject({
      method: 'POST',
      url: '/billing/holds',
      headers: internalAuth,
      payload: { user_id: USER, agent_id: AGENT, turn_id: 't', estimated_amount: -5 },
    });
    expect(negativeAmount.statusCode).toBe(400);

    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    const unsafeRequests = [
      instance.inject({
        method: 'POST',
        url: '/billing/holds',
        headers: internalAuth,
        payload: {
          user_id: USER,
          agent_id: AGENT,
          turn_id: 'unsafe-hold',
          estimated_amount: unsafeInteger,
        },
      }),
      instance.inject({
        method: 'POST',
        url: '/billing/settlements',
        headers: internalAuth,
        payload: { hold_id: randomUUID(), actual_amount: unsafeInteger },
      }),
      instance.inject({
        method: 'POST',
        url: '/metering/events',
        headers: internalAuth,
        payload: {
          agent_id: AGENT,
          user_id: USER,
          turn_id: 'unsafe-meter-quantity',
          dimension: 'llm_token_in',
          quantity: unsafeInteger,
          source: 'gateway',
          idempotency_key: 'unsafe-meter-quantity',
        },
      }),
      instance.inject({
        method: 'POST',
        url: '/metering/events',
        headers: internalAuth,
        payload: {
          agent_id: AGENT,
          user_id: USER,
          turn_id: 'unsafe-meter-cost',
          dimension: 'llm_token_in',
          quantity: 1,
          unit_cost: unsafeInteger,
          source: 'gateway',
          idempotency_key: 'unsafe-meter-cost',
        },
      }),
      instance.inject({
        method: 'POST',
        url: '/billing/admin/recharges',
        headers: adminAuth,
        payload: { user_id: USER, amount: unsafeInteger, idempotency_key: 'unsafe-recharge' },
      }),
    ];
    for (const response of await Promise.all(unsafeRequests)) {
      expect(response.statusCode).toBe(400);
    }

    const badDimension = await instance.inject({
      method: 'POST',
      url: '/metering/events',
      headers: internalAuth,
      payload: {
        agent_id: AGENT,
        user_id: USER,
        turn_id: 't',
        dimension: 'not_a_dimension',
        quantity: 1,
        source: 'gateway',
      },
    });
    expect(badDimension.statusCode).toBe(400);

    // estimated 只能由 settle 兜底写入，外部上报不接受。
    const estimatedSource = await instance.inject({
      method: 'POST',
      url: '/metering/events',
      headers: internalAuth,
      payload: {
        agent_id: AGENT,
        user_id: USER,
        turn_id: 't',
        dimension: 'llm_token_in',
        quantity: 1,
        source: 'estimated',
      },
    });
    expect(estimatedSource.statusCode).toBe(400);
  });

  it('reports health and readiness', async () => {
    const { app: instance } = await makeApp();
    const health = await instance.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const ready = await instance.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
  });
});
