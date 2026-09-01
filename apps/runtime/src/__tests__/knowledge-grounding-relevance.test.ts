import { describe, expect, it } from 'vitest';

import { validateKnowledgeCandidate } from '../modules/knowledge-agent/resolver.js';
import type { KnowledgeAgentTestGate } from '../platform/config/env.js';

type GroundedKnowledgeAgentTestGate = Extract<
  KnowledgeAgentTestGate,
  { protocol: 'combo.knowledge-agent-runtime-test-gate/2' }
>;

const CREATOR = '00000000-0000-4000-8000-000000000001';
const CAPABILITY = '00000000-0000-4000-8000-000000000003';
const SOURCE_SHA = '1'.repeat(40);
const CHUNK = `chunk.knowledge.${'2'.repeat(32)}`;

function groundedGate(): GroundedKnowledgeAgentTestGate {
  return {
    protocol: 'combo.knowledge-agent-runtime-test-gate/2',
    sourceSha: SOURCE_SHA,
    publisherUserId: CREATOR,
    capabilityId: CAPABILITY,
    releaseId: `release.agent-package.${'3'.repeat(32)}`,
    packageDigest: `sha256:${'4'.repeat(64)}`,
    validatorPolicyVersion: 'knowledge-agent-grounded-validator-v2',
  };
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

function expectRejected(fixture: { question: string; answer: string; excerpt?: string }): void {
  expect(
    validateGroundedFixture({
      question: fixture.question,
      answer: fixture.answer,
      excerpt: fixture.excerpt ?? fixture.answer,
    }),
  ).toMatchObject({ outcome: 'failed', validationCode: 'rejected' });
}

function expectAccepted(fixture: { question: string; answer: string; excerpt?: string }): void {
  expect(
    validateGroundedFixture({
      question: fixture.question,
      answer: fixture.answer,
      excerpt: fixture.excerpt ?? fixture.answer,
    }),
  ).toMatchObject({ outcome: 'answered', validationCode: 'accepted' });
}

describe('knowledge grounding adversarial relevance', () => {
  it.each([
    { question: '是否允许退款？', answer: '系统不再允许退款。' },
    { question: '是否允许退款？', answer: '系统未必允许退款。' },
    { question: '是否允许退款？', answer: '系统不一定允许退款。' },
    { question: '是否允许退款？', answer: '系统尚未允许退款。' },
    { question: '是否允许退款？', answer: '系统并非允许退款。' },
    { question: '是否允许退款？', answer: '系统从未允许退款。' },
    { question: '是否允许退款？', answer: '系统从不允许退款。' },
    { question: '是否允许退款？', answer: '系统拒绝继续允许退款。' },
    { question: '是否允许退款？', answer: '系统禁止继续允许退款。' },
    { question: '是否支持退款？', answer: '系统不再支持退款。' },
    { question: '是否允许退款？', answer: '系统似乎允许退款并记录申请。' },
    { question: '是否允许退款？', answer: '系统看似允许退款并记录申请。' },
    { question: '是否允许退款？', answer: '系统据称允许退款并记录申请。' },
    { question: '是否允许退款？', answer: '系统貌似允许退款并记录申请。' },
    { question: '是否允许退款？', answer: '系统暂定允许退款并记录申请。' },
    { question: '是否允许退款？', answer: '系统倾向允许退款并记录申请。' },
  ])('rejects a predicate occurrence under a mismatched local scope: $answer', (fixture) => {
    expectRejected(fixture);
  });

  it.each([
    '退款规则是本规则。',
    '退款规则是该规则。',
    '退款规则是此规则。',
    '退款规则是上述规则。',
    '退款规则是这种规则。',
    '退款规则是另一个规则。',
    '退款规则是关于退款的规则。',
    '退款规则是退款的规则。',
    '退款规则是退款与规则。',
    '退款规则是退款及规则。',
    '退款规则是退款之规则。',
    '退款规则是围绕退款规则的规则。',
    '退款规则是有关退款的规则。',
    '退款规则是面向退款的规则。',
  ])('rejects demonstrative or function-word self-reference: %s', (answer) => {
    expectRejected({ question: '退款规则是什么？', answer });
  });

  it.each([
    {
      question: '用户，如何支付？',
      answer: '用户需要完成登录。支付可以使用银行卡。',
    },
    {
      question: '退款，贵吗？',
      answer: '退款规则允许七天内申请。',
    },
    {
      question: 'API v2 如何退款？',
      answer: 'API v2 支持查询，退款可以七天内申请。',
    },
  ])('rejects disconnected question skeleton coverage: $answer', (fixture) => {
    expectRejected(fixture);
  });

  it.each([
    { question: '如何支付？', answer: '订单包含支付。' },
    { question: '如何支付？', answer: '该操作是用户支付。' },
    { question: '如何支付？', answer: '订单包含支付 100 元。' },
    { question: '用户如何支付？', answer: '该操作是用户支付 100 元。' },
    { question: '如何支付？', answer: '关于支付 100 元的说明需要审核。' },
    {
      question: '用户如何支付？',
      answer: '关于用户支付 100 元的说明需要审核。',
    },
  ])('rejects a short action used as an object or nominal: $answer', (fixture) => {
    expectRejected(fixture);
  });

  it.each([
    { question: '退款需要几份材料？', answer: '退款需要 2 份材料。' },
    { question: '退款需要几份材料？', answer: '退款需要两份材料。' },
    { question: '退款需要多少份材料？', answer: '退款需要 2 份材料。' },
    { question: '哪些账户可以登录？', answer: '管理员账户可以登录。' },
    { question: '哪种方式可以登录？', answer: '验证码方式可以登录。' },
    {
      question: '退款规则是什么？API v2 的登录方式是什么？',
      answer: '退款规则允许七天内申请。API v2 的登录方式使用 OAuth。',
    },
    {
      question: 'API v2 的登录方式是什么？HTTP 402 表示什么？',
      answer: 'API v2 的登录方式使用 OAuth。HTTP 402 表示需要充值。',
    },
    { question: '几何是什么？', answer: '几何是数学分支。' },
  ])(
    'accepts supported quantifier and independent multi-question answers: $question',
    (fixture) => {
      expectAccepted(fixture);
    },
  );

  it.each([
    {
      question: '是否据称允许退款？',
      answer: '系统据称允许退款并记录申请。',
    },
    {
      question: '退款规则是什么？',
      answer: '退款规则面向企业用户并允许七天内申请。',
    },
    {
      question: '用户如何支付？',
      answer: '用户支付 100 元并完成订单。',
    },
  ])('keeps the required scope or a direct new fact: $answer', (fixture) => {
    expectAccepted(fixture);
  });

  it.each([
    { question: '退款需要几份材料？', answer: '退款需要份材料。' },
    { question: '退款需要几份材料？', answer: '退款需要很多份材料。' },
    { question: '退款需要几份材料？', answer: '退款应当 2 份材料。' },
    { question: '退款需要几份材料？', answer: '退款需要，2 份材料。' },
    { question: '哪些账户可以登录？', answer: '可以查看订单账户可以登录。' },
    {
      question: '退款规则是什么？API v2 的登录方式是什么？',
      answer: 'API v2 的退款规则允许七天内申请。登录方式使用 OAuth。',
    },
  ])('rejects an empty, changed, cross-clause, or cross-question binding: $answer', (fixture) => {
    expectRejected(fixture);
  });
});
