import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

const mocks = vi.hoisted(() => ({
  activateAgentTest: vi.fn(),
  archiveSession: vi.fn(),
  createSession: vi.fn(),
  discardAgentTestReservation: vi.fn(),
  getOrCreateAgentTestSession: vi.fn(),
  listAgentProjectTests: vi.fn(),
  loadCurrentAgentRelease: vi.fn(),
  loadOwnedAgentRevision: vi.fn(),
  readAndFinalizeAgentTest: vi.fn(),
  reserveAgentTest: vi.fn(),
  seedAgentRevisionUiArtifact: vi.fn(),
  toSessionView: vi.fn(),
}));

vi.mock('../modules/agent/run-turn.js', () => ({
  TurnAdmissionUnavailableError: class TurnAdmissionUnavailableError extends Error {
    readonly stage: string;
    readonly reason: string;
    readonly databaseCode: string | undefined;

    constructor(stage: string, reason: string, databaseCode: string | undefined, cause: unknown) {
      super('turn admission is temporarily unavailable', { cause });
      this.name = 'TurnAdmissionUnavailableError';
      this.stage = stage;
      this.reason = reason;
      this.databaseCode = databaseCode;
    }
  },
}));

vi.mock('../modules/billing/service.js', () => ({
  UsageRequestConflictError: class UsageRequestConflictError extends Error {
    constructor() {
      super('usageId was already used for another request');
      this.name = 'UsageRequestConflictError';
    }
  },
}));

vi.mock('../modules/agent/revision-loader.js', () => ({
  loadCurrentAgentRelease: mocks.loadCurrentAgentRelease,
  loadOwnedAgentRevision: mocks.loadOwnedAgentRevision,
}));

vi.mock('../modules/session/repo.js', () => ({
  SessionBusyError: class SessionBusyError extends Error {},
  archiveSession: mocks.archiveSession,
  createSession: mocks.createSession,
  getOrCreateAgentTestSession: mocks.getOrCreateAgentTestSession,
  toSessionView: mocks.toSessionView,
}));

vi.mock('../modules/artifact/repo.js', () => ({
  seedAgentRevisionUiArtifact: mocks.seedAgentRevisionUiArtifact,
}));

vi.mock('../modules/agent-project/repo.js', () => ({
  activateAgentTest: mocks.activateAgentTest,
  discardAgentTestReservation: mocks.discardAgentTestReservation,
  listAgentProjectTests: mocks.listAgentProjectTests,
  readAndFinalizeAgentTest: mocks.readAndFinalizeAgentTest,
  reserveAgentTest: mocks.reserveAgentTest,
}));

import { TurnAdmissionUnavailableError } from '../modules/agent/run-turn.js';
import { UsageRequestConflictError } from '../modules/billing/service.js';
import { startAgentTestHandler } from '../modules/agent-project/handlers.js';

const USER_ID = 'user-me';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const REVISION_ID = '33333333-3333-4333-8333-333333333333';
const CAPABILITY_ID = '44444444-4444-4444-8444-444444444444';
const TEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TURN_ID = '55555555-5555-4555-8555-555555555555';
const SHA256 = 'a'.repeat(64);
const CREATED_AT = '2026-08-05T12:00:00.000Z';

