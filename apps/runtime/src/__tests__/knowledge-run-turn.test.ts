import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digestCreatorAgentPackageFile } from '@cb/creator-agent-protocol/agent-package';
import { createCreatorKnowledgeBundle } from '@cb/creator-agent-protocol/knowledge-bundle';
import type { CapabilityDefinition, KnowledgeAgentBinding } from '@cb/shared';

import { createTurnRunner } from '../modules/agent/run-turn.js';
import { createTurn, TURN_ABANDON_AFTER_MS } from '../modules/agent/turn-repo.js';
import { createUsageBillingService, type UsageRequest } from '../modules/billing/service.js';
import {
  projectKnowledgeResults,
  sweepExpiredKnowledgeTurns,
  type KnowledgeReceiptDbRow,
} from '../modules/knowledge-agent/repo.js';
import {
  createKnowledgeToolSession,
  knowledgeQuestionDigest,
  searchKnowledgeBundle,
  type ResolvedKnowledgeAgent,
} from '../modules/knowledge-agent/resolver.js';
import { createSession, type MessageRecord } from '../modules/session/repo.js';
import type { KnowledgeAgentTestGate } from '../platform/config/env.js';
import { createSessionEventBus } from '../platform/infra/event-bus.js';
import { createInterruptBus } from '../platform/infra/redis-interrupt-bus.js';
import type { SandboxBackend } from '../platform/infra/sandbox-backend.js';
import {
  FakeDb,
  FakeObjectStore,
  FakeSessionEventLog,
  makeFakeAgentFactory,
  silentLog,
  waitFor,
  type FakeAgentScript,
} from './fakes.js';

const CREATOR = '00000000-0000-4000-8000-000000000001';
const CONSUMER = '00000000-0000-4000-8000-000000000002';
const CAPABILITY = '00000000-0000-4000-8000-000000000003';
const SOURCE_SHA = '1'.repeat(40);
const CHUNK = `chunk.knowledge.${'2'.repeat(32)}`;
const SECOND_CHUNK = `chunk.knowledge.${'7'.repeat(32)}`;
const QUESTION = '免费额度是多少？';
const ANSWER = '前三次成功回答免费。';
const digestText = (text: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

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

const content = 'Combo 的前三次成功回答使用免费额度。';
const resolved: ResolvedKnowledgeAgent = {
  binding,
  name: '公开知识助手',
  description: '只依据固定知识回答',
  instructions: '检索知识后提交候选答案。',
  knowledge: createCreatorKnowledgeBundle({
    protocol: 'combo.knowledge-bundle/1',
    chunks: [
      {
        id: CHUNK,
        source: {
          sourceId: `source.knowledge.${'6'.repeat(32)}`,
          displayLabel: '公开计费手册',
        },
        content,
        contentDigest: digestCreatorAgentPackageFile(new TextEncoder().encode(content)),
      },
      {
        id: SECOND_CHUNK,
        source: {
          sourceId: `source.knowledge.${'8'.repeat(32)}`,
          displayLabel: '公开充值手册',
        },
        content: 'Combo 余额不足时返回 402。',
        contentDigest: digestCreatorAgentPackageFile(
          new TextEncoder().encode('Combo 余额不足时返回 402。'),
        ),
      },
    ],
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

function gate(question = QUESTION): KnowledgeAgentTestGate {
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
        questionDigest: knowledgeQuestionDigest(question),
        answer: ANSWER,
        citationChunkIds: [CHUNK],
      },
    ],
  };
}

async function fixture(
  script: FakeAgentScript,
  options: { freeUses?: number; balance?: bigint; sandbox?: SandboxBackend } = {},
) {
  const db = new FakeDb();
  db.seedCapability({ id: CAPABILITY, owner_user_id: CREATOR, published: true });
  if (options.balance !== undefined) db.seedBillingAccount(CONSUMER, options.balance);
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
    idleTimeoutMs: 60_000,
    interrupts: createInterruptBus(),
    sandbox: options.sandbox,
    billingPolicy: { freeUses: options.freeUses ?? 3, unitPriceCents: 1 },
    runtimeSourceSha: SOURCE_SHA,
    log: silentLog,
  });
  const start = (usageId = '00000000-0000-4000-8000-000000000007') =>
    runner.startTurn({
      session,
      definition,
      text: QUESTION,
      usageId,
      capabilityOwnerUserId: CREATOR,
      knowledge: { resolved, gate: gate(), runtimeSourceSha: SOURCE_SHA },
      log: silentLog,
    });
  return { db, session, agent, eventLog, runner, start };
}

