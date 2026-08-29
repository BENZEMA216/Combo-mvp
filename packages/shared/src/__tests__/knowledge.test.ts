import { describe, expect, it } from 'vitest';

import {
  AgentBindingSchema,
  INSUFFICIENT_EVIDENCE_ANSWER,
  KnowledgeCentsSchema,
  KnowledgeTurnResultSchema,
  SessionDetailSchema,
  type KnowledgeAgentBinding,
} from '../index.js';

const CAPABILITY_ID = '11111111-1111-4111-8111-111111111111';
const CAPABILITY_ID_2 = '11111111-1111-4111-8111-222222222222';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const RECEIPT_ID = '33333333-3333-4333-8333-333333333333';
const USAGE_ID = '44444444-4444-4444-8444-444444444444';
const TURN_ID = '55555555-5555-4555-8555-555555555555';
const MESSAGE_ID = '66666666-6666-4666-8666-666666666666';
const RECEIPT_ID_2 = '77777777-7777-4777-8777-777777777777';
const USAGE_ID_2 = '88888888-8888-4888-8888-888888888888';
const TURN_ID_2 = '99999999-9999-4999-8999-999999999999';
const MESSAGE_ID_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PACKAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const RESOURCE_DIGEST = `sha256:${'b'.repeat(64)}`;
const RESPONSE_DIGEST = `sha256:${'c'.repeat(64)}`;
const SOURCE_SHA = 'd'.repeat(40);
const RELEASE_ID = `release.agent-package.${'e'.repeat(32)}`;
const CHUNK_1 = `chunk.knowledge.${'1'.repeat(32)}`;
const CHUNK_2 = `chunk.knowledge.${'2'.repeat(32)}`;
const SOURCE_1 = `source.knowledge.${'3'.repeat(32)}`;

const binding: KnowledgeAgentBinding = {
  productKind: 'knowledge_agent_test',
  capability: {
    id: CAPABILITY_ID,
    protocol: 'combo.agent-package-capability/2',
  },
  release: {
    protocol: 'combo.agent-package-release/1',
    releaseId: RELEASE_ID,
    packageDigest: PACKAGE_DIGEST,
  },
  releaseScope: 'controlled_test',
  knowledge: {
    protocol: 'combo.knowledge-bundle/1',
    resourcePath: 'skills/knowledge/references/knowledge-bundle.json',
    resourceDigest: RESOURCE_DIGEST,
  },
};

function billing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policyVersion: 'runtime-usage-v1',
    source: 'free',
    currency: 'CNY',
    unitPriceCents: '1',
    settledCents: '0',
    freeLimitSnapshot: 3,
    ...overrides,
  };
}

function answerRecord(
  text = '这是已核验的回答。',
  messageId = MESSAGE_ID,
): Record<string, unknown> {
  return { messageId, text, responseDigest: RESPONSE_DIGEST };
}

function answered(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 'combo.agent-usage-receipt/1',
    receiptId: RECEIPT_ID,
    usageId: USAGE_ID,
    turnId: TURN_ID,
    createdAt: '2026-08-30T10:00:00+08:00',
    binding,
    billing: billing(),
    validation: {
      policyVersion: 'knowledge-evidence-v1',
      code: 'accepted',
    },
    runtime: {
      environment: 'test',
      releaseId: `release-${SOURCE_SHA}`,
      sourceSha: SOURCE_SHA,
    },
    outcome: 'answered',
    answer: answerRecord(),
    citations: [
      { chunkId: CHUNK_1, sourceId: SOURCE_1, displayLabel: '公开规范' },
      { chunkId: CHUNK_2, sourceId: SOURCE_1, displayLabel: '公开规范' },
    ],
    ...overrides,
  };
}

function insufficient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...answered(),
    outcome: 'insufficient_evidence',
    validation: {
      policyVersion: 'knowledge-evidence-v1',
      code: 'insufficient_evidence',
    },
    answer: {
      messageId: MESSAGE_ID,
      text: INSUFFICIENT_EVIDENCE_ANSWER,
      responseDigest: RESPONSE_DIGEST,
    },
    citations: [],
    ...overrides,
  };
}

function failed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...answered(),
    outcome: 'failed',
    validation: { policyVersion: 'knowledge-evidence-v1', code: 'protocol_invalid' },
    answer: null,
    citations: [],
    ...overrides,
  };
}

