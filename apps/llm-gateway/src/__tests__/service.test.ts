import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { usageToMeteringEvents } from '../billing.js';
import { amountFromUsage, estimateHoldAmount, parsePricingTable, priceFor } from '../pricing.js';
import { checkAndHold, finalizeTurn, parseChatRequest, releaseHold } from '../service.js';
import { createUsageExtractor } from '../usage.js';
import { createFakeBillingClient, createRecordingLog } from './fakes.js';

const USER = randomUUID();
const PLATFORM = { userId: USER, agentId: 'agent-a', turnId: 'turn-1' };
const PRICE = { input: 1, output: 2 }; // 分 / 百万 token

function validBody(extra: Record<string, unknown> = {}) {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    x_combo: { user_id: USER, agent_id: 'agent-a', turn_id: 'turn-1' },
    ...extra,
  };
}

describe('parseChatRequest', () => {
  it('strips the platform extension and forces include_usage on streams', () => {
    const parsed = parseChatRequest(validBody({ stream: true, temperature: 0.7 }), 4096);
    expect(parsed).not.toBeNull();
    expect(parsed!.platform).toEqual(PLATFORM);
    expect(parsed!.stream).toBe(true);
    expect(parsed!.maxTokens).toBe(4096);
    expect(parsed!.forwardBody).toEqual({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(parsed!.forwardBody).not.toHaveProperty('x_combo');
  });

  it('keeps caller max_tokens and rejects malformed bodies', () => {
    const withMax = parseChatRequest(validBody({ max_tokens: 512 }), 4096);
    expect(withMax!.maxTokens).toBe(512);

    for (const bad of [
      {},
      validBody({ x_combo: undefined }),
      validBody({ x_combo: { user_id: 'not-uuid', agent_id: 'agent-a', turn_id: 't' } }),
      validBody({ x_combo: { user_id: USER, agent_id: 'UPPER', turn_id: 't' } }),
      { ...validBody(), messages: [] },
      validBody({ max_tokens: -1 }),
    ]) {
      expect(parseChatRequest(bad, 4096), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('pricing', () => {
  it('parses the env pricing table and falls back to default', () => {
    const table = parsePricingTable(
      '{"default":{"input":1,"output":2},"deepseek-chat":{"input":1,"output":2}}',
    );
    expect(priceFor(table, 'deepseek-chat')).toEqual({ input: 1, output: 2 });
    expect(priceFor(table, 'unknown-model')).toEqual(table.default);

    for (const bad of ['not json', '[]', '{}', '{"default":{"input":-1,"output":2}}']) {
      expect(() => parsePricingTable(bad), bad).toThrow();
    }
  });

  it('estimates high-side holds and converts usage to cents', () => {
    // 4096 × 2 / 1e6 = 0.008192 分 → 进位 1，加固定成本 1。
    expect(estimateHoldAmount({ price: PRICE, maxTokens: 4096, fixedCostCents: 1 })).toBe(2);
    // 1_000_000 in × 1 + 500_000 out × 2 = 2 分。
    expect(amountFromUsage({ promptTokens: 1_000_000, completionTokens: 500_000 }, PRICE)).toBe(2);
    expect(amountFromUsage({ promptTokens: 1, completionTokens: 0 }, PRICE)).toBe(1);
  });
});

describe('checkAndHold', () => {
  it('creates holds with the high-side estimate', async () => {
    const { client, state } = createFakeBillingClient();
    const { log } = createRecordingLog();

    const outcome = await checkAndHold(
      client,
      { platform: PLATFORM, price: PRICE, maxTokens: 1_000_000, fixedCostCents: 1 },
      log,
    );
    expect(outcome).toEqual({ kind: 'held', holdId: 'hold-1', estimatedAmount: 3 });
    expect(state.holds[0]).toMatchObject({ ...PLATFORM, estimatedAmount: 3 });
  });

  it('passes billing 402 rejections through untouched', async () => {
    const { client, state } = createFakeBillingClient();
    const { log, records } = createRecordingLog();
    state.rejectNextHold = { status: 402, body: { error: { code: 'payment_required' } } };

    const outcome = await checkAndHold(
      client,
      { platform: PLATFORM, price: PRICE, maxTokens: 100, fixedCostCents: 1 },
      log,
    );
    expect(outcome).toEqual({
      kind: 'rejected',
      status: 402,
      body: { error: { code: 'payment_required' } },
    });
    expect(records.warnings).toHaveLength(0);
  });

  it('fails open for chat when billing times out or 5xxs', async () => {
    const { client, state } = createFakeBillingClient();
    const { log, records } = createRecordingLog();
    state.failNextHold = true;

    const outcome = await checkAndHold(
      client,
      { platform: PLATFORM, price: PRICE, maxTokens: 100, fixedCostCents: 1 },
      log,
    );
    expect(outcome.kind).toBe('fail_open');
    expect(records.warnings).toHaveLength(1);
    expect(records.warnings[0]).toMatchObject({ agent_id: 'agent-a', turn_id: 'turn-1' });
  });
});

describe('finalizeTurn', () => {
  const held = { kind: 'held' as const, holdId: 'hold-1', estimatedAmount: 9 };

  it('reports two metering events with hold_id then settles the real amount', async () => {
    const { client, state } = createFakeBillingClient();
    const { log } = createRecordingLog();
    const usage = { promptTokens: 1_000_000, completionTokens: 500_000 };

    await finalizeTurn(
      client,
      { hold: held, platform: PLATFORM, model: 'deepseek-chat', price: PRICE, usage },
      log,
    );

    expect(state.usageReports).toHaveLength(1);
    expect(state.usageReports[0]).toHaveLength(2);
    expect(state.usageReports[0]![0]).toMatchObject({
      agentId: 'agent-a',
      userId: USER,
      turnId: 'turn-1',
      holdId: 'hold-1',
      dimension: 'llm_token_in',
      quantity: 1_000_000,
      model: 'deepseek-chat',
      unitCost: 1,
      source: 'gateway',
    });
    expect(state.usageReports[0]![1]).toMatchObject({
      dimension: 'llm_token_out',
      quantity: 500_000,
      unitCost: 2,
    });
    expect(state.settlements).toEqual([{ holdId: 'hold-1', actualAmount: 2 }]);
  });

  it('settles the estimate without a usage report when usage is missing', async () => {
    const { client, state } = createFakeBillingClient();
    const { log } = createRecordingLog();

    await finalizeTurn(
      client,
      { hold: held, platform: PLATFORM, model: 'deepseek-chat', price: PRICE, usage: null },
      log,
    );
    expect(state.usageReports).toHaveLength(0);
    expect(state.settlements).toEqual([{ holdId: 'hold-1', actualAmount: 9 }]);
  });

  it('fail-open turns report usage without hold_id and never settle', async () => {
    const { client, state } = createFakeBillingClient();
    const { log } = createRecordingLog();

    await finalizeTurn(
      client,
      {
        hold: { kind: 'fail_open', estimatedAmount: 9 },
        platform: PLATFORM,
        model: 'deepseek-chat',
        price: PRICE,
        usage: { promptTokens: 10, completionTokens: 20 },
      },
      log,
    );
    expect(state.usageReports).toHaveLength(1);
    expect(state.usageReports[0]![0]).not.toHaveProperty('holdId');
    expect(state.settlements).toHaveLength(0);
  });

  it('still settles when the usage report fails, and survives settle failures', async () => {
    const { client, state } = createFakeBillingClient();
    const { log, records } = createRecordingLog();
    state.failNextUsageReport = true;
    state.failNextSettle = true;

    await expect(
      finalizeTurn(
        client,
        {
          hold: held,
          platform: PLATFORM,
          model: 'deepseek-chat',
          price: PRICE,
          usage: { promptTokens: 10, completionTokens: 20 },
        },
        log,
      ),
    ).resolves.toBeUndefined();
    expect(records.errors).toHaveLength(2);
  });
});

describe('releaseHold', () => {
  it('settles zero for held turns and skips fail-open turns', async () => {
    const { client, state } = createFakeBillingClient();
    const { log } = createRecordingLog();
    const held = { kind: 'held' as const, holdId: 'hold-1', estimatedAmount: 9 };

    await releaseHold(client, held, log, {});
    await releaseHold(client, { kind: 'fail_open', estimatedAmount: 9 }, log, {});
    expect(state.settlements).toEqual([{ holdId: 'hold-1', actualAmount: 0 }]);
  });
});

describe('usageToMeteringEvents', () => {
  it('omits hold_id entirely when there is no hold', () => {
    const events = usageToMeteringEvents({
      usage: { promptTokens: 1, completionTokens: 2 },
      price: PRICE,
      model: 'm',
      agentId: 'agent-a',
      userId: USER,
      turnId: 't',
    });
    expect(events).toHaveLength(2);
    for (const event of events) expect(event).not.toHaveProperty('holdId');
  });
});

describe('usage extractor', () => {
  it('captures the terminal usage frame across chunk boundaries', () => {
    const extractor = createUsageExtractor();
    extractor.push('data: {"choices":[{"delta":{"content":"he');
    extractor.push('llo"}}]}\n\ndata: {"choices":[],');
    extractor.push('"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n');
    extractor.push('data: [DONE]\n\n');

    expect(extractor.result()).toEqual({ promptTokens: 11, completionTokens: 7 });
  });

  it('ignores comments, heartbeats, and malformed usage', () => {
    const extractor = createUsageExtractor();
    extractor.push(
      ': comment\n\nevent: ping\ndata: {}\n\ndata: {"usage":{"prompt_tokens":"x"}}\n\n',
    );
    expect(extractor.result()).toBeNull();
  });
});
