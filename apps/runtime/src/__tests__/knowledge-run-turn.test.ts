import { describe, expect, it } from 'vitest';
import { digestCreatorAgentPackageFile } from '@cb/creator-agent-protocol/agent-package';
import { createCreatorKnowledgeBundle } from '@cb/creator-agent-protocol/knowledge-bundle';
import type { CapabilityDefinition, KnowledgeAgentBinding } from '@cb/shared';

import { createTurnRunner } from '../modules/agent/run-turn.js';
import { createUsageBillingService } from '../modules/billing/service.js';
import { createTurn, TURN_ABANDON_AFTER_MS } from '../modules/agent/turn-repo.js';
import {
  createKnowledgeToolSession,
  knowledgeQuestionDigest,
  searchKnowledgeBundle,
  validateKnowledgeCandidate,
  type ResolvedKnowledgeAgent,
} from '../modules/knowledge-agent/resolver.js';
import { createSession } from '../modules/session/repo.js';
import type { KnowledgeAgentTestGate } from '../platform/config/env.js';
import { createSessionEventBus } from '../platform/infra/event-bus.js';
import { createInterruptBus } from '../platform/infra/redis-interrupt-bus.js';
import { createDisabledSandboxBackend } from '../platform/infra/sandbox-backend.js';
import {
  FakeDb,
  FakeObjectStore,
  FakeSessionEventLog,
  makeFakeAgentFactory,
  silentLog,
  waitFor,
  type FakeAgentScript,
} from './fakes.js';

type LegacyKnowledgeAgentTestGate = Extract<
  KnowledgeAgentTestGate,
  { protocol: 'combo.knowledge-agent-runtime-test-gate/1' }
>;
type GroundedKnowledgeAgentTestGate = Extract<
  KnowledgeAgentTestGate,
  { protocol: 'combo.knowledge-agent-runtime-test-gate/2' }
>;

const CREATOR = '00000000-0000-4000-8000-000000000001';
const CONSUMER = '00000000-0000-4000-8000-000000000002';
const CAPABILITY = '00000000-0000-4000-8000-000000000003';
const SOURCE_SHA = '1'.repeat(40);
const CHUNK = `chunk.knowledge.${'2'.repeat(32)}`;
const SECOND_CHUNK = `chunk.knowledge.${'7'.repeat(32)}`;
const QUESTION = '免费额度是多少？';
const ANSWER = '前三次成功回答免费。';
const GROUNDED_ANSWER = 'Combo 的免费额度可以用于前三次成功回答。';
const LONG_GROUNDED_QUESTION = '前三次用完以后为什么会提示余额不足？';
const LONG_GROUNDED_ANSWER = 'Combo 前三次用完以后会提示余额不足，因为免费额度已经用完。';
const SECOND_GROUNDED_ANSWER = 'Combo 余额不足会返回 402。';
const MULTI_GROUNDED_QUESTION = 'Combo 的免费额度是什么，余额不足会怎样？';
const MULTI_GROUNDED_ANSWER = `${GROUNDED_ANSWER}${SECOND_GROUNDED_ANSWER}`;
const binding: KnowledgeAgentBinding = {
  productKind: 'knowledge_agent_test',
  capability: { id: CAPABILITY, protocol: 'combo.agent-package-capability/2' },
  release: {
    protocol: 'combo.agent-package-release/1',
    releaseId: `release.agent-package.${'3'.repeat(32)}`,
    packageDigest: `sha256:${'4'.repeat(64)}`,
  },
  releaseScope: 'controlled_test',
  knowledge: {
    protocol: 'combo.knowledge-bundle/1',
    resourcePath: 'skills/knowledge/references/knowledge-bundle.json',
    resourceDigest: `sha256:${'5'.repeat(64)}`,
  },
};
const contents = [`${GROUNDED_ANSWER}${LONG_GROUNDED_ANSWER}`, SECOND_GROUNDED_ANSWER];
const resolved: ResolvedKnowledgeAgent = {
  binding,
  name: '公开知识助手',
  description: '只依据固定知识回答',
  instructions: '检索知识后提交候选答案。',
  knowledge: createCreatorKnowledgeBundle({
    protocol: 'combo.knowledge-bundle/1',
    chunks: [CHUNK, SECOND_CHUNK].map((id, index) => ({
      id,
      source: {
        sourceId: `source.knowledge.${String(index + 6).repeat(32)}`,
        displayLabel: index === 0 ? '公开计费手册' : '公开充值手册',
      },
      content: contents[index]!,
      contentDigest: digestCreatorAgentPackageFile(new TextEncoder().encode(contents[index]!)),
    })),
  }),
};
const definition: CapabilityDefinition = {
  version: 1,
  name: resolved.name,
  summary: resolved.description,
  kind: 'knowledge',
  instructions: resolved.instructions,
  inputs: [],
  starterPrompts: [],
  meta: {},
};

function gate(): LegacyKnowledgeAgentTestGate {
  return {
    protocol: 'combo.knowledge-agent-runtime-test-gate/1',
    sourceSha: SOURCE_SHA,
    publisherUserId: CREATOR,
    capabilityId: CAPABILITY,
    releaseId: binding.release.releaseId,
    packageDigest: binding.release.packageDigest,
    validatorPolicyVersion: 'knowledge-agent-test-validator-v1',
    cases: [
      {
        questionDigest: knowledgeQuestionDigest(QUESTION),
        answer: ANSWER,
        citationChunkIds: [CHUNK],
      },
    ],
  };
}

function groundedGate(): GroundedKnowledgeAgentTestGate {
  return {
    protocol: 'combo.knowledge-agent-runtime-test-gate/2',
    sourceSha: SOURCE_SHA,
    publisherUserId: CREATOR,
    capabilityId: CAPABILITY,
    releaseId: binding.release.releaseId,
    packageDigest: binding.release.packageDigest,
    validatorPolicyVersion: 'knowledge-agent-grounded-validator-v2',
  };
}

async function executeTool(
  session: ReturnType<typeof createKnowledgeToolSession>,
  name: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const tool = session.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return (
    tool as unknown as {
      execute(id: string, input: Record<string, unknown>): Promise<unknown>;
    }
  ).execute('call-1', params);
}