function secondAnswered(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return answered({
    receiptId: RECEIPT_ID_2,
    usageId: USAGE_ID_2,
    turnId: TURN_ID_2,
    answer: answerRecord('这是第二个已核验的回答。', MESSAGE_ID_2),
    ...overrides,
  });
}

function detail(results: unknown[] = []): Record<string, unknown> {
  return {
    session: {
      id: SESSION_ID,
      capabilityId: CAPABILITY_ID,
      mode: 'consume',
      status: 'active',
      createdAt: '2026-08-30T09:00:00+08:00',
      updatedAt: '2026-08-30T10:00:00+08:00',
    },
    capability: {
      id: CAPABILITY_ID,
      name: '知识 Agent',
      summary: '基于固定知识回答',
      kind: 'knowledge',
      inputs: [],
      starterPrompts: [],
    },
    messages: [],
    artifacts: [],
    activeTurn: null,
    latestTerminalTurn: null,
    currentUiArtifactId: null,
    agentBinding: binding,
    knowledgeResults: results,
  };
}

describe('knowledge Agent binding contract', () => {
  it('accepts the exact frozen binding and rejects extra selectors or mutable product fields', () => {
    expect(AgentBindingSchema.safeParse(binding).success).toBe(true);
    expect(
      AgentBindingSchema.safeParse({
        ...binding,
        storageKey: 'tenant/private/object.json',
      }).success,
    ).toBe(false);
    expect(
      AgentBindingSchema.safeParse({
        ...binding,
        release: { ...binding.release, priceCents: '1' },
      }).success,
    ).toBe(false);
    expect(
      AgentBindingSchema.safeParse({
        ...binding,
        release: {
          protocol: binding.release.protocol,
          id: RELEASE_ID,
          packageDigest: binding.release.packageDigest,
        },
      }).success,
    ).toBe(false);
    expect(
      AgentBindingSchema.safeParse({
        ...binding,
        release: { ...binding.release, scope: 'controlled_test' },
      }).success,
    ).toBe(false);
    expect(
      AgentBindingSchema.safeParse({
        productKind: 'legacy_capability',
        release: binding.release,
      }).success,
    ).toBe(false);
  });

  it('keeps old SessionDetail responses rolling-safe but requires explicit empty results for knowledge', () => {
    const legacyDetail = detail();
    const legacyObject = legacyDetail as Record<string, unknown>;
    delete legacyObject.agentBinding;
    delete legacyObject.knowledgeResults;
    expect(SessionDetailSchema.safeParse(legacyObject).success).toBe(true);
    expect(SessionDetailSchema.safeParse(detail()).success).toBe(true);

    const missingResults = detail() as Record<string, unknown>;
    delete missingResults.knowledgeResults;
    expect(SessionDetailSchema.safeParse(missingResults).success).toBe(false);
    expect(
      SessionDetailSchema.safeParse({
        ...legacyObject,
        agentBinding: { productKind: 'legacy_capability' },
        knowledgeResults: [],
      }).success,
    ).toBe(false);
    expect(SessionDetailSchema.safeParse({ ...legacyObject, knowledgeResults: [] }).success).toBe(
      false,
    );
  });

  it('binds knowledge details to consume mode, the same Capability, and user-only messages', () => {
    const base = detail();
    expect(
      SessionDetailSchema.safeParse({
        ...(base as object),
        session: {
          ...(base as { session: object }).session,
          mode: 'studio',
        },
      }).success,
    ).toBe(false);
    for (const mismatchedDetail of [
      {
        ...(base as object),
        session: {
          ...(base as { session: object }).session,
          capabilityId: CAPABILITY_ID_2,
        },
      },
      {
        ...(base as object),
        capability: {
          ...(base as { capability: object }).capability,
          id: CAPABILITY_ID_2,
        },
      },
    ]) {
      expect(SessionDetailSchema.safeParse(mismatchedDetail).success).toBe(false);
    }
    expect(
      SessionDetailSchema.safeParse({
        ...(base as object),
        messages: [
          {
            id: MESSAGE_ID,
            seq: 1,
            turnId: TURN_ID,
            role: 'assistant',
            content: [{ type: 'text', text: '未经核验' }],
            status: 'completed',
            createdAt: '2026-08-30T10:00:00+08:00',
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('knowledge usage receipt contract', () => {
  it('accepts all four exact terminal outcome branches', () => {
    expect(KnowledgeTurnResultSchema.safeParse(answered()).success).toBe(true);
    expect(KnowledgeTurnResultSchema.safeParse(insufficient()).success).toBe(true);
    for (const code of ['not_run', 'rejected', 'unavailable', 'protocol_invalid']) {
      expect(
        KnowledgeTurnResultSchema.safeParse(
          failed({ validation: { policyVersion: 'knowledge-evidence-v1', code } }),
        ).success,
      ).toBe(true);
    }
    expect(
      KnowledgeTurnResultSchema.safeParse({
        ...failed(),
        outcome: 'interrupted',
        validation: { policyVersion: 'knowledge-evidence-v1', code: 'not_run' },
      }).success,
    ).toBe(true);
  });

  it('locks validation, answer, citations, and settlement to the selected outcome', () => {
    expect(
      KnowledgeTurnResultSchema.safeParse(answered({ billing: billing({ settledCents: '1' }) }))
        .success,
    ).toBe(false);
    expect(
      KnowledgeTurnResultSchema.safeParse(
        answered({
          billing: billing({ source: 'wallet', settledCents: '1' }),
        }),
      ).success,
    ).toBe(true);
    expect(
      KnowledgeTurnResultSchema.safeParse(
        answered({
          billing: billing({ source: 'wallet', settledCents: '0' }),
        }),
      ).success,
    ).toBe(false);
    expect(
      KnowledgeTurnResultSchema.safeParse(
        answered({
          billing: billing({ source: 'wallet', unitPriceCents: '1', settledCents: '2' }),
        }),
      ).success,
    ).toBe(false);
    expect(
      KnowledgeTurnResultSchema.safeParse(
        answered({ answer: answerRecord(INSUFFICIENT_EVIDENCE_ANSWER) }),
      ).success,
    ).toBe(false);
    expect(
      KnowledgeTurnResultSchema.safeParse(
        answered({
          billing: billing({ source: 'wallet', unitPriceCents: '0', settledCents: '1' }),
        }),
      ).success,
    ).toBe(false);
    expect(
      KnowledgeTurnResultSchema.safeParse(insufficient({ answer: answerRecord('模型自由文本') }))
        .success,
    ).toBe(false);
    expect(
      KnowledgeTurnResultSchema.safeParse(
        insufficient({
          citations: [{ chunkId: CHUNK_1, sourceId: SOURCE_1, displayLabel: '公开规范' }],
        }),
      ).success,
    ).toBe(false);
    expect(
      KnowledgeTurnResultSchema.safeParse({
        ...failed(),
        outcome: 'interrupted',
        validation: { policyVersion: 'knowledge-evidence-v1', code: 'unavailable' },
      }).success,
    ).toBe(false);
  });

  it('rejects non-canonical money, overflow, runtime drift, and unknown fields', () => {
    for (const value of ['abc', '1.2', '01', '-1', '9223372036854775808']) {
      expect(() => KnowledgeCentsSchema.safeParse(value)).not.toThrow();
      expect(KnowledgeCentsSchema.safeParse(value).success).toBe(false);
    }
    expect(KnowledgeCentsSchema.safeParse('9223372036854775807').success).toBe(true);
    expect(() =>
      KnowledgeTurnResultSchema.safeParse(answered({ billing: billing({ settledCents: 'abc' }) })),
    ).not.toThrow();
    expect(
      KnowledgeTurnResultSchema.safeParse(answered({ billing: billing({ settledCents: 'abc' }) }))
        .success,
    ).toBe(false);
    expect(
      KnowledgeTurnResultSchema.safeParse(
        answered({
          runtime: {
            environment: 'test',
            sourceSha: SOURCE_SHA,
            releaseId: `release-${'f'.repeat(40)}`,
          },
        }),
      ).success,
    ).toBe(false);
    expect(KnowledgeTurnResultSchema.safeParse({ ...answered(), storageKey: 'x' }).success).toBe(
      false,
    );
  });

  it('enforces exact UTF-8 answer bounds and rejects unsafe or non-canonical display text', () => {
    const answerOf = (text: string): unknown => ({
      ...answered(),
      answer: answerRecord(text),
    });
    expect(KnowledgeTurnResultSchema.safeParse(answerOf('a'.repeat(32 * 1_024))).success).toBe(
      true,
    );
    expect(KnowledgeTurnResultSchema.safeParse(answerOf(`${'汉'.repeat(10_922)}ab`)).success).toBe(
      true,
    );
    expect(KnowledgeTurnResultSchema.safeParse(answerOf(`${'汉'.repeat(10_922)}abc`)).success).toBe(
      false,
    );
    for (const text of [' 回答', 'e\u0301', 'safe\u202Ehidden', '\ud800']) {
      expect(KnowledgeTurnResultSchema.safeParse(answerOf(text)).success).toBe(false);
    }
  });

  it('requires canonical unique citations and one label per source identity', () => {
    const citation = (chunkId: string, displayLabel = '公开规范') => ({
      chunkId,
      sourceId: SOURCE_1,
      displayLabel,
    });
    expect(
      KnowledgeTurnResultSchema.safeParse(
        answered({ citations: [citation(CHUNK_2), citation(CHUNK_1)] }),
      ).success,
    ).toBe(false);
    expect(
      KnowledgeTurnResultSchema.safeParse(
        answered({ citations: [citation(CHUNK_1), citation(CHUNK_1)] }),
      ).success,
    ).toBe(false);
    expect(
      KnowledgeTurnResultSchema.safeParse(
        answered({ citations: [citation(CHUNK_1), citation(CHUNK_2, '内部政策')] }),
      ).success,
    ).toBe(false);
    expect(
      KnowledgeTurnResultSchema.safeParse(
        answered({ citations: [citation(CHUNK_1, '公开  规范')] }),
      ).success,
    ).toBe(false);
  });

  it('requires every result to match every selectable field in the Session freeze', () => {
    expect(SessionDetailSchema.safeParse(detail([answered()])).success).toBe(true);
    const mismatchedBindings: unknown[] = [
      { ...binding, capability: { ...binding.capability, id: CAPABILITY_ID_2 } },
      {
        ...binding,
        release: {
          ...binding.release,
          releaseId: `release.agent-package.${'f'.repeat(32)}`,
        },
      },
      {
        ...binding,
        release: { ...binding.release, packageDigest: `sha256:${'f'.repeat(64)}` },
      },
      { ...binding, releaseScope: 'production' },
      {
        ...binding,
        knowledge: { ...binding.knowledge, resourceDigest: `sha256:${'f'.repeat(64)}` },
      },
    ];
    for (const mismatchedBinding of mismatchedBindings) {
      expect(
        SessionDetailSchema.safeParse(detail([answered({ binding: mismatchedBinding })])).success,
      ).toBe(false);
    }
  });

  it('keeps each receipt, usage, Turn, and response Message identity independently unique', () => {
    expect(SessionDetailSchema.safeParse(detail([answered(), secondAnswered()])).success).toBe(
      true,
    );
    for (const duplicateIdentity of [
      { receiptId: RECEIPT_ID },
      { usageId: USAGE_ID },
      { turnId: TURN_ID },
    ]) {
      expect(
        SessionDetailSchema.safeParse(detail([answered(), secondAnswered(duplicateIdentity)]))
          .success,
      ).toBe(false);
    }
    expect(
      SessionDetailSchema.safeParse(
        detail([answered(), secondAnswered({ answer: answerRecord() })]),
      ).success,
    ).toBe(false);
  });

  it('keeps source and chunk citation identities stable across the frozen Bundle', () => {
    expect(
      SessionDetailSchema.safeParse(
        detail([
          answered({
            citations: [{ chunkId: CHUNK_1, sourceId: SOURCE_1, displayLabel: '公开规范' }],
          }),
          secondAnswered({
            citations: [{ chunkId: CHUNK_2, sourceId: SOURCE_1, displayLabel: '内部政策' }],
          }),
        ]),
      ).success,
    ).toBe(false);
    expect(
      SessionDetailSchema.safeParse(
        detail([
          answered({
            citations: [{ chunkId: CHUNK_1, sourceId: SOURCE_1, displayLabel: '公开规范' }],
          }),
          secondAnswered({
            citations: [
              {
                chunkId: CHUNK_1,
                sourceId: `source.knowledge.${'4'.repeat(32)}`,
                displayLabel: '公开规范',
              },
            ],
          }),
        ]),
      ).success,
    ).toBe(false);
  });
});
