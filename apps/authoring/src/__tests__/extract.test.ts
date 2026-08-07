// extract 批间并发的行为契约：并发只改时间不改结果。
//   - 两批同时在飞（真并发，非串行）；
//   - 完成乱序时产出仍按批下标序合并（同输入同输出）；
//   - 跨批重名去重按批序先到先得，与完成顺序无关；
//   - 进度上报值只增不减；
//   - 单批降级不阻塞其余批。
import { describe, expect, it } from 'vitest';
import type { LlmGatewayPort, LlmResult } from '@cb/shared';
import { extractCapabilities, type ExtractSegment } from '../modules/task/extract.js';
import { llmText } from './fakes.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 只实现 complete 的异步可控网关（extract 只用 complete）。 */
function gateway(script: (prompt: string) => Promise<LlmResult>): LlmGatewayPort {
  return {
    complete: (prompt: string) => script(prompt),
    stream: () => {
      throw new Error('not used');
    },
    embed: () => {
      throw new Error('not used');
    },
  } as unknown as LlmGatewayPort;
}

const noopAudit = { record: async () => {} };

function segs(count: number, prefix: string): ExtractSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `${prefix}-${i}`,
    content: `${prefix} 的工作记录`,
    messageCount: 1,
  }));
}

function capJson(name: string, summary: string): string {
  return JSON.stringify([
    {
      name,
      summary,
      kind: '编码',
      instructions: '按记录里的做法完成同类任务。',
      inputs: [],
      starterPrompts: [],
    },
  ]);
}

/** 让已入队的微任务/已放行的 complete 有机会推进。 */
async function tick(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

// 9 段 → 批 1(8 段) + 批 2(1 段)。批 1 挂在闸上、批 2 先放行，制造完成乱序。
function makeInput(segments: ExtractSegment[], dones: number[]) {
  return {
    taskId: 't1',
    ownerUserId: 'u1',
    traceId: 'tr1',
    segments,
    onBatchDone: async (done: number, _total: number) => {
      dones.push(done);
    },
  };
}

describe('extractCapabilities 批间并发', () => {
  it('两批同时在飞;完成乱序时仍按批序合并,进度只增不减', async () => {
    const gate1 = deferred();
    const gate2 = deferred();
    let inFlight = 0;
    let maxInFlight = 0;
    const llm = gateway(async (prompt) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const isBatch1 = prompt.includes('b1-0');
      await (isBatch1 ? gate1.promise : gate2.promise);
      inFlight -= 1;
      return llmText(isBatch1 ? capJson('接口调试', '来自批1') : capJson('日志分析', '来自批2'));
    });

    const dones: number[] = [];
    const pending = extractCapabilities(
      { llm, audit: noopAudit },
      makeInput([...segs(8, 'b1'), ...segs(1, 'b2')], dones),
    );
    await tick();
    expect(maxInFlight).toBe(2); // 两批并发在飞，不是批间串行

    gate2.resolve(); // 批 2 先完成
    await tick();
    gate1.resolve();
    const out = await pending;

    // 合并按批下标序：批 1 的能力在前，与完成顺序无关。
    expect(out.items.map((c) => c.name)).toEqual(['接口调试', '日志分析']);
    expect(out.degraded).toBe(false);
    // 进度值只增不减，最终到总段数：批 2(1 段)先报 1，批 1(8 段)后报 9。
    expect(dones).toEqual([1, 9]);
  });

  it('跨批重名按批序先到先得,与完成顺序无关', async () => {
    const gate1 = deferred();
    const llm = gateway(async (prompt) => {
      const isBatch1 = prompt.includes('b1-0');
      if (isBatch1) await gate1.promise; // 批 2 先返回同名能力
      return llmText(capJson('接口调试', isBatch1 ? '批1版本' : '批2版本'));
    });

    const pending = extractCapabilities(
      { llm, audit: noopAudit },
      makeInput([...segs(8, 'b1'), ...segs(1, 'b2')], []),
    );
    await tick();
    gate1.resolve();
    const out = await pending;

    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.summary).toBe('批1版本'); // 保留批序在前的版本
  });

  it('单批降级不阻塞其余批,整体标记 degraded', async () => {
    const llm = gateway(async (prompt) => {
      if (prompt.includes('b1-0')) throw new Error('upstream down');
      return llmText(capJson('日志分析', '来自批2'));
    });

    const out = await extractCapabilities(
      { llm, audit: noopAudit },
      makeInput([...segs(8, 'b1'), ...segs(1, 'b2')], []),
    );

    expect(out.items.map((c) => c.name)).toEqual(['日志分析']);
    expect(out.degraded).toBe(true);
    expect(out.items.every((c) => c.meta.origin === 'llm')).toBe(true);
  });
});

describe('extractCapabilities · 空结果与降级边界', () => {
  it('模型明确返回合法 []：正常空结果，不标 degraded', async () => {
    const out = await extractCapabilities(
      { llm: gateway(async () => llmText('[]')), audit: noopAudit },
      makeInput(segs(9, 'empty'), []),
    );

    expect(out).toEqual({ items: [], degraded: false });
  });

  it('所有批次由网关标记 degraded：返回空结果且不生成 fallback', async () => {
    const out = await extractCapabilities(
      {
        llm: gateway(async () => ({
          degraded: true,
          usage: { promptTokens: 0, completionTokens: 0, costMicros: 0 },
        })),
        audit: noopAudit,
      },
      makeInput(segs(9, 'degraded'), []),
    );

    expect(out).toEqual({ items: [], degraded: true });
    expect(JSON.stringify(out)).not.toContain('fallback');
  });

  it('所有批次返回不可解析文本：返回空结果并标 degraded', async () => {
    const modelTextMarker = 'PRIVATE_MODEL_TEXT_MUST_NOT_REACH_LOGS';
    const warnings: object[] = [];
    const out = await extractCapabilities(
      {
        llm: gateway(async () => llmText(`[${modelTextMarker}`)),
        audit: noopAudit,
        log: { warn: (fields) => warnings.push(fields) },
      },
      makeInput(segs(9, 'invalid'), []),
    );

    expect(out).toEqual({ items: [], degraded: true });
    expect(warnings).toHaveLength(2);
    expect(JSON.stringify(warnings)).not.toContain(modelTextMarker);
    for (const warning of warnings) {
      expect(warning).not.toHaveProperty('textHead');
      expect(warning).not.toHaveProperty('textTail');
      expect(warning).toMatchObject({ parseError: expect.stringMatching(/^JSON_PARSE_FAILED/) });
    }
  });
});