async function runtime(
  script: FakeAgentScript,
  idleTimeoutMs = 60_000,
  sandbox = createDisabledSandboxBackend(),
  shutdownTimeoutMs = 15_000,
  knowledgeGate: KnowledgeAgentTestGate = gate(),
  question = QUESTION,
) {
  const db = new FakeDb();
  db.seedCapability({ id: CAPABILITY, owner_user_id: CREATOR, published: true });
  const session = await createSession(db, {
    capabilityId: CAPABILITY,
    ownerUserId: CONSUMER,
    agentBinding: binding,
  });
  const agent = makeFakeAgentFactory(script);
  const eventLog = new FakeSessionEventLog();
  const runner = createTurnRunner({
    db,
    objectStore: new FakeObjectStore(),
    bus: createSessionEventBus(),
    eventLog,
    agentFactory: agent.factory,
    idleTimeoutMs,
    interrupts: createInterruptBus(),
    sandbox,
    shutdownTimeoutMs,
    billingPolicy: { freeUses: 3, unitPriceCents: 1 },
    runtimeSourceSha: SOURCE_SHA,
    log: silentLog,
  });
  const start = () =>
    runner.startTurn({
      session,
      definition,
      text: question,
      usageId: '00000000-0000-4000-8000-000000000007',
      capabilityOwnerUserId: CREATOR,
      knowledge: { resolved, gate: knowledgeGate, runtimeSourceSha: SOURCE_SHA },
      log: silentLog,
    });
  return { db, session, agent, eventLog, runner, start };
}

function validateGroundedFixture(input: { question: string; answer: string; excerpt: string }) {
  return validateKnowledgeCandidate({
    gate: groundedGate(),
    question: input.question,
    candidate: { status: 'answered', answer: input.answer, citationChunkIds: [CHUNK] },
    exposedHits: [
      {
        chunkId: CHUNK,
        sourceId: `source.knowledge.${'6'.repeat(32)}`,
        displayLabel: '公开说明',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        excerpt: input.excerpt,
      },
    ],
  });
}