function failingSandbox(onInterrupt: () => void): SandboxBackend {
  const unavailable = async (): Promise<never> => Promise.reject(new Error('sandbox unavailable'));
  return {
    enabled: true,
    describe: unavailable,
    read: unavailable,
    write: unavailable,
    edit: unavailable,
    command: unavailable,
    interruptSession: async () => {
      onInterrupt();
      throw new Error('sandbox cleanup failed');
    },
    releaseSession: async () => undefined,
    dispose: async () => undefined,
  };
}

async function waitForReceipt(db: FakeDb): Promise<void> {
  await waitFor(() => db.agentUsageReceipts.size === 1);
}

async function executeKnowledgeTool(
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

describe('knowledge run-turn closed loop', () => {
  it('freezes one exact binding in the Session and rejects a mismatched capability', async () => {
    const db = new FakeDb();
    const session = await createSession(db, {
      capabilityId: CAPABILITY,
      ownerUserId: CONSUMER,
      agentBinding: binding,
    });
    expect(session.agentBinding).toEqual(binding);
    expect(db.sessions.get(session.id)).toMatchObject({
      product_kind: 'knowledge_agent_test',
      capability_protocol: binding.capability.protocol,
      release_id: binding.release.releaseId,
      package_digest: binding.release.packageDigest,
      release_scope: binding.releaseScope,
      knowledge_resource_path: binding.knowledge.resourcePath,
      knowledge_resource_digest: binding.knowledge.resourceDigest,
    });

    await expect(
      createSession(db, {
        capabilityId: '00000000-0000-4000-8000-000000000099',
        ownerUserId: CONSUMER,
        agentBinding: binding,
      }),
    ).rejects.toThrow('binding capability mismatch');
    expect(db.sessions.size).toBe(1);
  });

  it("searches deterministically and fences a submission to this turn's exposed chunks", async () => {
    expect(searchKnowledgeBundle(resolved.knowledge, 'Combo', 8).map((hit) => hit.chunkId)).toEqual(
      [CHUNK, SECOND_CHUNK],
    );
    const toolSession = createKnowledgeToolSession({
      knowledge: resolved.knowledge,
      turnSignal: new AbortController().signal,
    });
    await expect(
      executeKnowledgeTool(toolSession, 'submit_knowledge_answer', {
        status: 'answered',
        answer: ANSWER,
        citationChunkIds: [CHUNK],
      }),
    ).rejects.toThrow('prior search');
    await executeKnowledgeTool(toolSession, 'knowledge_search', { query: '402' });
    await expect(
      executeKnowledgeTool(toolSession, 'submit_knowledge_answer', {
        status: 'answered',
        answer: ANSWER,
        citationChunkIds: [CHUNK],
      }),
    ).rejects.toThrow('not exposed');
    await executeKnowledgeTool(toolSession, 'knowledge_search', { query: '免费额度' });
    await executeKnowledgeTool(toolSession, 'submit_knowledge_answer', {
      status: 'answered',
      answer: ANSWER,
      citationChunkIds: [CHUNK],
    });
    await expect(
      executeKnowledgeTool(toolSession, 'submit_knowledge_answer', {
        status: 'insufficient_evidence',
      }),
    ).rejects.toThrow('already submitted');
  });

  it('shows only the validated answer and settles after the receipt transaction', async () => {
    const context = await fixture({
      deltas: ['这是未经验证的候选文本'],
      invokeNamedTools: [
        { name: 'knowledge_search', params: { query: '免费额度' } },
        {
          name: 'submit_knowledge_answer',
          params: { status: 'answered', answer: ANSWER, citationChunkIds: [CHUNK] },
        },
      ],
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: '伪造 transcript' }] }],
    });
    const started = await context.start();
    expect(started.status).toBe('started');
    await waitForReceipt(context.db);

    const events = context.eventLog.entries(context.session.id).map((entry) => entry.event.type);
    expect(events).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
    expect(events.some((event) => String(event).startsWith('TEXT_MESSAGE'))).toBe(false);
    expect(context.db.messages.map((message) => message.content)).toEqual([
      [{ type: 'text', text: QUESTION }],
      [{ type: 'text', text: ANSWER }],
    ]);
    expect(JSON.stringify(context.db.messages)).not.toContain('未经验证');
    expect(JSON.stringify(context.db.messages)).not.toContain('伪造 transcript');
    expect([...context.db.usageCharges.values()][0]).toMatchObject({
      status: 'completed',
      execution_outcome: 'answered',
    });
    expect(context.agent.calls[0]?.tools.map((tool) => tool.name)).toEqual([
      'knowledge_search',
      'submit_knowledge_answer',
    ]);

    const replay = await context.start();
    expect(replay.status).toBe('replayed');
    expect(context.agent.calls).toHaveLength(1);
    expect(context.db.agentUsageReceipts.size).toBe(1);
    await context.runner.dispose();
  });

  it('returns the fixed insufficient response without consuming the free allowance', async () => {
    const context = await fixture({
      deltas: ['我猜答案是……'],
      invokeNamedTools: [
        { name: 'knowledge_search', params: { query: '不在知识库的问题' } },
        { name: 'submit_knowledge_answer', params: { status: 'insufficient_evidence' } },
      ],
    });
    await context.start();
    await waitForReceipt(context.db);
    expect([...context.db.usageCharges.values()][0]).toMatchObject({
      status: 'released',
      execution_outcome: 'insufficient_evidence',
      settled_cents: 0n,
    });
    expect([...context.db.billingFreeAllowances.values()][0]).toMatchObject({
      free_used_count: 0,
      free_reserved_count: 0,
    });
    expect(context.db.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    await context.runner.dispose();
  });

  it.each([
    [
      'tampered answer',
      [
        { name: 'knowledge_search', params: { query: '免费额度' } },
        {
          name: 'submit_knowledge_answer',
          params: { status: 'answered', answer: '模型擅自改写的答案', citationChunkIds: [CHUNK] },
        },
      ],
      'rejected',
    ],
    [
      'missing submission',
      [{ name: 'knowledge_search', params: { query: '免费额度' } }],
      'protocol_invalid',
    ],
  ] as const)('fails closed for %s', async (_name, invokeNamedTools, expectedCode) => {
    const context = await fixture({
      deltas: ['不可信正文'],
      invokeNamedTools: [...invokeNamedTools],
    });
    await context.start();
    await waitForReceipt(context.db);
    expect([...context.db.usageCharges.values()][0]).toMatchObject({
      status: 'released',
      execution_outcome: 'failed',
      settled_cents: 0n,
    });
    expect([...context.db.agentUsageReceipts.values()][0]).toMatchObject({
      validation_code: expectedCode,
      response_message_id: null,
    });
    expect(context.db.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    expect(context.eventLog.entries(context.session.id).map((entry) => entry.event.type)).toEqual([
      'RUN_STARTED',
      'RUN_ERROR',
    ]);
    await context.runner.dispose();
  });

  it('keeps 402 before Turn, Message, Agent, or receipt creation', async () => {
    const context = await fixture({}, { freeUses: 0 });
    await expect(context.start()).resolves.toEqual({
      status: 'recharge_required',
      balanceCents: 0n,
      requiredCents: 1n,
    });
    expect(context.db.turns.size).toBe(0);
    expect(context.db.messages).toHaveLength(0);
    expect(context.db.usageCharges.size).toBe(0);
    expect(context.db.agentUsageReceipts.size).toBe(0);
    expect(context.agent.calls).toHaveLength(0);
    await context.runner.dispose();
  });

  it('interrupts a local knowledge Turn without persisting a candidate response', async () => {
    let sandboxInterrupts = 0;
    const context = await fixture(
      {
        deltas: ['不应被保存的候选正文'],
        hangUntilAbort: true,
      },
      {
        sandbox: failingSandbox(() => {
          sandboxInterrupts += 1;
        }),
      },
    );
    await context.start();
    await waitFor(() => context.agent.calls.length === 1);
    await expect(context.runner.interrupt(context.session.id)).resolves.toBe(true);
    await waitForReceipt(context.db);

    expect([...context.db.turns.values()][0]).toMatchObject({
      status: 'interrupted',
      last_error: { code: 'TURN_INTERRUPTED' },
    });
    expect([...context.db.usageCharges.values()][0]).toMatchObject({
      status: 'released',
      execution_outcome: 'interrupted',
    });
    expect([...context.db.agentUsageReceipts.values()][0]).toMatchObject({
      execution_outcome: 'interrupted',
      validation_code: 'not_run',
      response_message_id: null,
    });
    expect(context.db.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    expect(JSON.stringify(context.eventLog.entries(context.session.id))).not.toContain('候选正文');
    expect(sandboxInterrupts).toBe(0);
    await context.runner.dispose();
  });

  it('uses the knowledge terminal transaction during Runtime shutdown', async () => {
    let sandboxInterrupts = 0;
    const context = await fixture(
      { hangUntilAbort: true },
      {
        sandbox: failingSandbox(() => {
          sandboxInterrupts += 1;
        }),
      },
    );
    await context.start();
    await waitFor(() => context.agent.calls.length === 1);
    await context.runner.dispose();
    await waitForReceipt(context.db);

    expect([...context.db.turns.values()][0]).toMatchObject({
      status: 'interrupted',
      last_error: { code: 'TURN_SHUTDOWN' },
    });
    expect([...context.db.usageCharges.values()][0]).toMatchObject({
      status: 'released',
      execution_outcome: 'interrupted',
    });
    expect([...context.db.agentUsageReceipts.values()][0]).toMatchObject({
      validation_code: 'not_run',
      runtime_source_sha: SOURCE_SHA,
      response_message_id: null,
    });
    expect(context.db.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    expect(sandboxInterrupts).toBe(0);
  });

  it('lets a sandbox-disabled peer interrupt a knowledge Turn after its owner disappears', async () => {
    const context = await fixture({ hangUntilAbort: true });
    await context.start();
    await waitFor(() => context.agent.calls.length === 1);
    const peerAgent = makeFakeAgentFactory({});
    const peer = createTurnRunner({
      db: context.db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: context.eventLog,
      agentFactory: peerAgent.factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      billingPolicy: { freeUses: 3, unitPriceCents: 1 },
      runtimeSourceSha: SOURCE_SHA,
      log: silentLog,
    });

    await expect(peer.interrupt(context.session.id)).resolves.toBe(true);
    await waitForReceipt(context.db);
    expect([...context.db.turns.values()][0]).toMatchObject({
      status: 'interrupted',
      last_error: { code: 'TURN_INTERRUPTED' },
    });
    expect([...context.db.agentUsageReceipts.values()][0]).toMatchObject({
      execution_outcome: 'interrupted',
      validation_code: 'not_run',
      response_message_id: null,
    });
    expect(peerAgent.calls).toHaveLength(0);
    await context.runner.dispose();
    await peer.dispose();
  });

  it('sweeps an abandoned knowledge Turn to one failed zero-charge receipt', async () => {
    const context = await fixture({ hangUntilAbort: true }, { freeUses: 0, balance: 1n });
    await context.start();
    await waitFor(() => context.agent.calls.length === 1);
    const turn = [...context.db.turns.values()][0];
    if (!turn) throw new Error('missing knowledge Turn');
    turn.created_at = new Date(Date.now() - TURN_ABANDON_AFTER_MS - 1_000).toISOString();

    await expect(
      sweepExpiredKnowledgeTurns(context.db, new Date(), { runtimeSourceSha: SOURCE_SHA }),
    ).resolves.toEqual([expect.objectContaining({ id: turn.id, status: 'failed' })]);
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
  });

  it('sweeps knowledge even when foreign legacy sandbox cleanup is unconfirmed', async () => {
    const context = await fixture({ hangUntilAbort: true }, { freeUses: 0, balance: 1n });
    await context.start();
    await waitFor(() => context.agent.calls.length === 1);
    const knowledgeTurn = [...context.db.turns.values()][0];
    if (!knowledgeTurn) throw new Error('missing knowledge Turn');
    knowledgeTurn.created_at = new Date(Date.now() - TURN_ABANDON_AFTER_MS - 1_000).toISOString();

    const legacyCapability = '00000000-0000-4000-8000-000000000006';
    context.db.seedCapability({ id: legacyCapability, owner_user_id: CREATOR, published: true });
    const legacySession = await createSession(context.db, {
      capabilityId: legacyCapability,
      ownerUserId: CONSUMER,
    });
    const legacyTurnId = '00000000-0000-4000-8000-000000000009';
    const legacyRequest: UsageRequest = {
      ownerUserId: CONSUMER,
      capabilityOwnerUserId: CREATOR,
      capabilityId: legacyCapability,
      sessionId: legacySession.id,
      usageId: '00000000-0000-4000-8000-000000000010',
      text: 'legacy',
    };
    const billing = createUsageBillingService({ freeUses: 3, unitPriceCents: 1 });
    const preparation = await billing.prepareUsage(context.db, legacyRequest);
    if (preparation.kind !== 'new') throw new Error('expected legacy reservation');
    await createTurn(context.db, { id: legacyTurnId, sessionId: legacySession.id });
    await billing.reservePreparedUsage(context.db, {
      ...legacyRequest,
      turnId: legacyTurnId,
      preparation,
    });
    context.db.turns.get(legacyTurnId)!.created_at = new Date(
      Date.now() - TURN_ABANDON_AFTER_MS - 1_000,
    ).toISOString();

    const sweeper = createTurnRunner({
      db: context.db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: context.eventLog,
      agentFactory: makeFakeAgentFactory({}).factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      sweepIntervalMs: 60_000,
      runtimeSourceSha: SOURCE_SHA,
      log: silentLog,
    });
    await waitForReceipt(context.db);
    expect(context.db.turns.get(legacyTurnId)?.status).toBe('running');
    expect(context.db.turns.get(knowledgeTurn.id)?.status).toBe('failed');
    await context.runner.dispose();
    await sweeper.dispose();
  });

  it('projects only digest-verified responses and citations from the frozen Bundle', () => {
    const messageId = '00000000-0000-4000-8000-000000000011';
    const turnId = '00000000-0000-4000-8000-000000000012';
    const message: MessageRecord = {
      id: messageId,
      seq: 2,
      turnId,
      role: 'assistant',
      content: [{ type: 'text', text: ANSWER }],
      status: 'completed',
      createdAt: '2026-08-30T00:00:01.000Z',
    };
    const receipt: KnowledgeReceiptDbRow = {
      id: '00000000-0000-4000-8000-000000000013',
      usage_id: '00000000-0000-4000-8000-000000000014',
      turn_id: turnId,
      capability_id: CAPABILITY,
      capability_protocol: binding.capability.protocol,
      release_id: binding.release.releaseId,
      package_digest: binding.release.packageDigest,
      release_scope: binding.releaseScope,
      knowledge_resource_path: binding.knowledge.resourcePath,
      knowledge_resource_digest: binding.knowledge.resourceDigest,
      billing_policy_version: 'runtime-usage-v1',
      validator_policy_version: 'knowledge-agent-test-validator-v1',
      unit_price_cents: '1',
      free_limit_snapshot: 3,
      charge_source: 'free',
      settled_cents: '0',
      execution_outcome: 'answered',
      validation_code: 'accepted',
      response_message_id: messageId,
      response_digest: digestText(ANSWER),
      citation_chunk_ids: [CHUNK],
      execution_environment: 'test',
      runtime_release_id: `release-${SOURCE_SHA}`,
      runtime_source_sha: SOURCE_SHA,
      created_at: '2026-08-30T00:00:02.000Z',
    };
    expect(
      projectKnowledgeResults({
        binding,
        receipts: [receipt],
        messages: [message],
        knowledge: resolved.knowledge,
      }),
    ).toEqual([
      expect.objectContaining({
        outcome: 'answered',
        answer: { messageId, text: ANSWER, responseDigest: digestText(ANSWER) },
        citations: [expect.objectContaining({ chunkId: CHUNK, displayLabel: '公开计费手册' })],
      }),
    ]);
    expect(() =>
      projectKnowledgeResults({
        binding,
        receipts: [receipt],
        messages: [{ ...message, content: [{ type: 'text', text: '被篡改' }] }],
        knowledge: resolved.knowledge,
      }),
    ).toThrow('digest mismatch');
    expect(() =>
      projectKnowledgeResults({
        binding,
        receipts: [{ ...receipt, citation_chunk_ids: [`chunk.knowledge.${'f'.repeat(32)}`] }],
        messages: [message],
        knowledge: resolved.knowledge,
      }),
    ).toThrow('absent from the frozen Bundle');
  });
});