const session = {
  id: TEST_ID,
  capabilityId: CAPABILITY_ID,
  agentProjectId: PROJECT_ID,
  agentRevisionId: REVISION_ID,
  mode: 'consume' as const,
  status: 'active' as const,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const runningTest = {
  id: TEST_ID,
  projectId: PROJECT_ID,
  agentRevisionId: REVISION_ID,
  runtimeBundleSha256: SHA256,
  uiSha256: SHA256,
  sessionId: TEST_ID,
  turnId: TURN_ID,
  status: 'running' as const,
  errorCode: null,
  createdAt: CREATED_AT,
  completedAt: null,
};

interface CapturedReply {
  statusCode: number;
  body: unknown;
}

function makeReply(): FastifyReply {
  const reply: CapturedReply & {
    code(statusCode: number): FastifyReply;
    send(body: unknown): FastifyReply;
  } = {
    statusCode: 0,
    body: undefined,
    code(statusCode: number) {
      this.statusCode = statusCode;
      return this as unknown as FastifyReply;
    },
    send(body: unknown) {
      this.body = body;
      return this as unknown as FastifyReply;
    },
  };
  return reply as unknown as FastifyReply;
}

function makeRequest(startTurn: ReturnType<typeof vi.fn>) {
  const error = vi.fn();
  const warn = vi.fn();
  const db = { query: vi.fn() };
  const request = {
    id: 'trace-agent-test',
    auth: { userId: USER_ID, account: 'creator-testerxx', roles: ['creator'] },
    params: { revisionId: REVISION_ID },
    body: { text: '运行 Agent Test', idempotencyKey: 'agent-test-request-1' },
    log: { error, warn },
    server: {
      infra: { db, objectStore: {} },
      turns: { startTurn },
    },
  } as unknown as FastifyRequest;
  return { request, db, error, warn };
}

async function call(handler: RouteHandlerMethod, request: FastifyRequest): Promise<CapturedReply> {
  const reply = makeReply();
  await (handler as unknown as (req: FastifyRequest, res: FastifyReply) => Promise<unknown>)(
    request,
    reply,
  );
  return reply as unknown as CapturedReply;
}

describe('POST /runtime/agent-revisions/:revisionId/tests admission contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadOwnedAgentRevision.mockResolvedValue({
      kind: 'ok',
      revision: {
        projectId: PROJECT_ID,
        revisionId: REVISION_ID,
        releaseId: null,
        entryCapabilityId: CAPABILITY_ID,
        capabilityOwnerUserId: USER_ID,
        runtimeBundleSha256: SHA256,
        uiArtifactId: '66666666-6666-4666-8666-666666666666',
        uiStorageKey: 'agent-ui/test.html',
        uiSha256: SHA256,
        bundle: { definition: { version: 1, name: 'Test Agent' } },
      },
    });
    mocks.reserveAgentTest.mockResolvedValue({
      kind: 'acquired',
      testId: TEST_ID,
      leaseToken: 'lease-token',
    });
    mocks.getOrCreateAgentTestSession.mockResolvedValue(session);
    mocks.toSessionView.mockReturnValue(session);
    mocks.seedAgentRevisionUiArtifact.mockResolvedValue(undefined);
    mocks.activateAgentTest.mockResolvedValue(runningTest);
    mocks.discardAgentTestReservation.mockResolvedValue(true);
  });

  it('成功启动时激活 Test，并保留 reservation 对应的 Session', async () => {
    const startTurn = vi.fn(
      async (input: { beforeCommit?: (db: unknown, id: string) => unknown }) => {
        await input.beforeCommit?.({}, TURN_ID);
        return {
          status: 'started' as const,
          userMessage: { id: 'message-1', seq: 0, role: 'user', content: [], status: 'completed' },
        };
      },
    );
    const { request } = makeRequest(startTurn);

    const reply = await call(startAgentTestHandler(), request);

    expect(reply.statusCode).toBe(202);
    expect(reply.body).toEqual({
      data: { test: runningTest, outputText: null },
      meta: { traceId: 'trace-agent-test' },
    });
    expect(mocks.activateAgentTest).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ testId: TEST_ID, sessionId: TEST_ID, turnId: TURN_ID }),
    );
    expect(mocks.discardAgentTestReservation).not.toHaveBeenCalled();
  });

  it('瞬态 admission 失败映射 503，并回收未激活 reservation/session', async () => {
    const startTurn = vi
      .fn()
      .mockRejectedValue(
        new TurnAdmissionUnavailableError(
          'session_lock',
          'database_transient',
          '55P03',
          new Error('database lock timeout'),
        ),
      );
    const { request, db, warn, error } = makeRequest(startTurn);

    const reply = await call(startAgentTestHandler(), request);

    expect(reply.statusCode).toBe(503);
    expect(reply.body).toEqual({
      error: {
        userMessage: '依赖服务暂时不可用，请稍后重试。',
        retriable: true,
        action: 'retry',
        traceId: 'trace-agent-test',
      },
    });
    expect(mocks.discardAgentTestReservation).toHaveBeenCalledWith(db, {
      testId: TEST_ID,
      leaseToken: 'lease-token',
      ownerUserId: USER_ID,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionStage: 'session_lock',
        admissionReason: 'database_transient',
        databaseCode: '55P03',
      }),
      'Agent Test turn admission temporarily unavailable',
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('usageId 幂等冲突映射 409，并回收未激活 reservation/session', async () => {
    const startTurn = vi.fn().mockRejectedValue(new UsageRequestConflictError());
    const { request, db, error } = makeRequest(startTurn);

    const reply = await call(startAgentTestHandler(), request);

    expect(reply.statusCode).toBe(409);
    expect((reply.body as { error: { action: string; retriable: boolean } }).error).toMatchObject({
      action: 'change_input',
      retriable: false,
    });
    expect(mocks.discardAgentTestReservation).toHaveBeenCalledWith(db, {
      testId: TEST_ID,
      leaseToken: 'lease-token',
      ownerUserId: USER_ID,
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('余额不足返回 402 而不是成功 Test，并回收 reservation/session', async () => {
    const startTurn = vi.fn().mockResolvedValue({
      status: 'recharge_required',
      balanceCents: 0n,
      requiredCents: 100n,
    });
    const { request, db } = makeRequest(startTurn);

    const reply = await call(startAgentTestHandler(), request);

    expect(reply.statusCode).toBe(402);
    expect(reply.body).toEqual({
      rechargeRequired: true,
      rechargeIntentId: TEST_ID,
      balanceCents: '0',
      requiredCents: '100',
    });
    expect(mocks.activateAgentTest).not.toHaveBeenCalled();
    expect(mocks.discardAgentTestReservation).toHaveBeenCalledWith(db, {
      testId: TEST_ID,
      leaseToken: 'lease-token',
      ownerUserId: USER_ID,
    });
  });

  it('不可能的 usage replay 不伪装成已启动 Test，并回收 reservation/session', async () => {
    const startTurn = vi.fn().mockResolvedValue({
      status: 'replayed',
      userMessage: { id: 'message-1', seq: 0, role: 'user', content: [], status: 'completed' },
    });
    const { request, db, error } = makeRequest(startTurn);

    const reply = await call(startAgentTestHandler(), request);

    expect(reply.statusCode).toBe(500);
    expect(mocks.activateAgentTest).not.toHaveBeenCalled();
    expect(mocks.discardAgentTestReservation).toHaveBeenCalledWith(db, {
      testId: TEST_ID,
      leaseToken: 'lease-token',
      ownerUserId: USER_ID,
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), traceId: 'trace-agent-test' }),
      'start Agent Revision test failed',
    );
  });
});
