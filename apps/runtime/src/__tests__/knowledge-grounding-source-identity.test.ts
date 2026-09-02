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

describe('knowledge grounding source identity', () => {
  it.each([
    {
      question: '价格是多少？',
      answer: '价格是 10 0 元。',
      excerpt: '可选值是 10 和 0。价格是 100 元。',
    },
    {
      question: '错误码是什么？',
      answer: '错误码是 40 2。',
      excerpt: '容量是 40，重试两次写作 2。错误码是 402。',
    },
    {
      question: 'API 版本是什么？',
      answer: 'API 版本是 v 2。',
      excerpt: '变量 v 和数字 2 都有定义。API 版本是 v2。',
    },
  ])('rejects whitespace fusion or cross-sentence literal borrowing: $answer', (fixture) => {
    expect(validateGroundedFixture(fixture)).toMatchObject({
      outcome: 'failed',
      validationCode: 'rejected',
    });
  });

  it.each([
    {
      question: 'HTTP 402 表示什么？',
      answer: 'HTTP 402 表示需要充值。',
      excerpt: 'HTTP 402 表示需要充值。',
    },
    {
      question: 'API v2 的验证策略是什么？',
      answer: 'API v2 的验证策略使用新版校验机制。',
      excerpt: 'API v2 的验证策略使用新版校验机制。',
    },
    {
      question: '面积是多少？',
      answer: '面积是 20 m2。',
      excerpt: '面积是 20 m2。',
    },
    {
      question: '费用是多少？',
      answer: '费用是 10² 元。',
      excerpt: '费用是 10² 元。',
    },
  ])('accepts an exact NFC source sentence with preserved literal tokens: $answer', (fixture) => {
    expect(validateGroundedFixture(fixture)).toMatchObject({
      outcome: 'answered',
      validationCode: 'accepted',
    });
  });

  it.each([
    {
      question: '费用是多少？',
      answer: '费用是 102 元。',
      excerpt: '费用是 10² 元。',
    },
    {
      question: '版本是什么？',
      answer: '版本是 IV。',
      excerpt: '版本是 Ⅳ。',
    },
  ])('rejects an NFKC semantic collision: $answer', (fixture) => {
    expect(validateGroundedFixture(fixture)).toMatchObject({
      outcome: 'failed',
      validationCode: 'rejected',
    });
  });

  it('rejects an excerpt boundary fragment but accepts a complete interior source sentence', () => {
    expect(
      validateGroundedFixture({
        question: '退款规则是什么？',
        answer: '…退款规则允许在七天内申请。',
        excerpt: '…退款规则允许在七天内申请。',
      }),
    ).toMatchObject({ outcome: 'failed', validationCode: 'rejected' });
    expect(
      validateGroundedFixture({
        question: '退款规则是什么？',
        answer: '退款规则允许在七天内申请。',
        excerpt: '…前句残片。退款规则允许在七天内申请。后句残片…',
      }),
    ).toMatchObject({ outcome: 'answered', validationCode: 'accepted' });
  });
});
