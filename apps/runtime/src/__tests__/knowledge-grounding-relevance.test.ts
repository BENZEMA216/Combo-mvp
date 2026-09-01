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
    {
      question: '用户如何支付？',
      answer: '用户支付 100 元的说明需要审核。',
    },
    {
      question: '用户如何支付？',
      answer: '用户支付 100 元流程需要审核。',
    },
    {
      question: '用户需要支付多少？',
      answer: '用户需要支付 100 元的说明需要审核。',
    },
    { question: '用户如何支付？', answer: '用户支付 100 元的说明将被审核。' },
    { question: '用户如何支付？', answer: '用户支付 100 元的说明由平台审核。' },
    { question: '用户如何支付？', answer: '用户支付 100 元的说明随后审核。' },
    { question: '用户如何支付？', answer: '用户支付 100 元的说明已经提交。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100 元的服务费需要审核。' },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 100 元的服务费规定需要审核。',
    },
    { question: '用户如何支付服务费？', answer: '用户支付 100 元的服务费将被审核。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100 元的服务费由平台审核。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100 元的服务费随后审核。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100 元的服务费已经提交。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100 元的服务费发生变化。' },
    { question: '用户如何支付服务费？', answer: '用户支付服务费。' },
    {
      question: '用户的支付宝如何登录？',
      answer: '用户的支付 100 元宝登录必须使用验证码。',
    },
    {
      question: '用户如何使用支付宝支付？',
      answer: '用户使用 100 元支付宝支付并完成订单。',
    },
    {
      question: '用户如何支付 100 元服务费？',
      answer: '用户支付 200 元 100 元服务费并完成订单。',
    },
    {
      question: '用户是否支付服务费？',
      answer: '用户支付 100 元服务费并完成订单。',
    },
    {
      question: '用户为何支付服务费？',
      answer: '用户支付 100 元服务费并完成订单。',
    },
    { question: '如何支付服务费？', answer: '支付 100 元服务费并完成订单。' },
    { question: '关于如何支付服务费？', answer: '关于支付 100 元服务费并完成订单。' },
    { question: '对于如何支付服务费？', answer: '对于支付 100 元服务费并完成订单。' },
    { question: '目前如何支付服务费？', answer: '目前支付 100 元服务费并完成订单。' },
    { question: '现在如何支付服务费？', answer: '现在支付 100 元服务费并完成订单。' },
    { question: '一般如何支付服务费？', answer: '一般支付 100 元服务费并完成订单。' },
    { question: '相关如何支付服务费？', answer: '相关支付 100 元服务费并完成订单。' },
    { question: '这里如何支付服务费？', answer: '这里支付 100 元服务费并完成订单。' },
    {
      question: '用户如何支付人民币 100 元服务费？',
      answer: '用户支付 200 元人民币 100 元服务费并完成订单。',
    },
    {
      question: '用户如何支付 RMB100 服务费？',
      answer: '用户支付 200 元 RMB100 服务费并完成订单。',
    },
    {
      question: '用户如何支付 USD100 服务费？',
      answer: '用户支付 200 元 USD100 服务费并完成订单。',
    },
    {
      question: '用户如何支付 ¥100 服务费？',
      answer: '用户支付 200 元 ¥100 服务费并完成订单。',
    },
    {
      question: '用户如何支付 ￥１００ 服务费？',
      answer: '用户支付 200 元 ￥１００ 服务费并完成订单。',
    },
    {
      question: '用户如何支付约 100 元服务费？',
      answer: '用户支付 200 元约 100 元服务费并完成订单。',
    },
    {
      question: '用户如何支付共 100 元服务费？',
      answer: '用户支付 200 元共 100 元服务费并完成订单。',
    },
    {
      question: '用户如何支付大约 100 元服务费？',
      answer: '用户支付 200 元大约 100 元服务费并完成订单。',
    },
    {
      question: '用户如何支付至少 100 元服务费？',
      answer: '用户支付 200 元至少 100 元服务费并完成订单。',
    },
    {
      question: '用户如何支付 EUR100 服务费？',
      answer: '用户支付 200 元 EUR100 服务费并完成订单。',
    },
    { question: '用户如何支付半元服务费？', answer: '用户支付 200 元半元服务费并完成订单。' },
    {
      question: '用户如何支付壹佰块服务费？',
      answer: '用户支付 200 元壹佰块服务费并完成订单。',
    },
    { question: '用户如何支付？', answer: '用户支付 100 元的说明需要审核费用。' },
    { question: '用户如何支付？', answer: '用户支付 100 元的说明需要支付审核费。' },
    { question: '用户如何支付？', answer: '用户支付 1 5 元服务费并完成订单。' },
    { question: '用户如何支付？', answer: '用户支付 1 . 5 元服务费并完成订单。' },
    { question: '用户如何支付？', answer: '用户支付 1 5 元并完成订单。' },
    { question: '用户如何支付？', answer: '用户支付 1 . 5 元并完成订单。' },
    { question: '2024 如何支付服务费？', answer: '2024 支付 100 元服务费并完成订单。' },
    { question: 'RMB100 如何支付服务费？', answer: 'RMB100 支付 100 元服务费并完成订单。' },
    { question: '用户如何支付？', answer: '用户支付的服务费并完成订单。' },
    {
      question: '用户如何支付的服务费？',
      answer: '用户支付 100 元的服务费并完成订单。',
    },
    {
      question: '用户使用哪种方式登录？',
      answer: '用户使用 OAuth 方式登录方式登录并完成验证。',
    },
    {
      question: '用户使用哪种方式登录？',
      answer: '用户使用验证码方式登录说明方式登录并完成验证。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 100 元服务费服务费并完成订单。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 100 元服务费说明服务费并完成订单。',
    },
  ])('rejects a short action used as an object or nominal: $answer', (fixture) => {
    expectRejected(fixture);
  });

  it.each([
    { question: '价格是多少？', answer: '价格是很多。' },
    { question: '退款材料需要多少？', answer: '退款材料需要很多。' },
    { question: '登录方式是哪种？', answer: '登录方式是很多。' },
    { question: '登录方式是哪种？', answer: '登录方式是多种。' },
    { question: '登录方式是哪种？', answer: '登录方式是若干种。' },
    { question: '登录方式是哪种？', answer: '登录方式是非常多。' },
    { question: '登录方式是哪种？', answer: '登录方式是某种。' },
    { question: '登录方式是哪种？', answer: '登录方式是很多选项。' },
    { question: '登录方式是哪种？', answer: '登录方式是任意选项。' },
    { question: '登录方式是哪种？', answer: '登录方式是很多登录方式。' },
    { question: '登录方式是哪种？', answer: '登录方式是任意一种选项。' },
    { question: '登录方式是哪种？', answer: '登录方式是许多可选方式。' },
    { question: '登录方式是哪种？', answer: '登录方式是两种。' },
    { question: '登录方式是哪种？', answer: '登录方式是数种选项。' },
    { question: '登录方式是哪种？', answer: '登录方式是随意一种。' },
    { question: '登录方式是哪种？', answer: '登录方式是都行。' },
    { question: '登录方式是哪种？', answer: '登录方式是不做限定。' },
    { question: '登录方式是哪种？', answer: '登录方式是不限类型。' },
    { question: '哪些账户可以登录？', answer: '所有管理员账户可以登录。' },
    { question: '哪种方式可以登录？', answer: '任意验证码方式可以登录。' },
    { question: '登录方式是哪种？', answer: '登录方式是微信。' },
    { question: '登录方式是哪种？', answer: '登录方式是短信。' },
    { question: '登录方式是哪种？', answer: '登录方式是动态口令。' },
    { question: '登录方式是哪种？', answer: '登录方式是看情况。' },
    { question: '登录方式是哪种？', answer: '登录方式是视情况。' },
    { question: '登录方式是哪种？', answer: '登录方式是任意值。' },
    { question: '登录方式是哪种？', answer: '登录方式是随便选。' },
    { question: '登录账户是哪种？', answer: '登录账户是其他人。' },
    { question: '登录方式是哪种？', answer: '登录方式是 A。' },
    { question: '登录方式是哪种？', answer: '登录方式是 the。' },
    { question: '登录方式是哪种？', answer: '登录方式是 any option。' },
    { question: '登录方式是哪种？', answer: '登录方式是 unknown value。' },
    { question: '登录方式是哪种？', answer: '登录方式是 many choices。' },
    { question: '登录方式是哪种？', answer: '登录方式是 OAuth SAML。' },
    { question: '登录方式是哪种？', answer: '登录方式是 OAuth/SAML。' },
    { question: '登录方式是哪种？', answer: '登录方式是 of。' },
    { question: '登录方式是哪种？', answer: '登录方式是 and。' },
    { question: '登录方式是哪种？', answer: '登录方式是 is。' },
    { question: '登录方式是哪种？', answer: '登录方式是 no。' },
    { question: '登录方式是哪种？', answer: '登录方式是 none。' },
    { question: '登录方式是哪种？', answer: '登录方式是 all。' },
    { question: '登录方式是哪种？', answer: '登录方式是 other。' },
    { question: '价格是多少？', answer: '价格是 100 元的。' },
    { question: '退款材料需要多少？', answer: '退款材料需要 2 份的。' },
    { question: '退款需要多少份材料？', answer: '退款需要 2 的份材料。' },
    { question: '退款需要多少材料？', answer: '退款需要 2 的材料。' },
    { question: '用户需要支付多少？', answer: '用户需要支付 100 元的。' },
    { question: '用户如何支付服务费？', answer: '用户支付 2 的服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 2 份的服务费并完成订单。' },
    { question: '用户需要支付多少服务费？', answer: '用户需要支付 2 的服务费。' },
    { question: '用户需要支付多少服务费？', answer: '用户需要支付 2 份的服务费。' },
    { question: '用户如何支付服务费？', answer: '用户支付 1 5 元的服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 1 . 5 元的服务费并完成订单。' },
    { question: '退款需要多少份材料？', answer: '退款需要 2 3 份材料。' },
    { question: '退款需要多少份材料？', answer: '退款需要 2 个份材料。' },
    { question: '退款需要多少份材料？', answer: '退款需要 2 份份材料。' },
    { question: '退款需要多少份材料？', answer: '退款需要 2 元份材料。' },
    { question: '退款需要多少份材料？', answer: '退款需要 2 USD 份材料。' },
    { question: '账户需要多少人登录？', answer: '账户需要 2 个人登录。' },
    { question: '账户需要多少人登录？', answer: '账户需要 2 人人登录。' },
    { question: '账户需要多少人登录？', answer: '账户需要 2 元人登录。' },
    { question: '货物需要多少公斤？', answer: '货物需要 2 元公斤并完成称重。' },
    { question: '任务需要多少小时？', answer: '任务需要 2 人小时并完成统计。' },
    { question: '路程是多少公里？', answer: '路程是 2 元公里并完成测量。' },
    { question: '价格需要多少美元？', answer: '价格需要 2 元美元并完成确认。' },
    { question: '退款需要多少份材料？', answer: '退款需要 2 份材料份材料。' },
    {
      question: '退款需要多少份材料？',
      answer: '退款需要 2 份材料并完成审核份材料。',
    },
  ])('rejects an untyped value for a trailing quantity or choice slot: $answer', (fixture) => {
    expectRejected(fixture);
  });

  it.each([
    { question: '登录方式是哪种？', answer: '登录方式是 .OAuth。' },
    { question: '登录方式是哪种？', answer: '登录方式是 OAuth-。' },
    { question: '登录方式是哪种？', answer: '登录方式是 /OAuth。' },
    {
      question: '用户使用哪种方式登录？',
      answer: '用户使用 OAuth#方式登录并完成验证。',
    },
    { question: '用户如何支付服务费？', answer: '用户支付 .5 元服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100. 元服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 -100 元服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 ¥100 元服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100#元服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100 元#服务费并完成订单。' },
    { question: '退款需要多少份材料？', answer: '退款需要 -2 份材料。' },
    { question: '退款需要多少份材料？', answer: '退款需要 2. 份材料。' },
    { question: '用户如何支付服务费？', answer: '据 称用户支付 100 元服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '据#称用户支付 100 元服务费并完成订单。' },
    { question: '退款规则是什么？', answer: '退款规则似#乎允许七天内申请。' },
    { question: '用户如何支付？', answer: '用户支付 100 元的说 明需要审核费用。' },
    { question: '用户如何支付？', answer: '用户支付 100 元的说#明需要审核费用。' },
    { question: '用户如何支付？', answer: '用户支付 100 元的说（明）需要审核费（用）。' },
    { question: '退款规则是什么？', answer: '退款规则本 身就是退款规则。' },
    { question: '退款规则是什么？', answer: '退款规则本#身就是退款规则。' },
    { question: '退款规则是什么？', answer: '退款规则似（乎）允许七天内申请。' },
    { question: '用户如何支付？', answer: '据（称）用户支付 100 元并完成订单。' },
  ])('rejects an unsafe separator instead of erasing it: $answer', (fixture) => {
    expectRejected(fixture);
  });

  it.each([
    '登录方式是 OAuth()。',
    '登录方式是 ()OAuth。',
    '登录方式是 OAuth（。',
    '登录方式是 OAuth）。',
    '登录方式是 "OAuth。',
    '登录方式是 OAuth"。',
    '登录方式是 ((OAuth。',
    '登录方式是 OAuth))。',
    '登录方式是 OAuth[]。',
    '登录方式是 []OAuth。',
    '登录方式是 OAuth「」。',
    '登录方式是 支付(宝)。',
    '登录方式是 验(证)码。',
    '登录方式是 管(理)员。',
    '登录方式是 前(三)次。',
  ])('rejects an empty, unbalanced, or partial choice wrapper: %s', (answer) => {
    expectRejected({ question: '登录方式是哪种？', answer });
  });

  it.each([
    { question: '用户如何支付服务费？', answer: '用户支付 100 元服（务）费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100 元服“务”费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100(元)服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 壹(佰)元服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100 元(的)服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用（户）支付 100 元服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支（付）100 元服务费并完成订单。' },
    { question: '退款需要多少份材料？', answer: '退款需要 2（份）材料并完成审核。' },
    {
      question: '用户使用哪种方式登录？',
      answer: '用户使用验（证）码方式登录并完成验证。',
    },
  ])('rejects a wrapper that only encloses part of a structural value: $answer', (fixture) => {
    expectRejected(fixture);
  });

  it.each([
    {
      question: `退款需要${'\u{e000}'}份材料？`,
      answer: '退款需要 2 份材料并完成审核。',
    },
    {
      question: `登录方式是${'\u{e001}'}？`,
      answer: '登录方式是 OAuth。',
    },
    {
      question: `用户支付${'\u{e002}'}服务费吗？`,
      answer: '用户支付 100 元服务费并完成订单。',
    },
    {
      question: `退款规则${'\u{e003}'}是什么？`,
      answer: '退款规则允许七天内申请。',
    },
    {
      question: `退款规则${'\u{e004}'}是什么？`,
      answer: '退款规则允许七天内申请。',
    },
    {
      question: `退款规则${'\u{e005}'}是什么？`,
      answer: '退款规则允许七天内申请。',
    },
    {
      question: `退款规则${'\u{e006}'}是什么？`,
      answer: '退款规则允许七天内申请。',
    },
  ])('rejects a user-supplied private question marker', (fixture) => {
    expectRejected(fixture);
  });

  it.each([
    { question: '用户如何支付服务费？', answer: '用户支付 100 元服务费后后完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100 元服务费即可即可完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100 元服务费即可然后完成订单。' },
  ])('rejects a repeated or reversed outcome-continuation sequence: $answer', (fixture) => {
    expectRejected(fixture);
  });

  it.each([
    { question: '价格是多少？', answer: '价格是 100 元。' },
    { question: '退款材料需要多少？', answer: '退款材料需要 2 份。' },
    { question: '退款需要多少份材料？', answer: '退款需要 2 份材料并完成审核。' },
    { question: '账户需要多少人登录？', answer: '账户需要 2 人登录。' },
    { question: '货物需要多少公斤？', answer: '货物需要 2 公斤并完成称重。' },
    { question: '登录方式是哪种？', answer: '登录方式是验证码。' },
    { question: '支付方式是哪种？', answer: '支付方式是支付宝。' },
    { question: '登录方式是哪种？', answer: '登录方式是 OAuth。' },
    { question: '登录方式是哪种？', answer: '登录方式是 2FA。' },
    { question: '登录方式是哪种？', answer: '登录方式是 OAuth2.0。' },
    { question: '登录方式是哪种？', answer: '登录方式是 OAuth-2。' },
    { question: '登录方式是哪种？', answer: '登录方式是 OAuth_2.0。' },
    { question: '登录方式是哪种？', answer: '登录方式是（OAuth）。' },
    { question: '登录方式是哪种？', answer: '登录方式是“OAuth”。' },
    { question: '登录方式是哪种？', answer: '登录方式是（支付宝）。' },
    { question: '登录方式是哪种？', answer: '登录方式是（“OAuth”）。' },
    { question: '退款需要多少份材料？', answer: '退款需要（2）份材料并完成审核。' },
    { question: '用户需要支付多少？', answer: '用户需要支付 100 元。' },
    { question: '用户如何支付？', answer: '用户支付 100 元服务费并完成订单。' },
    { question: '用户如何支付服务费？', answer: '用户支付 100 元服务费并完成订单。' },
    { question: '用户需要支付多少服务费？', answer: '用户需要支付 100 元服务费。' },
    { question: '用户如何支付？', answer: '用户支付 100 元的服务费并完成订单。' },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 100 元的服务费并完成订单。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付（100 元）的服务费并完成订单。',
    },
    {
      question: '用户需要支付多少服务费？',
      answer: '用户需要支付 100 元的服务费。',
    },
    {
      question: '用户，如何支付服务费？',
      answer: '用户支付 100 元服务费并完成订单。',
    },
    {
      question: 'API 如何支付服务费？',
      answer: 'API 支付 100 元服务费并完成订单。',
    },
    {
      question: '用户如何支付说明书费用？',
      answer: '用户支付 100 元的说明书费用并完成订单。',
    },
    {
      question: '用户如何支付申请材料费？',
      answer: '用户支付 100 元的申请材料费并完成订单。',
    },
    { question: '用户如何支付学费？', answer: '用户支付 100 元的学费并完成订单。' },
    { question: '用户如何支付水费？', answer: '用户支付 100 元的水费并完成订单。' },
    { question: '用户如何支付费用？', answer: '用户支付 100 元的费用并完成订单。' },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 100 元服务费后完成订单。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 100 元服务费然后完成订单。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 100 元服务费即可完成订单。',
    },
    {
      question: '用户使用哪种方式登录？',
      answer: '用户使用验证码方式登录并完成验证。',
    },
    {
      question: '用户使用哪种方式登录？',
      answer: '用户使用 OAuth 方式登录并完成验证。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 5 角的服务费并完成订单。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 5 分的服务费并完成订单。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 1.5 元的服务费并完成订单。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付壹佰元的服务费并完成订单。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 1.5 元服务费并完成订单。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 5 角服务费并完成订单。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付壹佰元服务费并完成订单。',
    },
    {
      question: '用户如何支付服务费？',
      answer: '用户支付 100 元服务费后即可完成订单。',
    },
    { question: '退款规则是什么？', answer: '退款规则允许七天内申 请。' },
    { question: '用户如何支付？', answer: '用户支付 一百元并完成订单。' },
    { question: '用户如何支付？', answer: '用户支付 壹佰元并完成订单。' },
    { question: '用户如何支付？', answer: '用户支付 伍角并完成订单。' },
    { question: '用户如何支付？', answer: '用户支付 一百元服务费并完成订单。' },
    { question: '用户如何支付？', answer: '用户支付 壹佰元的服务费并完成订单。' },
  ])(
    'accepts a typed value for a trailing quantity or choice slot: $question -> $answer',
    (fixture) => {
      expectAccepted(fixture);
    },
  );

  it.each([
    { question: '用户如何支付？', answer: '据称用户支付 100 元并完成订单。' },
    { question: '退款规则是什么？', answer: '退款规则暂定允许七天内申请。' },
    { question: '退款规则是什么？', answer: '退款规则据称允许七天内申请。' },
    { question: '退款规则是什么？', answer: '退款规则似乎允许七天内申请。' },
  ])('rejects a subject-bearing topic under an unrequested local scope: $answer', (fixture) => {
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