describe('knowledge run-turn high-risk boundaries', () => {
  it('searches deterministically, fences citations, and leaves acceptance to the platform', async () => {
    expect(searchKnowledgeBundle(resolved.knowledge, 'Combo', 8).map((hit) => hit.chunkId)).toEqual(
      [CHUNK, SECOND_CHUNK],
    );
    const tools = createKnowledgeToolSession({
      knowledge: resolved.knowledge,
      turnSignal: new AbortController().signal,
      requiresGroundedExtractiveAnswer: true,
    });
    expect(
      tools.tools.find((tool) => tool.name === 'submit_knowledge_answer')?.description,
    ).toContain('每个句子必须逐字复用所引 excerpt 中的完整原句');
    expect(
      tools.tools.find((tool) => tool.name === 'submit_knowledge_answer')?.description,
    ).toContain('不得提交 FAQ 问句、Markdown 标题/列表、名词型片段');
    expect(
      tools.tools.find((tool) => tool.name === 'submit_knowledge_answer')?.description,
    ).toContain('问题复述、短动作嵌入另一个词');
    expect(
      tools.tools.find((tool) => tool.name === 'submit_knowledge_answer')?.description,
    ).toContain('关系、否定、条件、时间与限定必须直接对齐');
    expect(
      tools.tools.find((tool) => tool.name === 'submit_knowledge_answer')?.description,
    ).toContain('不完整的前置上下文分句必须与后续疑问分句组成同一连通骨架');
    expect(
      tools.tools.find((tool) => tool.name === 'submit_knowledge_answer')?.description,
    ).toContain('每个连通骨架必须完整出现在同一个答案逗号分句内');
    expect(
      tools.tools.find((tool) => tool.name === 'submit_knowledge_answer')?.description,
    ).toContain('短动作与其直接宾语之间可以原位插入一个格式明确的数量值');
    await expect(
      executeTool(tools, 'submit_knowledge_answer', {
        status: 'answered',
        answer: ANSWER,
        citationChunkIds: [CHUNK],
      }),
    ).rejects.toThrow('prior search');
    await executeTool(tools, 'knowledge_search', { query: '402' });
    await expect(
      executeTool(tools, 'submit_knowledge_answer', {
        status: 'answered',
        answer: ANSWER,
        citationChunkIds: [CHUNK],
      }),
    ).rejects.toThrow('not exposed');
    await executeTool(tools, 'knowledge_search', { query: '免费额度' });
    await executeTool(tools, 'submit_knowledge_answer', {
      status: 'answered',
      answer: ANSWER,
      citationChunkIds: [CHUNK],
    });
    const candidate = tools.candidate();
    expect(
      validateKnowledgeCandidate({
        gate: gate(),
        question: QUESTION,
        candidate,
        exposedHits: tools.exposedHits(),
      }),
    ).toMatchObject({ outcome: 'answered', validationCode: 'accepted' });
    expect(
      validateKnowledgeCandidate({
        gate: { ...gate(), cases: [{ ...gate().cases[0]!, answer: '另一答案' }] },
        question: QUESTION,
        candidate,
        exposedHits: tools.exposedHits(),
      }),
    ).toMatchObject({ outcome: 'failed', validationCode: 'rejected' });
  });

  it('retrieves a Chinese reformulation and centers a bounded excerpt on a late match', () => {
    expect(
      searchKnowledgeBundle(resolved.knowledge, '前三次用完以后为什么会提示余额不足？', 8).map(
        (hit) => hit.chunkId,
      ),
    ).toEqual([CHUNK, SECOND_CHUNK]);

    const lateContent = `${'前置无关内容。'.repeat(260)}关键命中词说明余额不足会提示充值。${'后置内容。'.repeat(260)}`;
    const lateBundle = createCreatorKnowledgeBundle({
      protocol: 'combo.knowledge-bundle/1',
      chunks: [
        {
          id: CHUNK,
          source: {
            sourceId: `source.knowledge.${'6'.repeat(32)}`,
            displayLabel: '长篇公开手册',
          },
          content: lateContent,
          contentDigest: digestCreatorAgentPackageFile(new TextEncoder().encode(lateContent)),
        },
      ],
    });
    const [hit] = searchKnowledgeBundle(lateBundle, '关键命中词', 1);
    expect(hit?.excerpt).toContain('关键命中词');
    expect(Array.from(hit?.excerpt ?? '')).toHaveLength(1_200);
    expect(hit?.excerpt.startsWith('…')).toBe(true);
  });

  it('accepts a novel grounded v2 answer but rejects lexical support violations', async () => {
    const exposedHits = searchKnowledgeBundle(resolved.knowledge, '免费额度 余额不足', 8);
    const accepted = {
      status: 'answered' as const,
      answer: LONG_GROUNDED_ANSWER,
      citationChunkIds: [CHUNK],
    };
    expect(
      validateKnowledgeCandidate({
        gate: groundedGate(),
        question: LONG_GROUNDED_QUESTION,
        candidate: accepted,
        exposedHits,
      }),
    ).toMatchObject({ outcome: 'answered', validationCode: 'accepted' });

    for (const answer of [
      '前三次成功回答免费，之后需要支付 100 元。',
      '该规则由 2099-01-01 发布的 v99 版本规定。',
      '前三次成功回答免费。另外所有退款都会自动到账。',
    ]) {
      expect(
        validateKnowledgeCandidate({
          gate: groundedGate(),
          question: LONG_GROUNDED_QUESTION,
          candidate: { ...accepted, answer },
          exposedHits,
        }),
      ).toMatchObject({ outcome: 'failed', validationCode: 'rejected' });
    }
    expect(
      validateKnowledgeCandidate({
        gate: groundedGate(),
        question: LONG_GROUNDED_QUESTION,
        candidate: accepted,
        exposedHits: [
          ...exposedHits,
          {
            chunkId: `chunk.knowledge.${'8'.repeat(32)}`,
            sourceId: `source.knowledge.${'9'.repeat(32)}`,
            displayLabel: '无关资料',
            contentDigest: `sha256:${'a'.repeat(64)}`,
            excerpt: '火星天气与本问题无关。',
          },
        ],
      }),
    ).toMatchObject({ outcome: 'answered' });
    expect(
      validateKnowledgeCandidate({
        gate: groundedGate(),
        question: LONG_GROUNDED_QUESTION,
        candidate: {
          ...accepted,
          citationChunkIds: [CHUNK, SECOND_CHUNK, `chunk.knowledge.${'8'.repeat(32)}`],
        },
        exposedHits: [
          ...exposedHits,
          {
            chunkId: `chunk.knowledge.${'8'.repeat(32)}`,
            sourceId: `source.knowledge.${'9'.repeat(32)}`,
            displayLabel: '无关资料',
            contentDigest: `sha256:${'a'.repeat(64)}`,
            excerpt: '火星天气与本问题无关。',
          },
        ],
      }),
    ).toMatchObject({ outcome: 'failed', validationCode: 'rejected' });

    expect(
      validateKnowledgeCandidate({
        gate: gate(),
        question: '未配置的陌生问题',
        candidate: { status: 'answered', answer: ANSWER, citationChunkIds: [CHUNK] },
        exposedHits: [exposedHits[0]!],
      }),
    ).toMatchObject({ outcome: 'failed', validationCode: 'rejected' });
  });

  it.each([
    {
      question: '余额不足时会怎样？',
      answer: '余额充足时返回 402。',
      citationChunkIds: [SECOND_CHUNK],
    },
    {
      question: '余额不足时会怎样？',
      answer: '余额不足时不会返回 402。',
      citationChunkIds: [SECOND_CHUNK],
    },
    {
      question: '前三次成功回答如何收费？',
      answer: '前三次成功回答收费。',
      citationChunkIds: [CHUNK],
    },
    {
      question: '余额不足时会怎样？',
      answer: '余额不足。返回 402。',
      citationChunkIds: [SECOND_CHUNK],
    },
  ])('rejects an unsupported polarity, relation, or clause recombination: $answer', (candidate) => {
    expect(
      validateKnowledgeCandidate({
        gate: groundedGate(),
        question: candidate.question,
        candidate: {
          status: 'answered',
          answer: candidate.answer,
          citationChunkIds: candidate.citationChunkIds,
        },
        exposedHits: searchKnowledgeBundle(resolved.knowledge, candidate.question, 8),
      }),
    ).toMatchObject({ outcome: 'failed', validationCode: 'rejected' });
  });

  it.each([
    {
      question: '退款规则是什么？',
      answer: '这个功能是什么。',
      excerpt: '这个功能是什么。',
    },
    {
      question: '2026 年价格是多少？',
      answer: '本系统在 2026 年发布。',
      excerpt: '本系统在 2026 年发布。',
    },
    {
      question: 'API 的退款规则是什么？',
      answer: 'API 已于昨天发布。',
      excerpt: 'API 已于昨天发布。',
    },
    {
      question: '退款规则是什么？',
      answer: '系统规则已经发布。',
      excerpt: '系统规则已经发布。',
    },
    {
      question: 'API 2026 是什么？',
      answer: 'API 在 2026 年发布。',
      excerpt: 'API 在 2026 年发布。',
    },
    {
      question: '2026 是什么意思？',
      answer: '2026 年是系统发布时间。',
      excerpt: '2026 年是系统发布时间。',
    },
    {
      question: 'API 是什么意思？',
      answer: 'API 需要在明天发布。',
      excerpt: 'API 需要在明天发布。',
    },
    {
      question: '1 是什么意思？',
      answer: '第 1 次需要充值。',
      excerpt: '第 1 次需要充值。',
    },
    {
      question: '2 表示什么？',
      answer: '第 2 次需要充值。',
      excerpt: '第 2 次需要充值。',
    },
    {
      question: '10 呢？',
      answer: '前 10 次需要充值。',
      excerpt: '前 10 次需要充值。',
    },
    {
      question: 'v 是什么意思？',
      answer: '版本 v 表示试验通道。',
      excerpt: '版本 v 表示试验通道。',
    },
    {
      question: 'a 呢？',
      answer: '等级 a 表示测试通道。',
      excerpt: '等级 a 表示测试通道。',
    },
    {
      question: '登录服务提供什么？',
      answer: '退款服务提供七天保障。',
      excerpt: '退款服务提供七天保障。',
    },
    {
      question: '账户可以怎么登录？',
      answer: '退款可以在七天内申请。',
      excerpt: '退款可以在七天内申请。',
    },
    {
      question: '登录功能可以使用什么方式？',
      answer: '退款可以使用银行卡申请。',
      excerpt: '退款可以使用银行卡申请。',
    },
    {
      question: '该服务的退款规则是什么？',
      answer: '该服务支持火星天气。',
      excerpt: '该服务支持火星天气。',
    },
    {
      question: '支付宝登录方式是什么？',
      answer: '微信登录方式必须使用验证码。',
      excerpt: '微信登录方式必须使用验证码。',
    },
    {
      question: '华为登录方式是什么？',
      answer: '支付宝登录方式必须使用验证码。',
      excerpt: '支付宝登录方式必须使用验证码。',
    },
    {
      question: '退款时效是什么？',
      answer: '退款金额是 100 元。',
      excerpt: '退款金额是 100 元。',
    },
    {
      question: '退款金额是多少？',
      answer: '退款时效是七天。',
      excerpt: '退款时效是七天。',
    },
    {
      question: '2026 年退款规则是什么？',
      answer: '退款规则在 2025 年生效。',
      excerpt: '退款规则在 2025 年生效。',
    },
    {
      question: '2026 年退款规则是什么？',
      answer: '2026 年退款规则已经生效。退款规则在 2025 年生效。',
      excerpt: '2026 年退款规则已经生效。退款规则在 2025 年生效。',
    },
    {
      question: '支付宝是什么？',
      answer: '支付必须在订单有效期内完成。',
      excerpt: '支付必须在订单有效期内完成。',
    },
    {
      question: '支付宝登录规则是什么？',
      answer: '支付宝支付必须使用银行卡。',
      excerpt: '支付宝支付必须使用银行卡。',
    },
    {
      question: '支付宝退款时效规则是什么？',
      answer: '支付宝登录必须使用验证码。',
      excerpt: '支付宝登录必须使用验证码。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款功能允许查询申请状态。',
      excerpt: '退款功能允许查询申请状态。',
    },
    {
      question: '登录方式是什么？',
      answer: '登录功能允许查看账户状态。',
      excerpt: '登录功能允许查看账户状态。',
    },
    {
      question: '退款流程是什么？',
      answer: '退款政策允许七天内提交材料。',
      excerpt: '退款政策允许七天内提交材料。',
    },
    {
      question: '前三次用完以后会怎样？',
      answer: '前三次用完以前会提示余额不足。',
      excerpt: '前三次用完以前会提示余额不足。',
    },
    {
      question: 'HTTP 402 表示什么？',
      answer: 'HTTP 402 代表需要充值。',
      excerpt: 'HTTP 402 代表需要充值。',
    },
    {
      question: '如何支付？',
      answer: '支付宝登录方式必须使用验证码。',
      excerpt: '支付宝登录方式必须使用验证码。',
    },
    {
      question: '如何提示？',
      answer: '提示词必须包含明确任务。',
      excerpt: '提示词必须包含明确任务。',
    },
    {
      question: '如何提供？',
      answer: '提供商必须完成实名认证。',
      excerpt: '提供商必须完成实名认证。',
    },
    {
      question: '如何支持？',
      answer: '支持者必须提交证明。',
      excerpt: '支持者必须提交证明。',
    },
    {
      question: '如何使用？',
      answer: '使用率必须低于上限。',
      excerpt: '使用率必须低于上限。',
    },
    {
      question: '如何返回？',
      answer: '返回值是 402。',
      excerpt: '返回值是 402。',
    },
    {
      question: '吗啡是什么？',
      answer: '咖啡是常见饮品。',
      excerpt: '咖啡是常见饮品。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则是退款规则。',
      excerpt: '退款规则是退款规则。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则等于退款规则。',
      excerpt: '退款规则等于退款规则。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则属于退款规则。',
      excerpt: '退款规则属于退款规则。',
    },
    {
      question: '华为是什么？',
      answer: '华为是华为。',
      excerpt: '华为是华为。',
    },
    {
      question: 'API v2 是什么？',
      answer: 'API v2 表示 API v2。',
      excerpt: 'API v2 表示 API v2。',
    },
    {
      question: '402 是什么意思？',
      answer: '402 表示 402。',
      excerpt: '402 表示 402。',
    },
    {
      question: 'v2 呢？',
      answer: 'v2 表示 v2。',
      excerpt: 'v2 表示 v2。',
    },
    {
      question: 'HTTP 402 表示什么？',
      answer: 'HTTP 402 表示 HTTP 402。',
      excerpt: 'HTTP 402 表示 HTTP 402。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则是规则。',
      excerpt: '退款规则是规则。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则是退款。',
      excerpt: '退款规则是退款。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则 is 退款规则。',
      excerpt: '退款规则 is 退款规则。',
    },
    {
      question: '用户如何支付？',
      answer: '用户的支付宝登录方式必须使用验证码。',
      excerpt: '用户的支付宝登录方式必须使用验证码。',
    },
    {
      question: '系统是否存在？',
      answer: '系统存在感必须保持稳定。',
      excerpt: '系统存在感必须保持稳定。',
    },
    {
      question: '用户可以支付吗？',
      answer: '用户的支付宝登录方式必须使用验证码。',
      excerpt: '用户的支付宝登录方式必须使用验证码。',
    },
    {
      question: '系统可以存在吗？',
      answer: '系统存在感必须保持稳定。',
      excerpt: '系统存在感必须保持稳定。',
    },
    {
      question: '什么值得买是什么？',
      answer: '值得买是电商平台。',
      excerpt: '值得买是电商平台。',
    },
    {
      question: '如何阅读一本书是什么？',
      answer: '阅读一本书是阅读指南。',
      excerpt: '阅读一本书是阅读指南。',
    },
    {
      question: '谁是凶手是什么？',
      answer: '凶手是一部推理电影。',
      excerpt: '凶手是一部推理电影。',
    },
    {
      question: '数学等于号说明是什么？',
      answer: '数学号说明包含运算符号。',
      excerpt: '数学号说明包含运算符号。',
    },
    {
      question: '退款需要材料说明是什么？',
      answer: '退款材料说明包含文件列表。',
      excerpt: '退款材料说明包含文件列表。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则是退款规则本身。',
      excerpt: '退款规则是退款规则本身。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则是退款规则自身。',
      excerpt: '退款规则是退款规则自身。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则是 the 退款规则。',
      excerpt: '退款规则是 the 退款规则。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则是 of 退款规则。',
      excerpt: '退款规则是 of 退款规则。',
    },
    {
      question: '可以退款吗？',
      answer: '不能退款并记录申请。',
      excerpt: '不能退款并记录申请。',
    },
    {
      question: '必须登录吗？',
      answer: '无需登录并保存数据。',
      excerpt: '无需登录并保存数据。',
    },
    {
      question: '高于 100 元吗？',
      answer: '低于 100 元并需要确认。',
      excerpt: '低于 100 元并需要确认。',
    },
    {
      question: '退款可以吗？',
      answer: '退款不能办理。',
      excerpt: '退款不能办理。',
    },
    {
      question: '是否不允许退款？',
      answer: '允许退款并记录申请。',
      excerpt: '允许退款并记录申请。',
    },
    {
      question: '退款必须在七天内申请吗？',
      answer: '退款不得在七天内申请。',
      excerpt: '退款不得在七天内申请。',
    },
    {
      question: '价格高于 100 元吗？',
      answer: '价格低于 100 元。',
      excerpt: '价格低于 100 元。',
    },
    {
      question: '余额不足时不会返回 402 吗？',
      answer: '余额不足时会返回 402。',
      excerpt: '余额不足时会返回 402。',
    },
    {
      question: '账户可以登录吗？',
      answer: '账户不能登录。',
      excerpt: '账户不能登录。',
    },
    {
      question: '是否允许退款？',
      answer: '系统不允许退款。',
      excerpt: '系统不允许退款。',
    },
    {
      question: '退款需要材料吗？',
      answer: '退款不需要材料。',
      excerpt: '退款不需要材料。',
    },
    {
      question: '退款不需要材料吗？',
      answer: '退款需要材料并完成审核。',
      excerpt: '退款需要材料并完成审核。',
    },
    {
      question: '系统不允许退款吗？',
      answer: '系统允许退款并记录申请。',
      excerpt: '系统允许退款并记录申请。',
    },
    {
      question: '价格不高于 100 元吗？',
      answer: '价格高于 100 元时需要确认。',
      excerpt: '价格高于 100 元时需要确认。',
    },
    {
      question: '为什么会提示余额不足？',
      answer: '系统不会提示余额不足。',
      excerpt: '系统不会提示余额不足。',
    },
    {
      question: '是非规则是什么？',
      answer: '是非规则。',
      excerpt: '是非规则。',
    },
    {
      question: '允许规则是什么？',
      answer: '允许规则。',
      excerpt: '允许规则。',
    },
    {
      question: '要求说明是什么？',
      answer: '要求说明。',
      excerpt: '要求说明。',
    },
    {
      question: 'HTTP 402 是什么意思？',
      answer: 'HTTPS 402 表示需要充值。',
      excerpt: 'HTTPS 402 表示需要充值。',
    },
    {
      question: 'API v2 是什么？',
      answer: 'SDK v2 使用新的验证策略。',
      excerpt: 'SDK v2 使用新的验证策略。',
    },
    {
      question: 'HTTP 402 是什么意思？',
      answer: 'HTTP 402 表示旧协议。HTTPS 402 表示需要充值。',
      excerpt: 'HTTP 402 表示旧协议。HTTPS 402 表示需要充值。',
    },
  ])(
    'rejects an exact but irrelevant source sentence: $answer',
    ({ question, answer, excerpt }) => {
      expect(validateGroundedFixture({ question, answer, excerpt })).toMatchObject({
        outcome: 'failed',
        validationCode: 'rejected',
      });
    },
  );

  it.each([
    { question: '如何申请退款？', answer: '如何申请退款？' },
    { question: '免费额度是多少？', answer: '免费额度是多少？' },
    { question: '退款流程是什么？', answer: '退款流程。' },
  ])('rejects an extractive FAQ question or heading: $answer', ({ question, answer }) => {
    expect(validateGroundedFixture({ question, answer, excerpt: answer })).toMatchObject({
      outcome: 'failed',
      validationCode: 'rejected',
    });
  });

  it.each([
    { question: '退款规则是什么？', answer: '# 退款说明' },
    { question: '退款规则是什么？', answer: '- 退款说明' },
    { question: '退款规则是什么？', answer: '退款申请。' },
    { question: 'API 的退款规则是什么？', answer: 'API 退款说明。' },
    { question: '退款规则是什么？', answer: '# 退款可以在七天内申请。' },
    { question: '退款规则是什么？', answer: '- 退款可以在七天内申请。' },
    { question: '退款规则是什么？', answer: '退款使用说明。' },
    { question: '退款规则是什么？', answer: '退款支持指南。' },
    { question: '退款规则是什么？', answer: '退款支持。' },
    { question: '退款要求是什么？', answer: '退款要求。' },
  ])(
    'rejects an extractive Markdown title or nominal fragment: $answer',
    ({ question, answer }) => {
      expect(validateGroundedFixture({ question, answer, excerpt: answer })).toMatchObject({
        outcome: 'failed',
        validationCode: 'rejected',
      });
    },
  );

  it.each([
    {
      question: 'HTTP 402 代表什么？',
      answer: 'HTTP 402 代表需要充值。',
      excerpt: 'HTTP 402 代表需要充值。',
    },
    {
      question: '402 是什么意思？',
      answer: 'HTTP 402 表示需要充值。',
      excerpt: 'HTTP 402 表示需要充值。',
    },
    {
      question: 'v2 呢？',
      answer: 'API v2 使用新的验证策略。',
      excerpt: 'API v2 使用新的验证策略。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则允许在七天内申请。',
      excerpt: '退款规则允许在七天内申请。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则要求申请在七天内完成。',
      excerpt: '退款规则要求申请在七天内完成。',
    },
    {
      question: '登录服务提供什么？',
      answer: '登录服务提供单点认证。',
      excerpt: '登录服务提供单点认证。',
    },
    {
      question: '该服务的退款规则是什么？',
      answer: '退款规则允许在七天内申请。',
      excerpt: '退款规则允许在七天内申请。',
    },
    {
      question: '退款的规则是什么？',
      answer: '退款的规则允许在七天内申请。',
      excerpt: '退款的规则允许在七天内申请。',
    },
    {
      question: '目的是什么？',
      answer: '目的是达成清晰结果。',
      excerpt: '目的是达成清晰结果。',
    },
    {
      question: '的士是什么？',
      answer: '的士是城市交通工具。',
      excerpt: '的士是城市交通工具。',
    },
    {
      question: '华为是什么？',
      answer: '华为是全球技术公司。',
      excerpt: '华为是全球技术公司。',
    },
    {
      question: '行为规则是什么？',
      answer: '行为规则要求符合安全政策。',
      excerpt: '行为规则要求符合安全政策。',
    },
    {
      question: '支付规则是什么？',
      answer: '支付规则要求在订单有效期内完成。',
      excerpt: '支付规则要求在订单有效期内完成。',
    },
    {
      question: '如何支付？',
      answer: '支付可以使用银行卡完成。',
      excerpt: '支付可以使用银行卡完成。',
    },
    {
      question: '如何支付？',
      answer: '支付必须在订单有效期内完成。',
      excerpt: '支付必须在订单有效期内完成。',
    },
    {
      question: '用户如何支付？',
      answer: '用户支付可以使用银行卡完成。',
      excerpt: '用户支付可以使用银行卡完成。',
    },
    {
      question: '接口如何返回？',
      answer: '接口返回可以包含结果。',
      excerpt: '接口返回可以包含结果。',
    },
    {
      question: '系统是否存在？',
      answer: '系统存在并保持运行。',
      excerpt: '系统存在并保持运行。',
    },
    {
      question: LONG_GROUNDED_QUESTION,
      answer: LONG_GROUNDED_ANSWER,
      excerpt: LONG_GROUNDED_ANSWER,
    },
    {
      question: '返回值是什么？',
      answer: '返回值是 402。',
      excerpt: '返回值是 402。',
    },
    {
      question: '支付宝登录方式是什么？',
      answer: '支付宝登录方式必须使用验证码。',
      excerpt: '支付宝登录方式必须使用验证码。',
    },
    {
      question: '支 付 宝 登 录 方 式 是 什 么？',
      answer: '支付宝登录方式必须使用验证码。',
      excerpt: '支付宝登录方式必须使用验证码。',
    },
    {
      question: '使用说明是什么？',
      answer: '使用说明要求先完成登录。',
      excerpt: '使用说明要求先完成登录。',
    },
    {
      question: '提示词是什么？',
      answer: '提示词必须包含明确任务。',
      excerpt: '提示词必须包含明确任务。',
    },
    {
      question: '什么时候生效？',
      answer: '退款政策在今天生效。',
      excerpt: '退款政策在今天生效。',
    },
    {
      question: '如何开启？',
      answer: '开启需要管理员确认。',
      excerpt: '开启需要管理员确认。',
    },
    {
      question: '如何关闭？',
      answer: '关闭必须先保存数据。',
      excerpt: '关闭必须先保存数据。',
    },
    {
      question: '退款必须在七天内申请吗？',
      answer: '退款必须在七天内申请并提交凭证。',
      excerpt: '退款必须在七天内申请并提交凭证。',
    },
    {
      question: '价格高于 100 元吗？',
      answer: '价格高于 100 元时需要确认。',
      excerpt: '价格高于 100 元时需要确认。',
    },
    {
      question: '余额不足时不会返回 402 吗？',
      answer: '余额不足时不会返回 402，而会提示充值。',
      excerpt: '余额不足时不会返回 402，而会提示充值。',
    },
    {
      question: '账户可以登录吗？',
      answer: '账户可以登录并查看订单。',
      excerpt: '账户可以登录并查看订单。',
    },
    {
      question: '余额不足时会提示充值吗？',
      answer: '余额不足时会提示充值并返回 402。',
      excerpt: '余额不足时会提示充值并返回 402。',
    },
    {
      question: '前三次用完以后会怎样？',
      answer: '前三次用完以后会提示余额不足。',
      excerpt: '前三次用完以后会提示余额不足。',
    },
    {
      question: '为什么会提示余额不足？',
      answer: '系统会提示余额不足并引导充值。',
      excerpt: '系统会提示余额不足并引导充值。',
    },
    {
      question: '是否允许退款？',
      answer: '系统允许退款并记录申请。',
      excerpt: '系统允许退款并记录申请。',
    },
    {
      question: '退款需要材料吗？',
      answer: '退款需要材料并完成审核。',
      excerpt: '退款需要材料并完成审核。',
    },
    {
      question: '是否高于 100 元？',
      answer: '价格高于 100 元时需要确认。',
      excerpt: '价格高于 100 元时需要确认。',
    },
    {
      question: '为什么会提示余额不足？',
      answer: '系统不会提示余额不足，但备用流程会提示余额不足并引导充值。',
      excerpt: '系统不会提示余额不足，但备用流程会提示余额不足并引导充值。',
    },
    {
      question: '如何提示？',
      answer: '提示需要包含明确任务。',
      excerpt: '提示需要包含明确任务。',
    },
    {
      question: '如何提示？',
      answer: '提示必须包含明确任务。',
      excerpt: '提示必须包含明确任务。',
    },
    {
      question: '用户可以支付吗？',
      answer: '用户可以支付，随后完成订单。',
      excerpt: '用户可以支付，随后完成订单。',
    },
    {
      question: '系统可以存在吗？',
      answer: '系统可以存在，并保持稳定。',
      excerpt: '系统可以存在，并保持稳定。',
    },
    {
      question: '是否存在？',
      answer: '风险存在。',
      excerpt: '风险存在。',
    },
    {
      question: '吗啡是什么？',
      answer: '吗啡是受管制药物。',
      excerpt: '吗啡是受管制药物。',
    },
    {
      question: '什么值得买是什么？',
      answer: '什么值得买是电商平台。',
      excerpt: '什么值得买是电商平台。',
    },
    {
      question: '去哪儿是什么？',
      answer: '去哪儿是旅游平台。',
      excerpt: '去哪儿是旅游平台。',
    },
    {
      question: '等于号是什么？',
      answer: '等于号是数学符号。',
      excerpt: '等于号是数学符号。',
    },
    {
      question: '如何阅读一本书是什么？',
      answer: '如何阅读一本书是一本阅读指南。',
      excerpt: '如何阅读一本书是一本阅读指南。',
    },
    {
      question: '谁是凶手是什么？',
      answer: '谁是凶手是一部推理电影。',
      excerpt: '谁是凶手是一部推理电影。',
    },
    {
      question: '数学等于号说明是什么？',
      answer: '数学等于号说明包含运算符号。',
      excerpt: '数学等于号说明包含运算符号。',
    },
    {
      question: '退款需要材料说明是什么？',
      answer: '退款需要材料说明包含文件列表。',
      excerpt: '退款需要材料说明包含文件列表。',
    },
    {
      question: '登录方式是什么？',
      answer: '登录方式使用 OAuth。',
      excerpt: '登录方式使用 OAuth。',
    },
    {
      question: '是非规则是什么？',
      answer: '是非规则要求遵守安全标准。',
      excerpt: '是非规则要求遵守安全标准。',
    },
    {
      question: '允许规则是什么？',
      answer: '允许规则必须明确审批范围。',
      excerpt: '允许规则必须明确审批范围。',
    },
    {
      question: '要求说明是什么？',
      answer: '要求说明包含完整材料列表。',
      excerpt: '要求说明包含完整材料列表。',
    },
  ])('accepts a relevant reformulation or exact NFC source sentence: $answer', (fixture) => {
    expect(validateGroundedFixture(fixture)).toMatchObject({
      outcome: 'answered',
      validationCode: 'accepted',
    });
  });

  it('rejects an unrelated exact source sentence appended to a relevant answer', () => {
    expect(
      validateGroundedFixture({
        question: QUESTION,
        answer: `${GROUNDED_ANSWER}火星天气晴朗。`,
        excerpt: `${GROUNDED_ANSWER}火星天气晴朗。`,
      }),
    ).toMatchObject({ outcome: 'failed', validationCode: 'rejected' });
  });

  it.each(['free', 'wallet'] as const)(
    'releases a rejected v2 %s reservation without exposing candidate material',
    async (source) => {
      const context = await runtime(
        {
          deltas: ['私有候选文本'],
          invokeNamedTools: [
            { name: 'knowledge_search', params: { query: '免费额度' } },
            {
              name: 'submit_knowledge_answer',
              params: {
                status: 'answered',
                answer: '前三次成功回答免费，之后需要支付 100 元。',
                citationChunkIds: [CHUNK],
              },
            },
          ],
        },
        60_000,
        createDisabledSandboxBackend(),
        15_000,
        groundedGate(),
        '前三次用完以后为什么会提示余额不足？',
      );
      if (source === 'wallet') {
        context.db.seedBillingAccount(CONSUMER, 100n);
        context.db.seedFreeAllowance({
          ownerUserId: CONSUMER,
          capabilityId: CAPABILITY,
          freeLimit: 3,
          freeUsed: 3,
        });
      }
      await context.start();
      await waitFor(() => context.db.agentUsageReceipts.size === 1);
      expect([...context.db.usageCharges.values()][0]).toMatchObject({
        charge_source: source,
        status: 'released',
        execution_outcome: 'failed',
      });
      expect([...context.db.agentUsageReceipts.values()][0]).toMatchObject({
        validator_policy_version: 'knowledge-agent-grounded-validator-v2',
        validation_code: 'rejected',
        response_message_id: null,
      });
      expect(context.db.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
      expect(JSON.stringify(context.db.messages)).not.toContain('私有候选文本');
      const allowance = [...context.db.billingFreeAllowances.values()][0]!;
      expect(allowance).toMatchObject({
        free_used_count: source === 'wallet' ? 3 : 0,
        free_reserved_count: 0,
      });
      if (source === 'wallet') {
        expect(context.db.billingAccounts.get(CONSUMER)).toMatchObject({
          balance_cents: 100n,
          reserved_cents: 0n,
        });
      }
      await context.runner.dispose();
    },
  );

  it.each(['free', 'wallet'] as const)(
    'settles one authoritative v2 %s answer and replays it without re-execution',
    async (source) => {
      const context = await runtime(
        {
          deltas: ['私有候选文本'],
          invokeNamedTools: [
            { name: 'knowledge_search', params: { query: '免费额度 余额不足' } },
            {
              name: 'submit_knowledge_answer',
              params: {
                status: 'answered',
                answer: MULTI_GROUNDED_ANSWER,
                citationChunkIds: [CHUNK, SECOND_CHUNK],
              },
            },
          ],
          finalMessages: [
            { role: 'assistant', content: [{ type: 'text', text: '伪造 transcript' }] },
          ],
        },
        60_000,
        createDisabledSandboxBackend(),
        15_000,
        groundedGate(),
        MULTI_GROUNDED_QUESTION,
      );
      if (source === 'wallet') {
        context.db.seedBillingAccount(CONSUMER, 100n);
        context.db.seedFreeAllowance({
          ownerUserId: CONSUMER,
          capabilityId: CAPABILITY,
          freeLimit: 3,
          freeUsed: 3,
        });
      }
      expect((await context.start()).status).toBe('started');
      await waitFor(() => context.db.agentUsageReceipts.size === 1);
      expect(context.agent.calls).toHaveLength(1);
      expect(context.db.messages.filter((message) => message.role === 'assistant')).toEqual([
        expect.objectContaining({ content: [{ type: 'text', text: MULTI_GROUNDED_ANSWER }] }),
      ]);
      expect([...context.db.usageCharges.values()]).toEqual([
        expect.objectContaining({
          charge_source: source,
          status: 'completed',
          execution_outcome: 'answered',
          settled_cents: source === 'wallet' ? 1n : 0n,
        }),
      ]);
      expect([...context.db.agentUsageReceipts.values()]).toEqual([
        expect.objectContaining({
          validator_policy_version: 'knowledge-agent-grounded-validator-v2',
          validation_code: 'accepted',
          response_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          knowledge_resource_digest: binding.knowledge.resourceDigest,
          citation_chunk_ids: [CHUNK, SECOND_CHUNK],
        }),
      ]);
      const initialReceipt = [...context.db.agentUsageReceipts.values()][0]!;
      const initialResponseDigest = initialReceipt.response_digest;
      const initialResponseMessageId = initialReceipt.response_message_id;
      expect(JSON.stringify(context.db.messages)).not.toContain('私有候选文本');
      expect(JSON.stringify(context.db.messages)).not.toContain('伪造 transcript');

      expect((await context.start()).status).toBe('replayed');
      expect(context.agent.calls).toHaveLength(1);
      expect(context.db.usageCharges.size).toBe(1);
      expect(context.db.agentUsageReceipts.size).toBe(1);
      expect([...context.db.agentUsageReceipts.values()][0]).toMatchObject({
        response_digest: initialResponseDigest,
        response_message_id: initialResponseMessageId,
        knowledge_resource_digest: binding.knowledge.resourceDigest,
        citation_chunk_ids: [CHUNK, SECOND_CHUNK],
      });
      expect(context.db.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
      expect([...context.db.billingFreeAllowances.values()][0]).toMatchObject({
        free_used_count: source === 'wallet' ? 3 : 1,
        free_reserved_count: 0,
      });
      if (source === 'wallet') {
        expect(context.db.billingAccounts.get(CONSUMER)).toMatchObject({
          balance_cents: 99n,
          reserved_cents: 0n,
        });
        expect(context.db.walletLedger.size).toBe(1);
      }
      await context.runner.dispose();
    },
  );

  it('requires an empty insufficient submission and releases it with zero settlement', async () => {
    const tools = createKnowledgeToolSession({
      knowledge: resolved.knowledge,
      turnSignal: new AbortController().signal,
    });
    await executeTool(tools, 'knowledge_search', { query: '不存在的问题' });
    await expect(
      executeTool(tools, 'submit_knowledge_answer', {
        status: 'insufficient_evidence',
        answer: '不允许的答案',
      }),
    ).rejects.toThrow('cannot contain an answer or citations');

    const context = await runtime(
      {
        invokeNamedTools: [
          { name: 'knowledge_search', params: { query: '不存在的问题' } },
          { name: 'submit_knowledge_answer', params: { status: 'insufficient_evidence' } },
        ],
      },
      60_000,
      createDisabledSandboxBackend(),
      15_000,
      groundedGate(),
      '知识库没有覆盖的陌生问题',
    );
    await context.start();
    await waitFor(() => context.db.agentUsageReceipts.size === 1);
    expect([...context.db.usageCharges.values()][0]).toMatchObject({
      status: 'released',
      settled_cents: 0n,
      execution_outcome: 'insufficient_evidence',
    });
    expect([...context.db.agentUsageReceipts.values()][0]).toMatchObject({
      execution_outcome: 'insufficient_evidence',
      validation_code: 'insufficient_evidence',
      citation_chunk_ids: [],
      settled_cents: 0n,
    });
    expect([...context.db.billingFreeAllowances.values()][0]).toMatchObject({
      free_used_count: 0,
      free_reserved_count: 0,
    });
    await context.runner.dispose();
  });
  it('terminalizes knowledge shutdown while legacy sandbox cleanup exceeds the deadline', async () => {
    const sandbox = {
      ...createDisabledSandboxBackend(),
      enabled: true,
      interruptSession: () => new Promise<void>(() => undefined),
    };
    const context = await runtime(
      { deltas: ['私有候选'], hangUntilAbort: true },
      60_000,
      sandbox,
      25,
    );
    await context.start();
    const knowledgeTurn = [...context.db.turns.values()][0]!;
    const legacy = await createSession(context.db, {
      capabilityId: CAPABILITY,
      ownerUserId: CONSUMER,
    });
    await context.runner.startTurn({
      session: legacy,
      definition,
      text: 'legacy cleanup must not block knowledge',
      usageId: '00000000-0000-4000-8000-000000000008',
      capabilityOwnerUserId: CREATOR,
      log: silentLog,
    });
    await waitFor(() => context.agent.calls.length === 2);
    await context.runner.dispose();
    await waitFor(() => context.db.agentUsageReceipts.size === 1);
    expect(knowledgeTurn).toMatchObject({
      status: 'interrupted',
      last_error: { code: 'TURN_SHUTDOWN' },
    });
    expect(
      [...context.db.turns.values()].find((turn) => turn.session_id === legacy.id)?.status,
    ).toBe('running');
    expect([...context.db.usageCharges.values()][0]).toMatchObject({
      status: 'released',
      execution_outcome: 'interrupted',
    });
    expect([...context.db.agentUsageReceipts.values()][0]).toMatchObject({
      validation_code: 'not_run',
      response_message_id: null,
      runtime_source_sha: SOURCE_SHA,
    });
    expect(JSON.stringify(context.db.messages)).not.toContain('私有候选');
    expect(JSON.stringify(context.eventLog.entries(context.session.id))).not.toContain('私有候选');
  });
  it('lets a local interrupt win the knowledge terminal CAS after a valid submission', async () => {
    const context = await runtime({
      deltas: ['私有候选'],
      invokeNamedTools: [
        { name: 'knowledge_search', params: { query: '免费额度' } },
        {
          name: 'submit_knowledge_answer',
          params: { status: 'answered', answer: ANSWER, citationChunkIds: [CHUNK] },
        },
      ],
    });
    const originalQuery = context.db.query.bind(context.db);
    let release!: () => void;
    let reached!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const terminalReached = new Promise<void>((resolve) => (reached = resolve));
    let armed = true;
    context.db.query = (async (sql: string, params: unknown[] = []) => {
      if (
        armed &&
        sql.replace(/\s+/gu, ' ').trim().startsWith('UPDATE turns SET status = $2') &&
        params[1] === 'completed'
      ) {
        armed = false;
        reached();
        await hold;
      }
      return originalQuery(sql, params);
    }) as FakeDb['query'];
    await context.start();
    await terminalReached;
    expect(await context.runner.interrupt(context.session.id)).toBe(true);
    release();
    await waitFor(
      () =>
        context.db.queries.filter((query) => query.startsWith('UPDATE turns SET status = $2'))
          .length === 2,
    );
    expect([...context.db.turns.values()][0]).toMatchObject({ status: 'interrupted' });
    expect([...context.db.usageCharges.values()][0]).toMatchObject({
      status: 'released',
      execution_outcome: 'interrupted',
    });
    expect([...context.db.agentUsageReceipts.values()]).toEqual([
      expect.objectContaining({ validation_code: 'not_run', response_message_id: null }),
    ]);
    expect(context.db.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    expect(JSON.stringify(context.eventLog.entries(context.session.id))).not.toContain('私有候选');
    await context.runner.dispose();
  });
  it('fails a knowledge idle timeout without exposing candidate text', async () => {
    const context = await runtime({ deltas: ['私有候选'], hangUntilAbort: true }, 1);
    await context.start();
    await waitFor(() => context.db.agentUsageReceipts.size === 1);
    expect([...context.db.turns.values()][0]).toMatchObject({ status: 'failed' });
    expect([...context.db.usageCharges.values()][0]).toMatchObject({
      status: 'released',
      execution_outcome: 'failed',
    });
    expect([...context.db.agentUsageReceipts.values()][0]).toMatchObject({
      validation_code: 'unavailable',
      response_message_id: null,
    });
    expect(JSON.stringify(context.db.messages)).not.toContain('私有候选');
    await context.runner.dispose();
  });
  it('sweeps knowledge after a foreign legacy cleanup fails closed', async () => {
    const context = await runtime({ hangUntilAbort: true });
    await context.start();
    await waitFor(() => context.agent.calls.length === 1);
    const turn = [...context.db.turns.values()][0]!;
    turn.created_at = new Date(Date.now() - TURN_ABANDON_AFTER_MS - 1_000).toISOString();
    turn.status = 'failed';
    await expect(
      createUsageBillingService({ freeUses: 3, unitPriceCents: 1 }).reconcileTerminalReservations(
        context.db,
      ),
    ).resolves.toBe(0);
    expect([...context.db.usageCharges.values()][0]?.status).toBe('reserved');
    turn.status = 'running';
    const legacy = await createSession(context.db, {
      capabilityId: CAPABILITY,
      ownerUserId: CONSUMER,
    });
    const legacyTurn = await createTurn(context.db, {
      id: '00000000-0000-4000-8000-000000000009',
      sessionId: legacy.id,
    });
    context.db.turns.get(legacyTurn.id)!.created_at = turn.created_at;
    const sweeper = createTurnRunner({
      db: context.db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: context.eventLog,
      agentFactory: makeFakeAgentFactory().factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      sweepIntervalMs: 60_000,
      runtimeSourceSha: SOURCE_SHA,
      log: silentLog,
    });
    await waitFor(() => context.db.agentUsageReceipts.size === 1);
    expect(context.db.turns.get(legacyTurn.id)?.status).toBe('running');
    expect(turn.status).toBe('failed');
    expect([...context.db.usageCharges.values()][0]).toMatchObject({
      status: 'released',
      execution_outcome: 'failed',
    });
    expect([...context.db.agentUsageReceipts.values()][0]).toMatchObject({
      execution_outcome: 'failed',
      validation_code: 'unavailable',
      response_message_id: null,
    });
    expect(context.db.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    await context.runner.dispose();
    await sweeper.dispose();
  });
});
