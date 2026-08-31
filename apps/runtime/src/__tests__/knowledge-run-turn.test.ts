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

const CREATOR = '00000000-0000-4000-8000-000000000001';
const CONSUMER = '00000000-0000-4000-8000-000000000002';
const CAPABILITY = '00000000-0000-4000-8000-000000000003';
const SOURCE_SHA = '1'.repeat(40);
const CHUNK = `chunk.knowledge.${'2'.repeat(32)}`;
const SECOND_CHUNK = `chunk.knowledge.${'7'.repeat(32)}`;
const QUESTION = '免费额度是多少？';
const ANSWER = '前三次成功回答免费。';
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
const contents = ['Combo 的前三次成功回答使用免费额度。', 'Combo 余额不足时返回 402。'];
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

function gate(): KnowledgeAgentTestGate {
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
      text: QUESTION,
      usageId: '00000000-0000-4000-8000-000000000007',
      capabilityOwnerUserId: CREATOR,
      knowledge: { resolved, gate: gate(), runtimeSourceSha: SOURCE_SHA },
      log: silentLog,
    });
  return { db, session, agent, eventLog, runner, start };
}
describe('knowledge run-turn high-risk boundaries', () => {
  it('searches deterministically, fences citations, and leaves acceptance to the platform', async () => {
    expect(searchKnowledgeBundle(resolved.knowledge, 'Combo', 8).map((hit) => hit.chunkId)).toEqual(
      [CHUNK, SECOND_CHUNK],
    );
    const tools = createKnowledgeToolSession({
      knowledge: resolved.knowledge,
      turnSignal: new AbortController().signal,
    });
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
