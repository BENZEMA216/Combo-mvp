// 一轮生成的自治编排：数据库限制单 Session 单 running Turn，HTTP 提交后在进程内异步执行。
import { randomUUID } from 'node:crypto';
import { EventType } from '@ag-ui/core';
import { knowledgeBindingsEqual, type CapabilityDefinition, type SessionMode } from '@cb/shared';
import type { KnowledgeAgentTestGate } from '../../platform/config/env.js';
import { withTransaction, type RuntimeDb } from '../../platform/infra/db.js';
import type { RuntimeObjectStore } from '../../platform/infra/object-store.js';
import type { PublishedStreamEvent, SessionEventBus } from '../../platform/infra/event-bus.js';
import type { InterruptBus } from '../../platform/infra/redis-interrupt-bus.js';
import {
  createDisabledSandboxBackend,
  SandboxBackendError,
  type SandboxBackend,
} from '../../platform/infra/sandbox-backend.js';
import type { SessionEventLog } from './event-log.js';
import {
  appendTurnMessage,
  getMessages,
  lockActiveSession,
  SessionBusyError,
  type MessageRecord,
  type SessionRow,
} from '../session/repo.js';
import { createArtifactTool, type ArtifactAgentTool } from '../artifact/tool.js';
import { bindCapabilityUiArtifact, readLatestHtmlArtifactInSession } from '../artifact/repo.js';
import {
  createUsageBillingService,
  DEFAULT_USAGE_BILLING_POLICY,
  usageRequestFingerprint,
  type UsageBillingPolicy,
  type UsageRequest,
} from '../billing/service.js';
import { findUsageCharge, readUsageChargeProductKindByTurn } from '../billing/repo.js';
import { createSandboxTools, type SandboxAgentTool } from './sandbox-tools.js';
import {
  createKnowledgeToolSession,
  validateKnowledgeCandidate,
  type KnowledgeAgentTool,
  type ResolvedKnowledgeAgent,
} from '../knowledge-agent/resolver.js';
import { finishKnowledgeTurn, sweepExpiredKnowledgeTurns } from '../knowledge-agent/repo.js';
import { createTurnEmitter, type TurnEmitter, type TurnLogger } from './turn-emitter.js';
import {
  createTurn,
  finishTurnCas,
  finishTurnWithMessage,
  getLatestTerminalTurn,
  getRunningTurnId,
  getTerminalTurn,
  lockRunningTurn,
  lockTurnSession,
  sweepExpiredTurns,
  TURN_ABANDON_AFTER_MS,
  type TerminalTurn,
  type TerminalTurnStatus,
  type TurnLastError,
} from './turn-repo.js';

export type RuntimeAgentTool = ArtifactAgentTool | SandboxAgentTool | KnowledgeAgentTool;

export interface TurnAgentInput {
  definition: CapabilityDefinition;
  mode: SessionMode;
  history: MessageRecord[];
  tools: RuntimeAgentTool[];
  promptText: string;
  hasExistingStudioArtifact: boolean;
  knowledge?: Pick<ResolvedKnowledgeAgent, 'name' | 'description' | 'instructions'>;
}
export interface TurnAgent {
  subscribeTextDelta(fn: (delta: string) => void): () => void;
  subscribeActivity?(fn: () => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): void;
  transcript(): unknown[];
  runtimeError(): string | undefined;
}
export type TurnAgentFactory = (input: TurnAgentInput) => TurnAgent;
export class TurnAgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnAgentUnavailableError';
  }
}

export class SessionInactiveError extends Error {
  constructor() {
    super('session is no longer active');
    this.name = 'SessionInactiveError';
  }
}

export const START_TURN_DATABASE_TIMEOUT_MS = 8_000;
export const START_TURN_DEADLINE_MS = 10_000;
const TURN_OWNERSHIP_CONFIRMATION_DATABASE_TIMEOUT_MS = 1_500;
const TURN_OWNERSHIP_CONFIRMATION_DEADLINE_MS = 2_000;
const TURN_OWNERSHIP_RETRY_MAX_DELAY_MS = 5_000;

export type TurnAdmissionStage =
  | 'transaction_setup'
  | 'session_lock'
  | 'usage_prepare'
  | 'usage_replay_lookup'
  | 'running_check'
  | 'terminal_repair'
  | 'turn_insert'
  | 'usage_reservation'
  | 'message_insert'
  | 'commit'
  | 'commit_recovery';

export type TurnAdmissionDatabaseCode = '40001' | '40P01' | '55P03' | '57014';
export type TurnAdmissionFailureReason = 'database_transient' | 'deadline' | 'commit_unknown';

export class TurnAdmissionUnavailableError extends Error {
  readonly stage: TurnAdmissionStage;
  readonly reason: TurnAdmissionFailureReason;
  readonly databaseCode: TurnAdmissionDatabaseCode | undefined;

  constructor(
    stage: TurnAdmissionStage,
    reason: TurnAdmissionFailureReason,
    databaseCode: TurnAdmissionDatabaseCode | undefined,
    cause: unknown,
  ) {
    super('turn admission is temporarily unavailable', { cause });
    this.name = 'TurnAdmissionUnavailableError';
    this.stage = stage;
    this.reason = reason;
    this.databaseCode = databaseCode;
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function admissionDatabaseCode(error: unknown): TurnAdmissionDatabaseCode | null {
  const code = errorCode(error);
  return code === '40001' || code === '40P01' || code === '55P03' || code === '57014' ? code : null;
}

export interface TurnRunnerDeps {
  db: RuntimeDb;
  objectStore: RuntimeObjectStore;
  bus: SessionEventBus;
  eventLog: SessionEventLog;
  agentFactory: TurnAgentFactory;
  idleTimeoutMs: number;
  interrupts: InterruptBus;
  sandbox?: SandboxBackend;
  sweepIntervalMs?: number;
  shutdownTimeoutMs?: number;
  terminalEventTimeoutMs?: number;
  sandboxCleanupTimeoutMs?: number;
  turnAdmissionDatabaseTimeoutMs?: number;
  turnAdmissionDeadlineMs?: number;
  billingPolicy?: UsageBillingPolicy;
  /** Exact Runtime release identity used by ownerless recovery paths. */
  runtimeSourceSha?: string;
  log: TurnLogger;
}
export type StartTurnResult =
  | { status: 'started' | 'replayed'; userMessage: MessageRecord }
  | { status: 'recharge_required'; balanceCents: bigint; requiredCents: bigint };
export interface TurnRunner {
  startTurn(input: {
    session: SessionRow;
    definition: CapabilityDefinition;
    text: string;
    usageId: string;
    capabilityOwnerUserId: string;
    knowledge?: {
      resolved: ResolvedKnowledgeAgent;
      gate: KnowledgeAgentTestGate;
      runtimeSourceSha: string;
    };
    log: TurnLogger;
  }): Promise<StartTurnResult>;
  interrupt(sessionId: string): Promise<boolean>;
  dispose(signal?: AbortSignal): Promise<void>;
}

function agentMessageToRow(m: unknown): { role: 'assistant' | 'tool'; content: unknown[] } | null {
  if (typeof m !== 'object' || m === null) return null;
  const msg = m as {
    role?: unknown;
    content?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
  };
  if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.length > 0)
    return { role: 'assistant', content: msg.content };
  if (msg.role === 'toolResult')
    return {
      role: 'tool',
      content: [
        {
          type: 'toolResult',
          toolCallId: String(msg.toolCallId ?? ''),
          toolName: String(msg.toolName ?? ''),
          content: Array.isArray(msg.content) ? msg.content : [],
          isError: Boolean(msg.isError),
        },
      ],
    };
  return null;
}

class TerminalEventAppendTimeoutError extends Error {
  constructor() {
    super('terminal Redis event append outcome is unknown');
    this.name = 'TerminalEventAppendTimeoutError';
  }
}

const REMOTE_INTERRUPT_REPUBLISH_MS = 250;
const REMOTE_INTERRUPT_POLL_MS = 50;

function terminalTurn(
  id: string,
  sessionId: string,
  status: TerminalTurnStatus,
  lastError: TurnLastError | null,
): TerminalTurn {
  return { id, sessionId, status, lastError };
}

const PUBLIC_TERMINAL_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  TURN_ABANDONED: '服务异常中断,本轮已终止,请重试。',
  TURN_HISTORY_LOAD_FAILED: '服务开小差了，请重试。',
  TURN_AGENT_UNAVAILABLE: '对话服务暂时不可用，请重试。',
  TURN_IDLE_TIMEOUT: '模型响应停滞，本轮已终止，请重试。',
  TURN_PROMPT_FAILED: '对话生成失败，请重试。',
  TURN_RUNTIME_ERROR: '模型调用失败（额度/网络/服务波动），请重试。',
  TURN_PERSIST_FAILED: '本轮回复未能保存（数据库异常），请重试。',
  TURN_INTERRUPTED: '本轮生成已打断。',
  TURN_SHUTDOWN: 'Runtime 正在关闭，本轮已终止，请重试。',
};

function terminalEventForTurn(turn: TerminalTurn): Record<string, unknown> {
  const base = { threadId: turn.sessionId, runId: turn.id };
  if (turn.status === 'completed') return { type: EventType.RUN_FINISHED, ...base };
  const fallback =
    turn.status === 'interrupted' ? '本轮生成已打断。' : '服务异常中断,本轮已终止,请重试。';
  // last_error can contain diagnostic text written by older deployments. Only a
  // fixed code-to-public-message allow-list is allowed to cross the SSE boundary.
  const message = turn.lastError
    ? (PUBLIC_TERMINAL_ERROR_MESSAGES[turn.lastError.code] ?? fallback)
    : fallback;
  return { type: EventType.RUN_ERROR, ...base, message };
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function waitUntilSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => resolve(undefined));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  const sandbox = deps.sandbox ?? createDisabledSandboxBackend();
  const billing = createUsageBillingService(deps.billingPolicy ?? DEFAULT_USAGE_BILLING_POLICY);
  interface ActiveTurn {
    controller: AbortController;
    runId: string;
    completion: Promise<void>;
    knowledgeRuntimeSourceSha?: string;
  }
  interface StartingTurn {
    sessionId: string;
    running: ActiveTurn;
    transactionController: AbortController;
    settled: Promise<void>;
  }
  const active = new Map<string, ActiveTurn>();
  const starting = new Set<StartingTurn>();
  const sandboxStops = new Map<string, Promise<void>>();
  const shutdownOwnedRuns = new Set<string>();
  const shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 15_000;
  const terminalEventTimeoutMs = deps.terminalEventTimeoutMs ?? 3_000;
  const sandboxCleanupTimeoutMs = deps.sandboxCleanupTimeoutMs ?? 10_000;
  const turnAdmissionDatabaseTimeoutMs =
    deps.turnAdmissionDatabaseTimeoutMs ?? START_TURN_DATABASE_TIMEOUT_MS;
  const turnAdmissionDeadlineMs = deps.turnAdmissionDeadlineMs ?? START_TURN_DEADLINE_MS;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    throw new Error('turn shutdown timeout must be positive');
  }
  if (!Number.isSafeInteger(terminalEventTimeoutMs) || terminalEventTimeoutMs <= 0) {
    throw new Error('terminal event timeout must be positive');
  }
  if (!Number.isSafeInteger(sandboxCleanupTimeoutMs) || sandboxCleanupTimeoutMs <= 0) {
    throw new Error('sandbox cleanup timeout must be positive');
  }
  if (
    !Number.isSafeInteger(turnAdmissionDatabaseTimeoutMs) ||
    turnAdmissionDatabaseTimeoutMs <= 0
  ) {
    throw new Error('turn admission database timeout must be positive');
  }
  if (
    !Number.isSafeInteger(turnAdmissionDeadlineMs) ||
    turnAdmissionDeadlineMs <= turnAdmissionDatabaseTimeoutMs
  ) {
    throw new Error('turn admission deadline must exceed its database timeout');
  }
  const promptAbortGraceMs = Math.max(1, Math.min(1_000, Math.floor(shutdownTimeoutMs / 2)));
  let disposing = false;
  const disposalController = new AbortController();
  let disposePromise: Promise<void> | undefined;
  const appendTerminalEvent = async (
    sessionId: string,
    runId: string,
    event: Record<string, unknown>,
    signal?: AbortSignal,
    mode: 'strict' | 'repair' = 'strict',
  ): Promise<PublishedStreamEvent> => {
    if (signal?.aborted) throw new TerminalEventAppendTimeoutError();
    const timeout = terminalEventTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const append =
      mode === 'repair'
        ? deps.eventLog.repairTerminal(sessionId, runId, event)
        : deps.eventLog.appendTerminal(sessionId, runId, event);
    try {
      const id = await Promise.race([
        append,
        new Promise<never>((_resolve, reject) => {
          const fail = (): void => reject(new TerminalEventAppendTimeoutError());
          timer = setTimeout(fail, timeout);
          timer.unref?.();
          if (signal) {
            onAbort = fail;
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }),
      ]);
      return { id, event };
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };
  const appendCommittedTerminal = async (
    turn: TerminalTurn,
    signal?: AbortSignal,
  ): Promise<PublishedStreamEvent> => {
    const terminal = await appendTerminalEvent(
      turn.sessionId,
      turn.id,
      terminalEventForTurn(turn),
      signal,
    );
    if (!signal?.aborted) deps.bus.publish(turn.sessionId, terminal);
    return terminal;
  };
  const waitForOwnerInterrupt = async (sessionId: string, runId: string): Promise<boolean> => {
    const deadline = Date.now() + sandboxCleanupTimeoutMs;
    let nextPublishAt = 0;
    for (;;) {
      const now = Date.now();
      if (now >= nextPublishAt) {
        deps.interrupts.publish({ sessionId, runId });
        nextPublishAt = now + REMOTE_INTERRUPT_REPUBLISH_MS;
      }
      const terminal = await getTerminalTurn(deps.db, runId, sessionId);
      if (terminal) {
        if (terminal.status !== 'interrupted') return false;
        // The owner commits PostgreSQL only after its local cleanup proof. Make
        // the corresponding Redis terminal visible before acknowledging the
        // cross-replica HTTP request; appendTerminal is idempotent for this event.
        await appendCommittedTerminal(terminal);
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SandboxBackendError(
          'cleanup_unconfirmed',
          'the owning Runtime replica did not confirm interrupt cleanup',
        );
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(REMOTE_INTERRUPT_POLL_MS, remaining));
      });
    }
  };
  const stopSandboxCommands = (
    sessionId: string,
    reason: string,
    options: { localExecution?: boolean } = {},
  ): Promise<void> => {
    // A feature-off replica knows that its own local Turn never received remote
    // tools, but it cannot certify cleanup for a Turn owned by an enabled replica.
    if (!sandbox.enabled) {
      return options.localExecution
        ? Promise.resolve()
        : Promise.reject(
            new SandboxBackendError(
              'cleanup_unconfirmed',
              'this Runtime replica cannot verify foreign sandbox cleanup',
            ),
          );
    }
    const existing = sandboxStops.get(sessionId);
    if (existing) return existing;
    let timer: NodeJS.Timeout | undefined;
    const pending = Promise.race([
      sandbox.interruptSession(sessionId),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('sandbox cleanup timed out')),
          sandboxCleanupTimeoutMs,
        );
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    sandboxStops.set(sessionId, pending);
    void pending
      .catch((err) => {
        deps.log.error({ err, sessionId, reason }, 'sandbox interrupt failed');
      })
      .finally(() => {
        if (sandboxStops.get(sessionId) === pending) sandboxStops.delete(sessionId);
      });
    return pending;
  };
  const runtimeSourceShaForKnowledge = (candidate?: string): string => {
    const sourceSha = candidate ?? deps.runtimeSourceSha;
    if (!sourceSha || !/^[0-9a-f]{40}$/u.test(sourceSha)) {
      throw new Error('knowledge terminal Runtime identity is unavailable');
    }
    return sourceSha;
  };
  const readTurnProductKind = async (
    runId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<'legacy_capability' | 'knowledge_agent_test' | null> => {
    const reserved = await readUsageChargeProductKindByTurn(deps.db, runId, signal);
    if (reserved) return reserved;
    return (
      (
        await deps.db.query<{
          product_kind: 'legacy_capability' | 'knowledge_agent_test';
        }>('SELECT product_kind FROM sessions WHERE id = $1', [sessionId], signal)
      ).rows[0]?.product_kind ?? null
    );
  };
  const finishInterruptedRun = async (input: {
    sessionId: string;
    runId: string;
    lastError: TurnLastError;
    knowledgeRuntimeSourceSha?: string;
    beforeFinish?: () => Promise<void>;
    transaction?: NonNullable<Parameters<typeof finishTurnWithMessage>[2]>['transaction'];
  }): Promise<boolean> => {
    const productKind = await readTurnProductKind(
      input.runId,
      input.sessionId,
      input.transaction?.signal,
    );
    if (productKind === 'knowledge_agent_test') {
      const terminal = await finishKnowledgeTurn(
        deps.db,
        {
          sessionId: input.sessionId,
          turnId: input.runId,
          outcome: 'interrupted',
          validationCode: 'not_run',
          answer: null,
          citationChunkIds: [],
          runtimeSourceSha: runtimeSourceShaForKnowledge(input.knowledgeRuntimeSourceSha),
          lastError: input.lastError,
        },
        {
          beforeFinish: input.beforeFinish
            ? async () => {
                await input.beforeFinish?.();
              }
            : undefined,
          transaction: input.transaction,
        },
      );
      return terminal.won;
    }
    if (productKind !== 'legacy_capability') {
      throw new Error('running Turn has no usage reservation');
    }
    return finishTurnWithMessage(
      deps.db,
      {
        id: input.runId,
        sessionId: input.sessionId,
        idx: 1,
        status: 'interrupted',
        content: [{ type: 'text', text: input.lastError.message }],
        lastError: input.lastError,
      },
      {
        beforeFinish: input.beforeFinish,
        afterFinish: (transaction) => billing.releaseUsage(transaction, input.runId),
        transaction: input.transaction,
      },
    );
  };
  const unsubscribeInterrupts = deps.interrupts.subscribe(({ sessionId, runId }) => {
    const running = active.get(sessionId);
    if (running?.runId !== runId) return;
    running.controller.abort();
    if (!running.knowledgeRuntimeSourceSha) {
      void stopSandboxCommands(sessionId, 'interrupt-broadcast', {
        localExecution: true,
      }).catch(() => undefined);
    }
  });
  let sweepInFlight: Promise<void> | undefined;
  const runSweep = (): Promise<void> => {
    if (sweepInFlight) return sweepInFlight;
    const run = (async () => {
      const cutoff = new Date(Date.now() - TURN_ABANDON_AFTER_MS);
      const swept: TerminalTurn[] = [];
      try {
        const beforeLegacyFinish = async (turn: {
          id: string;
          sessionId: string;
        }): Promise<void> => {
          deps.interrupts.publish({ sessionId: turn.sessionId, runId: turn.id });
          // The Session row remains locked until sandboxd confirms its
          // descendant sweep or the exact Pod UID is observed gone.
          await stopSandboxCommands(turn.sessionId, 'turn-sweep', {
            localExecution: active.get(turn.sessionId)?.runId === turn.id,
          });
        };
        const legacySwept = await sweepExpiredTurns(deps.db, cutoff, {
          beforeFinish: beforeLegacyFinish,
          afterFinish: (transaction, turn) => billing.releaseUsage(transaction, turn.id),
        });
        swept.push(...legacySwept);
      } catch (err) {
        deps.log.error({ err }, 'legacy Turn sweep failed');
      }
      try {
        const knowledgeSwept = await sweepExpiredKnowledgeTurns(deps.db, cutoff, {
          runtimeSourceSha: deps.runtimeSourceSha ?? '',
          beforeFinish: async (turn) => {
            // Knowledge tools are read-only, in-memory views of the already verified Bundle. They
            // never enter sandboxd, so a dead owner does not need a sandbox cleanup proof.
            deps.interrupts.publish({ sessionId: turn.sessionId, runId: turn.id });
          },
        });
        swept.push(...knowledgeSwept);
      } catch (err) {
        deps.log.error({ err }, 'knowledge Turn sweep failed');
      }
      // PostgreSQL is the terminal truth. Redis is appended only after each
      // terminal transaction commits; startTurn repairs a missing event
      // under the same Session lock before a successor can be created.
      for (const turn of swept) {
        await appendCommittedTerminal(turn).catch((err) => {
          deps.log.error({ err, runId: turn.id }, 'swept terminal event append failed');
        });
      }
      try {
        await billing.reconcileTerminalReservations(deps.db);
      } catch (err) {
        deps.log.error({ err }, 'billing reservation reconciliation failed');
      }
    })().finally(() => {
      if (sweepInFlight === run) sweepInFlight = undefined;
    });
    sweepInFlight = run;
    return run;
  };
  const sweepTimer =
    deps.sweepIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          void runSweep();
        }, deps.sweepIntervalMs);
  sweepTimer?.unref?.();
  if (deps.sweepIntervalMs !== undefined) void runSweep();

  const waitForExecutableTurn = async (
    sessionId: string,
    runId: string,
    running: ActiveTurn,
  ): Promise<boolean> => {
    let retryDelayMs = 250;
    for (;;) {
      if (disposing || shutdownOwnedRuns.has(runId) || active.get(sessionId) !== running) {
        return false;
      }
      const confirmationSignal = AbortSignal.any([
        disposalController.signal,
        AbortSignal.timeout(TURN_OWNERSHIP_CONFIRMATION_DEADLINE_MS),
      ]);
      const currentRunId = await withTransaction(
        deps.db,
        (transaction) => getRunningTurnId(transaction, sessionId),
        {
          signal: confirmationSignal,
          timeoutMs: TURN_OWNERSHIP_CONFIRMATION_DATABASE_TIMEOUT_MS,
        },
      ).catch(() => undefined);
      if (currentRunId !== undefined) return currentRunId === runId;
      await waitForDelay(retryDelayMs, disposalController.signal);
      retryDelayMs = Math.min(retryDelayMs * 2, TURN_OWNERSHIP_RETRY_MAX_DELAY_MS);
    }
  };

  async function executeKnowledgeTurn(args: {
    sessionId: string;
    definition: CapabilityDefinition;
    text: string;
    controller: AbortController;
    runId: string;
    knowledge: NonNullable<Parameters<TurnRunner['startTurn']>[0]['knowledge']>;
    log: TurnLogger;
  }): Promise<void> {
    const { sessionId, controller, log, runId } = args;
    const localHandle = active.get(sessionId);
    if (
      localHandle?.runId !== runId ||
      !(await waitForExecutableTurn(sessionId, runId, localHandle))
    ) {
      return;
    }
    const emitter = createTurnEmitter({
      eventLog: deps.eventLog,
      bus: deps.bus,
      sessionId,
      log,
      append: async (event) => {
        if (controller.signal.aborted || shutdownOwnedRuns.has(runId)) return null;
        return withTransaction(
          deps.db,
          async (transaction) => {
            await lockTurnSession(transaction, sessionId);
            if (controller.signal.aborted || shutdownOwnedRuns.has(runId)) return null;
            if (!(await lockRunningTurn(transaction, runId, sessionId))) return null;
            return deps.eventLog.append(sessionId, event);
          },
          { signal: controller.signal },
        );
      },
    });
    const base = { threadId: sessionId, runId };
    const finish = async (input: {
      outcome: 'answered' | 'insufficient_evidence' | 'failed' | 'interrupted';
      validationCode:
        | 'accepted'
        | 'insufficient_evidence'
        | 'not_run'
        | 'rejected'
        | 'unavailable'
        | 'protocol_invalid';
      answer: string | null;
      citationChunkIds: readonly string[];
      lastError?: TurnLastError;
    }): Promise<void> => {
      if (shutdownOwnedRuns.has(runId)) return;
      try {
        await emitter.flush();
        if (shutdownOwnedRuns.has(runId)) return;
        const terminal = await finishKnowledgeTurn(deps.db, {
          sessionId,
          turnId: runId,
          binding: args.knowledge.resolved.binding,
          outcome: input.outcome,
          validationCode: input.validationCode,
          answer: input.answer,
          citationChunkIds: input.citationChunkIds,
          runtimeSourceSha: args.knowledge.runtimeSourceSha,
          lastError: input.lastError ?? null,
        });
        if (!terminal.won || !terminal.turnStatus) {
          log.error({ runId }, 'knowledge terminal state already claimed');
          return;
        }
        await appendCommittedTerminal(
          terminalTurn(runId, sessionId, terminal.turnStatus, input.lastError ?? null),
        ).catch((err) => {
          log.error({ err, runId }, 'knowledge terminal event append failed');
        });
      } catch (err) {
        log.error({ err, runId }, 'knowledge terminal transaction failed');
      }
    };

    if (controller.signal.aborted) {
      await finish({
        outcome: 'interrupted',
        validationCode: 'not_run',
        answer: null,
        citationChunkIds: [],
        lastError: { code: 'TURN_INTERRUPTED', message: '本轮生成已打断。' },
      });
      return;
    }

    emitter.emit({ type: EventType.RUN_STARTED, ...base });
    const toolSession = createKnowledgeToolSession({
      knowledge: args.knowledge.resolved.knowledge,
      turnSignal: controller.signal,
    });
    let agent: TurnAgent;
    try {
      agent = deps.agentFactory({
        definition: args.definition,
        mode: 'consume',
        history: [],
        tools: toolSession.tools,
        promptText: args.text,
        hasExistingStudioArtifact: false,
        knowledge: args.knowledge.resolved,
      });
    } catch (err) {
      log.error({ err }, 'knowledge agent factory failed');
      await finish({
        outcome: 'failed',
        validationCode: 'unavailable',
        answer: null,
        citationChunkIds: [],
        lastError: { code: 'TURN_AGENT_UNAVAILABLE', message: '对话服务暂时不可用，请重试。' },
      });
      return;
    }

    type PromptOutcome =
      | { status: 'completed' }
      | { status: 'failed'; error: unknown }
      | { status: 'aborted' };
    let resolveAbort!: (outcome: PromptOutcome) => void;
    const abortOutcome = new Promise<PromptOutcome>((resolve) => {
      resolveAbort = resolve;
    });
    const onAbort = (): void => {
      try {
        agent.abort();
      } catch (err) {
        log.error({ err }, 'knowledge agent abort failed');
      }
      resolveAbort({ status: 'aborted' });
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    let idleTimedOut = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdleWatchdog = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        log.error({ idleTimeoutMs: deps.idleTimeoutMs }, 'knowledge idle watchdog fired');
        controller.abort();
      }, deps.idleTimeoutMs);
      idleTimer.unref?.();
    };
    // Model text is candidate material. It only keeps the watchdog alive and never reaches
    // Redis, PostgreSQL, transcript persistence, or the owner-visible Session detail.
    const unsubscribeText = agent.subscribeTextDelta(() => armIdleWatchdog());
    const unsubscribeActivity = agent.subscribeActivity?.(armIdleWatchdog);
    armIdleWatchdog();
    let promptSettled = false;
    const prompt = Promise.resolve()
      .then(() => agent.prompt(args.text))
      .then<PromptOutcome, PromptOutcome>(
        () => ({ status: 'completed' }),
        (error: unknown) => ({ status: 'failed', error }),
      )
      .finally(() => {
        promptSettled = true;
      });
    let promptOutcome: PromptOutcome;
    try {
      promptOutcome = await Promise.race([prompt, abortOutcome]);
    } finally {
      clearTimeout(idleTimer);
      unsubscribeText();
      unsubscribeActivity?.();
      controller.signal.removeEventListener('abort', onAbort);
    }

    if (controller.signal.aborted || promptOutcome.status === 'aborted') {
      let graceTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        prompt,
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, promptAbortGraceMs);
          graceTimer.unref?.();
        }),
      ]);
      clearTimeout(graceTimer);
      // Knowledge tools only mutate turn-local memory and are fenced by turnSignal. A late SDK
      // completion cannot reach DB/SSE, so terminalization does not depend on sandbox cleanup.
      void promptSettled;
      if (idleTimedOut) {
        await finish({
          outcome: 'failed',
          validationCode: 'unavailable',
          answer: null,
          citationChunkIds: [],
          lastError: { code: 'TURN_IDLE_TIMEOUT', message: '模型响应停滞，本轮已终止，请重试。' },
        });
      } else {
        await finish({
          outcome: 'interrupted',
          validationCode: 'not_run',
          answer: null,
          citationChunkIds: [],
          lastError: { code: 'TURN_INTERRUPTED', message: '本轮生成已打断。' },
        });
      }
      return;
    }
    if (promptOutcome.status === 'failed' || agent.runtimeError() !== undefined) {
      if (promptOutcome.status === 'failed') {
        log.error({ err: promptOutcome.error }, 'knowledge prompt failed');
      }
      await finish({
        outcome: 'failed',
        validationCode: 'unavailable',
        answer: null,
        citationChunkIds: [],
        lastError: { code: 'TURN_PROMPT_FAILED', message: '对话生成失败，请重试。' },
      });
      return;
    }

    const validation = validateKnowledgeCandidate({
      gate: args.knowledge.gate,
      question: args.text,
      candidate: toolSession.candidate(),
      exposedHits: toolSession.exposedHits(),
    });
    await finish({
      outcome: validation.outcome,
      validationCode: validation.validationCode,
      answer: validation.answer,
      citationChunkIds: validation.citationChunkIds,
      ...(validation.outcome === 'failed'
        ? {
            lastError: {
              code:
                validation.validationCode === 'rejected'
                  ? 'TURN_KNOWLEDGE_REJECTED'
                  : 'TURN_KNOWLEDGE_PROTOCOL_INVALID',
              message: '知识答案未通过平台验证。',
            },
          }
        : {}),
    });
  }

  async function executeTurn(args: {
    sessionId: string;
    capabilityId: string;
    definition: CapabilityDefinition;
    mode: SessionMode;
    text: string;
    controller: AbortController;
    runId: string;
    ownerUserId: string;
    log: TurnLogger;
  }): Promise<void> {
    const { sessionId, controller, log, runId } = args;
    const localHandle = active.get(sessionId);
    if (
      localHandle?.runId !== runId ||
      !(await waitForExecutableTurn(sessionId, runId, localHandle))
    ) {
      return;
    }
    const emitter: TurnEmitter = createTurnEmitter({
      eventLog: deps.eventLog,
      bus: deps.bus,
      sessionId,
      log,
      append: async (event) => {
        if (controller.signal.aborted || shutdownOwnedRuns.has(runId)) return null;
        return withTransaction(
          deps.db,
          async (transaction) => {
            // Every nonterminal event uses the same Session-before-Turn lock order as
            // terminalization. Once any replica commits a terminal CAS, later Pi
            // output cannot obtain this running guard and therefore cannot reach SSE.
            await lockTurnSession(transaction, sessionId);
            if (controller.signal.aborted || shutdownOwnedRuns.has(runId)) return null;
            if (!(await lockRunningTurn(transaction, runId, sessionId))) return null;
            return deps.eventLog.append(sessionId, event);
          },
          { signal: controller.signal },
        );
      },
    });
    const messageId = randomUUID();
    const base = { threadId: sessionId, runId };
    let nextIdx = 1;
    let assistantText = '';
    let lastStudioArtifactId: string | null = null;
    let textOpen = false;
    const openText = (): void => {
      if (!textOpen) {
        textOpen = true;
        emitter.emit({ type: EventType.TEXT_MESSAGE_START, ...base, messageId, role: 'assistant' });
      }
    };
    const closeText = (): void => {
      if (textOpen) {
        textOpen = false;
        emitter.emit({ type: EventType.TEXT_MESSAGE_END, ...base, messageId });
      }
    };

    const finishFailed = async (
      code: string,
      userMessage: string,
      failedContent?: unknown[],
    ): Promise<void> => {
      if (shutdownOwnedRuns.has(runId)) return;
      closeText();
      if (shutdownOwnedRuns.has(runId)) return;
      const lastError = { code, message: userMessage };
      let ok: boolean;
      try {
        await emitter.flush();
        if (shutdownOwnedRuns.has(runId)) return;
        ok = await finishTurnWithMessage(
          deps.db,
          {
            id: runId,
            sessionId,
            idx: nextIdx++,
            status: 'failed',
            content: failedContent ?? [{ type: 'text', text: userMessage }],
            lastError,
          },
          { afterFinish: (transaction) => billing.releaseUsage(transaction, runId) },
        );
      } catch (err) {
        log.error({ err }, 'persist failed terminal state failed');
        return;
      }
      if (!ok) {
        log.error({ runId }, 'turn terminal state already claimed');
        return;
      }
      await appendCommittedTerminal(terminalTurn(runId, sessionId, 'failed', lastError)).catch(
        (err) => {
          log.error({ err, runId }, 'failed terminal event append failed');
        },
      );
    };
    const finishInterrupted = async (): Promise<void> => {
      if (shutdownOwnedRuns.has(runId)) return;
      closeText();
      if (shutdownOwnedRuns.has(runId)) return;
      const message = '本轮生成已打断。';
      const lastError = { code: 'TURN_INTERRUPTED', message };
      let ok: boolean;
      try {
        await emitter.flush();
        if (shutdownOwnedRuns.has(runId)) return;
        ok = await finishTurnWithMessage(
          deps.db,
          {
            id: runId,
            sessionId,
            idx: nextIdx++,
            status: 'interrupted',
            content: assistantText
              ? [{ type: 'text', text: assistantText }]
              : [{ type: 'text', text: message }],
            lastError,
          },
          { afterFinish: (transaction) => billing.releaseUsage(transaction, runId) },
        );
      } catch (err) {
        log.error({ err }, 'persist interrupted terminal state failed');
        return;
      }
      if (!ok) {
        log.error({ runId }, 'turn terminal state already claimed');
        return;
      }
      await appendCommittedTerminal(terminalTurn(runId, sessionId, 'interrupted', lastError)).catch(
        (err) => {
          log.error({ err, runId }, 'interrupted terminal event append failed');
        },
      );
    };

    // An interrupt can win immediately after startTurn commits but before this
    // async executor reaches Pi. The local handle is published before COMMIT, so
    // keep that already-aborted execution responsible for releasing the running
    // guard instead of returning and orphaning the Turn.
    if (controller.signal.aborted) {
      const cleanupSafe = await stopSandboxCommands(sessionId, 'pre-execution-abort', {
        localExecution: true,
      }).then(
        () => true,
        (err: unknown) => {
          log.error({ err }, 'sandbox cleanup before execution failed');
          return false;
        },
      );
      if (cleanupSafe) await finishInterrupted();
      return;
    }

    emitter.emit({ type: EventType.RUN_STARTED, ...base });
    let history: MessageRecord[];
    let hasExistingStudioArtifact = false;
    try {
      const [all, latestStudioArtifact] = await Promise.all([
        getMessages(deps.db, sessionId),
        args.mode === 'studio'
          ? readLatestHtmlArtifactInSession(deps.db, sessionId)
          : Promise.resolve(null),
      ]);
      history = all.filter((m) =>
        m.turnId ? m.turnStatus === 'completed' : m.status === 'completed',
      );
      hasExistingStudioArtifact = latestStudioArtifact !== null;
    } catch (err) {
      log.error({ err }, 'load history failed');
      await finishFailed('TURN_HISTORY_LOAD_FAILED', '服务开小差了，请重试。');
      return;
    }
    const tools: RuntimeAgentTool[] = [
      createArtifactTool({
        db: deps.db,
        objectStore: deps.objectStore,
        sessionId,
        turnId: runId,
        turnSignal: controller.signal,
        capabilityId: args.capabilityId,
        mode: args.mode,
        onArtifact: (artifact) => {
          if (args.mode === 'studio') lastStudioArtifactId = artifact.id;
          emitter.emit({
            type: EventType.STATE_DELTA,
            ...base,
            delta: [
              { op: 'add', path: `/artifacts/${artifact.id}`, value: artifact },
              { op: 'add', path: '/activeArtifactId', value: artifact.id },
            ],
          });
        },
      }),
    ];
    if (sandbox.enabled) {
      tools.push(
        ...createSandboxTools({
          backend: sandbox,
          sessionId,
          turnId: runId,
          ownerUserId: args.ownerUserId,
          turnSignal: controller.signal,
          onCleanupUnconfirmed: () => controller.abort(),
        }),
      );
    }
    let agent: TurnAgent;
    try {
      agent = deps.agentFactory({
        definition: args.definition,
        mode: args.mode,
        history,
        tools,
        promptText: args.text,
        hasExistingStudioArtifact,
      });
    } catch (err) {
      const message =
        err instanceof TurnAgentUnavailableError ? err.message : '对话服务暂时不可用，请重试。';
      log.error({ err }, 'agent factory failed');
      await finishFailed('TURN_AGENT_UNAVAILABLE', message);
      return;
    }

    type PromptOutcome =
      | { status: 'completed' }
      | { status: 'failed'; error: unknown }
      | { status: 'aborted' };
    let resolveAbort!: (outcome: PromptOutcome) => void;
    const abortOutcome = new Promise<PromptOutcome>((resolve) => {
      resolveAbort = resolve;
    });
    const onAbort = (): void => {
      try {
        agent.abort();
      } catch (err) {
        log.error({ err }, 'agent abort failed');
      }
      resolveAbort({ status: 'aborted' });
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    let idleTimedOut = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdleWatchdog = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        log.error({ idleTimeoutMs: deps.idleTimeoutMs }, 'turn idle watchdog fired, aborting');
        controller.abort();
        void stopSandboxCommands(sessionId, 'idle-timeout', { localExecution: true });
      }, deps.idleTimeoutMs);
      idleTimer.unref?.();
    };
    const unsubscribe = agent.subscribeTextDelta((delta) => {
      armIdleWatchdog();
      openText();
      assistantText += delta;
      emitter.emit({ type: EventType.TEXT_MESSAGE_CONTENT, ...base, messageId, delta });
    });
    const unsubscribeActivity = agent.subscribeActivity?.(armIdleWatchdog);
    const finishAborted = (): Promise<void> =>
      idleTimedOut
        ? finishFailed(
            'TURN_IDLE_TIMEOUT',
            `模型响应停滞超过 ${Math.round(deps.idleTimeoutMs / 1000)} 秒，本轮已终止，请重试。`,
            assistantText ? [{ type: 'text', text: assistantText }] : undefined,
          )
        : finishInterrupted();
    armIdleWatchdog();
    let promptOutcome: PromptOutcome = { status: 'aborted' };
    let promptSettled = false;
    const prompt = Promise.resolve()
      .then(() => agent.prompt(args.text))
      .then<PromptOutcome, PromptOutcome>(
        () => ({ status: 'completed' }),
        (error: unknown) => ({ status: 'failed', error }),
      )
      .finally(() => {
        promptSettled = true;
      });
    try {
      promptOutcome = await Promise.race([prompt, abortOutcome]);
    } finally {
      clearTimeout(idleTimer);
      unsubscribe();
      unsubscribeActivity?.();
      controller.signal.removeEventListener('abort', onAbort);
    }
    if (controller.signal.aborted || promptOutcome.status === 'aborted') {
      // Give a cooperative model SDK a bounded window to finish its own abort.
      // The mapped Promise remains observed after the window, so a late reject
      // cannot resume this Turn or touch the database after shutdown.
      let graceTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        prompt,
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, promptAbortGraceMs);
          graceTimer.unref?.();
        }),
      ]);
      clearTimeout(graceTimer);
      // An uncooperative Pi/tool Promise may still hold an object-store write.
      // The Turn signal fences its eventual commit; remote process cleanup must
      // additionally be proven before this replica can certify a terminal state.
      if (!promptSettled) {
        const cleanupSafe = await stopSandboxCommands(sessionId, 'turn-abort', {
          localExecution: true,
        }).then(
          () => true,
          (err: unknown) => {
            log.error({ err }, 'sandbox cleanup after unresolved prompt failed');
            return false;
          },
        );
        if (!cleanupSafe) {
          log.error(
            { runId },
            'aborted prompt and sandbox cleanup did not settle; keeping Turn running',
          );
          return;
        }
        // Tool adapters fence their commit after the abort signal, so an SDK Promise
        // that ignores abort may finish in memory but cannot mutate DB/SSE/sandbox
        // after this cleanup proof and terminal CAS.
        await finishAborted();
        return;
      }
      // Do not release the running Turn until this replica has waited for
      // sandboxd cleanup or the backend's UID-conditioned Pod deletion path.
      await stopSandboxCommands(sessionId, 'turn-abort', { localExecution: true });
      await finishAborted();
      return;
    }
    if (promptOutcome.status === 'failed') {
      log.error({ err: promptOutcome.error }, 'agent.prompt failed');
      await finishFailed('TURN_PROMPT_FAILED', '对话生成失败，请重试。');
      return;
    }
    const runtimeError = agent.runtimeError();
    if (runtimeError !== undefined) {
      log.error({ runtimeError }, 'llm runtime failure (encoded in message)');
      await finishFailed('TURN_RUNTIME_ERROR', '模型调用失败（额度/网络/服务波动），请重试。');
      return;
    }
    if (shutdownOwnedRuns.has(runId)) return;
    closeText();
    if (args.mode === 'studio' && !lastStudioArtifactId) {
      log.error({ runId }, 'Studio turn completed without an artifact revision');
      await finishFailed('TURN_STUDIO_ARTIFACT_MISSING', '本轮没有生成可保存的页面，请重试。');
      return;
    }
    let completedNextIdx: number | null;
    try {
      const rows = agent
        .transcript()
        .slice(history.length + 1)
        .flatMap((message) => {
          const row = agentMessageToRow(message);
          return row ? [row] : [];
        });
      await emitter.flush();
      if (shutdownOwnedRuns.has(runId)) return;
      completedNextIdx = await withTransaction(deps.db, async (transaction) => {
        await lockTurnSession(transaction, sessionId);
        if (!(await lockRunningTurn(transaction, runId, sessionId))) return null;
        const won = await finishTurnCas(transaction, { id: runId, status: 'completed' });
        if (!won) return null;
        await billing.settleUsage(transaction, runId);
        // 先在事务内把 Turn CAS 为 completed，再提升同一 Turn 的最终 Artifact；
        // 任一后续步骤失败都会回滚两者，Redis 仍要等整笔 PostgreSQL 事务提交。
        if (args.mode === 'studio' && lastStudioArtifactId) {
          const bound = await bindCapabilityUiArtifact(transaction, {
            capabilityId: args.capabilityId,
            artifactId: lastStudioArtifactId,
            studioSessionId: sessionId,
            turnId: runId,
          });
          if (!bound) throw new Error('Studio revision could not be promoted');
        }
        let idx = nextIdx;
        for (const row of rows) {
          await appendTurnMessage(transaction, {
            sessionId,
            turnId: runId,
            idx: idx++,
            ...row,
            status: 'completed',
          });
        }
        return idx;
      });
    } catch (err) {
      log.error({ err }, 'persist completed terminal state failed');
      // If COMMIT had an unknown outcome, this guarded fallback either wins the
      // still-running Turn or observes the already-committed completed status. It
      // never writes Redis before its own terminal transaction commits.
      await finishFailed('TURN_PERSIST_FAILED', '本轮回复未能保存（数据库异常），请重试。');
      return;
    }
    if (completedNextIdx === null) {
      log.error({ runId }, 'turn terminal state already claimed');
      return;
    }
    nextIdx = completedNextIdx;
    await appendCommittedTerminal(terminalTurn(runId, sessionId, 'completed', null)).catch(
      (err) => {
        log.error({ err, runId }, 'completed terminal event append failed');
      },
    );
  }

  return {
    async startTurn(input) {
      if (disposing) throw new Error('turn runner is shutting down');
      const sessionId = input.session.id;
      const runId = randomUUID();
      const controller = new AbortController();
      const transactionController = new AbortController();
      const running: ActiveTurn = {
        controller,
        runId,
        completion: Promise.resolve(),
        ...(input.knowledge ? { knowledgeRuntimeSourceSha: input.knowledge.runtimeSourceSha } : {}),
      };
      let markStartingSettled!: () => void;
      const startingTurn: StartingTurn = {
        sessionId,
        running,
        transactionController,
        settled: new Promise<void>((resolve) => {
          markStartingSettled = resolve;
        }),
      };
      // There is no await between the shutdown check and this registration, so
      // dispose either rejects this start or owns its complete transaction window.
      starting.add(startingTurn);
      const usageRequest: UsageRequest = {
        ownerUserId: input.session.ownerUserId,
        capabilityOwnerUserId: input.capabilityOwnerUserId,
        capabilityId: input.session.capabilityId,
        sessionId,
        usageId: input.usageId,
        text: input.text,
        ...(input.knowledge
          ? {
              knowledge: {
                binding: input.knowledge.resolved.binding,
                validatorPolicyVersion: input.knowledge.gate.validatorPolicyVersion,
              },
            }
          : {}),
      };
      type OpenTurnOutcome =
        | { kind: 'started'; userMessage: MessageRecord }
        | { kind: 'replayed'; userMessage: MessageRecord }
        | { kind: 'recharge_required'; balanceCents: bigint; requiredCents: bigint };
      let outcome: OpenTurnOutcome | undefined;
      let repairedTerminal: PublishedStreamEvent | undefined;
      let admissionStage: TurnAdmissionStage = 'transaction_setup';
      let retainActiveForRecovery = false;
      const admissionDeadline = AbortSignal.timeout(turnAdmissionDeadlineMs);
      const admissionSignal = AbortSignal.any([transactionController.signal, admissionDeadline]);
      type CommitConfirmation =
        | { kind: 'committed'; outcome: Extract<OpenTurnOutcome, { kind: 'started' }> }
        | { kind: 'absent' }
        | { kind: 'unknown' };
      const confirmCommittedStart = async (signal: AbortSignal): Promise<CommitConfirmation> => {
        const confirmed = await withTransaction(
          deps.db,
          async (tx) => {
            const lockedSession = await lockActiveSession(tx, sessionId, input.session.ownerUserId);
            if (!lockedSession) return null;
            const charge = await findUsageCharge(
              tx,
              usageRequest.ownerUserId,
              usageRequest.usageId,
            );
            if (
              !charge ||
              charge.turnId !== runId ||
              charge.sessionId !== sessionId ||
              charge.status !== 'reserved' ||
              charge.requestFingerprint !== usageRequestFingerprint(usageRequest) ||
              (await getRunningTurnId(tx, sessionId)) !== runId
            ) {
              return null;
            }
            const messages = await getMessages(tx, sessionId);
            const original = messages.find(
              (message) =>
                message.turnId === runId &&
                message.role === 'user' &&
                message.status === 'completed',
            );
            return original ? { kind: 'started' as const, userMessage: original } : null;
          },
          {
            signal,
            timeoutMs: TURN_OWNERSHIP_CONFIRMATION_DATABASE_TIMEOUT_MS,
          },
        ).catch(() => undefined);
        return confirmed
          ? { kind: 'committed', outcome: confirmed }
          : confirmed === null
            ? { kind: 'absent' }
            : { kind: 'unknown' };
      };
      const scheduleCommitRecovery = (): void => {
        retainActiveForRecovery = true;
        let retryDelayMs = 250;
        running.completion = (async () => {
          for (;;) {
            if (disposing || shutdownOwnedRuns.has(runId) || active.get(sessionId) !== running) {
              return;
            }
            const confirmation = await confirmCommittedStart(
              AbortSignal.any([
                disposalController.signal,
                AbortSignal.timeout(TURN_OWNERSHIP_CONFIRMATION_DEADLINE_MS),
              ]),
            );
            if (confirmation.kind === 'committed') {
              if (active.get(sessionId) !== running || disposing) return;
              // Preserve the same ordering as the ordinary admission path: a
              // repaired prior terminal must be visible before RUN_STARTED.
              if (repairedTerminal) deps.bus.publish(sessionId, repairedTerminal);
              if (input.knowledge) {
                await executeKnowledgeTurn({
                  sessionId,
                  definition: input.definition,
                  text: input.text,
                  controller,
                  runId,
                  knowledge: input.knowledge,
                  log: input.log,
                });
              } else {
                await executeTurn({
                  sessionId,
                  capabilityId: input.session.capabilityId,
                  definition: input.definition,
                  mode: input.session.mode,
                  text: input.text,
                  controller,
                  runId,
                  ownerUserId: input.session.ownerUserId,
                  log: input.log,
                });
              }
              return;
            }
            if (confirmation.kind === 'absent') return;
            await waitForDelay(retryDelayMs, disposalController.signal);
            retryDelayMs = Math.min(retryDelayMs * 2, TURN_OWNERSHIP_RETRY_MAX_DELAY_MS);
          }
        })()
          .catch((err) => input.log.error({ err, runId }, 'commit recovery execution failed'))
          .finally(() => {
            if (active.get(sessionId) === running) active.delete(sessionId);
          });
      };
      try {
        try {
          outcome = await withTransaction(
            deps.db,
            async (tx) => {
              admissionStage = 'session_lock';
              const lockedSession = await lockActiveSession(
                tx,
                sessionId,
                input.session.ownerUserId,
              );
              if (!lockedSession) throw new SessionInactiveError();
              if (
                input.knowledge
                  ? lockedSession.agentBinding.productKind !== 'knowledge_agent_test' ||
                    !knowledgeBindingsEqual(
                      lockedSession.agentBinding,
                      input.knowledge.resolved.binding,
                    )
                  : lockedSession.agentBinding.productKind !== 'legacy_capability'
              ) {
                throw new SessionInactiveError();
              }
              // usageId 锁跨 Session 生效；完全相同的重试优先于 SESSION_BUSY，
              // 因而原 Turn 仍运行时也能稳定返回原 user Message。
              admissionStage = 'usage_prepare';
              const preparation = await billing.prepareUsage(tx, usageRequest);
              if (preparation.kind === 'replay') {
                admissionStage = 'usage_replay_lookup';
                const messages = await getMessages(tx, sessionId);
                const original = messages.find(
                  (message) =>
                    message.turnId === preparation.turnId &&
                    message.role === 'user' &&
                    message.status === 'completed',
                );
                if (!original) throw new Error('replayed usage user message is missing');
                admissionStage = 'commit';
                return { kind: 'replayed' as const, userMessage: original };
              }
              // 不同 usageId 仍遵守单 Session 单 running Turn。额度的真正计数和金额
              // 尚未修改，所以 busy 或余额不足都不会留下预留。
              admissionStage = 'running_check';
              if (await getRunningTurnId(tx, sessionId)) {
                throw new SessionBusyError();
              }
              // PostgreSQL is authoritative for a previous committed terminal. Under
              // this Session lock, repair can replace a conflicting pre-fix marker;
              // ordinary terminal races still use strict appendTerminal semantics.
              admissionStage = 'terminal_repair';
              const previous = await getLatestTerminalTurn(tx, sessionId);
              if (previous) {
                repairedTerminal = await appendTerminalEvent(
                  previous.sessionId,
                  previous.id,
                  terminalEventForTurn(previous),
                  admissionSignal,
                  'repair',
                );
              }
              if (preparation.kind === 'insufficient') {
                admissionStage = 'commit';
                return {
                  kind: 'recharge_required' as const,
                  balanceCents: preparation.balanceCents,
                  requiredCents: preparation.requiredCents,
                };
              }
              admissionStage = 'turn_insert';
              await createTurn(tx, { id: runId, sessionId });
              admissionStage = 'usage_reservation';
              await billing.reservePreparedUsage(tx, {
                ...usageRequest,
                turnId: runId,
                preparation,
              });
              admissionStage = 'message_insert';
              const message = await appendTurnMessage(tx, {
                sessionId,
                turnId: runId,
                idx: 0,
                role: 'user',
                content: [{ type: 'text', text: input.text }],
                status: 'completed',
              });
              // Publish the local handle before COMMIT. A concurrent interrupt waits on
              // the Session row, then can verify this exact runId instead of falling
              // through the post-commit/pre-handle gap.
              active.set(sessionId, running);
              admissionStage = 'commit';
              return { kind: 'started' as const, userMessage: message };
            },
            {
              signal: admissionSignal,
              timeoutMs: turnAdmissionDatabaseTimeoutMs,
            },
          );
        } catch (err) {
          if (disposing || transactionController.signal.aborted) {
            throw new Error('turn runner is shutting down');
          }
          // TypeScript cannot observe assignments performed inside the transaction
          // callback, so widen the captured phase before classifying its failure.
          const failedStage = admissionStage as TurnAdmissionStage;
          const databaseCode = admissionDatabaseCode(err);
          const rawDatabaseCode = errorCode(err);
          const hasRawSqlState = rawDatabaseCode !== null && /^[0-9A-Z]{5}$/.test(rawDatabaseCode);
          // A server-returned non-transient, non-connection SQLSTATE is a
          // definitive transaction failure, including deferred constraints at
          // COMMIT. Do not turn it into an uncertain background recovery merely
          // because a subsequent confirmation query might also be unavailable.
          if (hasRawSqlState && !databaseCode && !rawDatabaseCode.startsWith('08')) {
            throw err;
          }
          let commitRecovered = false;
          if (failedStage === 'commit' && active.get(sessionId) === running) {
            const recoveryDeadline = AbortSignal.timeout(TURN_OWNERSHIP_CONFIRMATION_DEADLINE_MS);
            const recoverySignal = AbortSignal.any([
              transactionController.signal,
              recoveryDeadline,
            ]);
            admissionStage = 'commit_recovery';
            const confirmation = await confirmCommittedStart(recoverySignal);
            if (disposing || transactionController.signal.aborted) {
              throw new Error('turn runner is shutting down');
            }
            if (confirmation.kind === 'committed') {
              outcome = confirmation.outcome;
              commitRecovered = true;
            } else if (confirmation.kind === 'unknown') {
              scheduleCommitRecovery();
              throw new TurnAdmissionUnavailableError(
                'commit_recovery',
                admissionDeadline.aborted
                  ? 'deadline'
                  : databaseCode
                    ? 'database_transient'
                    : 'commit_unknown',
                databaseCode ?? undefined,
                err,
              );
            }
          }
          if (!commitRecovered) {
            if (databaseCode) {
              throw new TurnAdmissionUnavailableError(
                failedStage,
                'database_transient',
                databaseCode,
                err,
              );
            }
            if (hasRawSqlState && failedStage !== 'commit') {
              // A connection-class error outside COMMIT cannot have persisted this
              // transaction and retains the ordinary internal-error path.
              throw err;
            }
            if (admissionDeadline.aborted) {
              throw new TurnAdmissionUnavailableError(failedStage, 'deadline', undefined, err);
            }
            if (failedStage === 'commit') {
              throw new TurnAdmissionUnavailableError(
                failedStage,
                'commit_unknown',
                undefined,
                err,
              );
            }
            throw err;
          }
        }
        if (!outcome) throw new Error('turn admission completed without an outcome');
        if (disposing || transactionController.signal.aborted || shutdownOwnedRuns.has(runId)) {
          throw new Error('turn runner is shutting down');
        }
        // Publish the repaired id before executeTurn can append RUN_STARTED. Redis
        // Stream id filtering makes this safe when the original terminal publisher
        // also wakes up and publishes the same id later.
        if (repairedTerminal) deps.bus.publish(sessionId, repairedTerminal);
        if (outcome.kind === 'replayed') {
          return { status: 'replayed', userMessage: outcome.userMessage };
        }
        if (outcome.kind === 'recharge_required') {
          return {
            status: 'recharge_required',
            balanceCents: outcome.balanceCents,
            requiredCents: outcome.requiredCents,
          };
        }
        // A synchronous bus subscriber can initiate disposal, so fence once more
        // immediately before the only place that starts Pi execution.
        if (disposing || transactionController.signal.aborted || shutdownOwnedRuns.has(runId)) {
          throw new Error('turn runner is shutting down');
        }
        running.completion = (
          input.knowledge
            ? executeKnowledgeTurn({
                sessionId,
                definition: input.definition,
                text: input.text,
                controller,
                runId,
                knowledge: input.knowledge,
                log: input.log,
              })
            : executeTurn({
                sessionId,
                capabilityId: input.session.capabilityId,
                definition: input.definition,
                mode: input.session.mode,
                text: input.text,
                controller,
                runId,
                ownerUserId: input.session.ownerUserId,
                log: input.log,
              })
        )
          .catch((err) => input.log.error({ err }, 'turn crashed'))
          .finally(() => {
            if (active.get(sessionId) === running) active.delete(sessionId);
          });
        return { status: 'started', userMessage: outcome.userMessage };
      } catch (err) {
        if (!retainActiveForRecovery && active.get(sessionId) === running) {
          active.delete(sessionId);
        }
        // dispose retains this StartingTurn record even when COMMIT had an unknown
        // outcome, so a committed row joins the same cleanup and terminal fallback.
        if (disposing || transactionController.signal.aborted) {
          throw new Error('turn runner is shutting down');
        }
        throw err;
      } finally {
        starting.delete(startingTurn);
        markStartingSettled();
      }
    },
    async interrupt(sessionId) {
      const runId = await withTransaction(deps.db, async (transaction) => {
        // Linearize against startTurn, archive and terminal paths on the Session
        // row. In particular, wait for a just-created Turn's COMMIT instead of
        // falsely returning `interrupted: false` during the pre-commit window.
        await lockTurnSession(transaction, sessionId);
        return getRunningTurnId(transaction, sessionId);
      });
      if (!runId) return false;
      // Read the handle after the Session-locked database lookup. startTurn may
      // have published it while this request was waiting for COMMIT.
      const local = active.get(sessionId);
      if (local?.runId === runId) {
        local.controller.abort();
        if (!local.knowledgeRuntimeSourceSha) {
          await stopSandboxCommands(sessionId, 'local-interrupt', { localExecution: true });
        }
        return true;
      }
      const productKind = await readTurnProductKind(runId, sessionId);
      if (productKind === 'knowledge_agent_test') {
        const lastError = { code: 'TURN_INTERRUPTED', message: '本轮生成已打断。' };
        const won = await finishInterruptedRun({
          sessionId,
          runId,
          lastError,
          beforeFinish: async () => {
            // The only knowledge tools are read-only Bundle search/submission state. Publishing
            // the exact runId aborts a live owner; no sandbox cleanup is necessary.
            deps.interrupts.publish({ sessionId, runId });
          },
        });
        if (won) {
          await appendCommittedTerminal(
            terminalTurn(runId, sessionId, 'interrupted', lastError),
          ).catch((err) => {
            deps.log.error({ err, runId }, 'cross-replica terminal event append failed');
          });
        }
        return won;
      }
      if (!sandbox.enabled) {
        // A feature-off replica cannot prove cleanup for a foreign owner itself.
        // It broadcasts the exact runId without holding row locks, then accepts
        // only that Turn's committed interrupted state as the owner's proof.
        return waitForOwnerInterrupt(sessionId, runId);
      }
      const lastError = { code: 'TURN_INTERRUPTED', message: '本轮生成已打断。' };
      const won = await finishInterruptedRun({
        sessionId,
        runId,
        lastError,
        beforeFinish: async () => {
          // Keep the Session and running Turn rows locked until the remote
          // process namespace is gone. Redis is appended only after COMMIT.
          deps.interrupts.publish({ sessionId, runId });
          await stopSandboxCommands(sessionId, 'cross-replica-interrupt');
        },
      });
      if (won) {
        await appendCommittedTerminal(
          terminalTurn(runId, sessionId, 'interrupted', lastError),
        ).catch((err) => {
          deps.log.error({ err, runId }, 'cross-replica terminal event append failed');
        });
      }
      return won;
    },
    dispose(externalSignal) {
      if (disposePromise) return disposePromise;
      disposing = true;
      disposalController.abort();
      const deadline = Date.now() + shutdownTimeoutMs;
      const localDeadline = AbortSignal.timeout(shutdownTimeoutMs);
      const shutdownSignal = externalSignal
        ? AbortSignal.any([externalSignal, localDeadline])
        : localDeadline;
      // Snapshot synchronously with the disposal fence. A committed opener can
      // remove itself from both registries in the next microtask, but it must stay
      // owned by this shutdown once it passed the initial startTurn check.
      const startsAtShutdown = [...starting];
      const activeAtShutdown = [...active.entries()];
      let settleDispose!: () => void;
      let failDispose!: (reason: unknown) => void;
      // Install the shared Promise before firing any abort callback so re-entrant
      // disposal observes the same lifecycle without delaying the shutdown fence.
      disposePromise = new Promise<void>((resolve, reject) => {
        settleDispose = resolve;
        failDispose = reject;
      });
      const disposal = (async () => {
        clearInterval(sweepTimer);
        unsubscribeInterrupts();
        const shutdownRuns = new Map<string, { sessionId: string; running: ActiveTurn }>();
        for (const [sessionId, running] of activeAtShutdown) {
          shutdownRuns.set(running.runId, { sessionId, running });
        }
        for (const start of startsAtShutdown) {
          shutdownRuns.set(start.running.runId, {
            sessionId: start.sessionId,
            running: start.running,
          });
        }

        // Fence every opener before cancelling its transaction. Even an unknown
        // COMMIT outcome remains represented in shutdownRuns for the DB fallback.
        for (const { running } of shutdownRuns.values()) {
          shutdownOwnedRuns.add(running.runId);
        }
        const abortOpeningTransactions = (): void => {
          for (const start of startsAtShutdown) start.transactionController.abort();
        };
        if (shutdownSignal.aborted) {
          abortOpeningTransactions();
        } else {
          shutdownSignal.addEventListener('abort', abortOpeningTransactions, { once: true });
          for (const start of startsAtShutdown) {
            // Before active.set no COMMIT can have started, so cancellation is a
            // definite rollback. A published handle is allowed to finish COMMIT;
            // the Pi fence and the fallback below then terminalize its durable row.
            if (active.get(start.sessionId) !== start.running) {
              start.transactionController.abort();
            }
          }
        }

        const cleanupStates = new Map<string, 'pending' | 'safe' | 'failed'>();
        const firstPhase: Promise<unknown>[] = sweepInFlight ? [sweepInFlight] : [];
        firstPhase.push(...startsAtShutdown.map((start) => start.settled));
        for (const { sessionId, running } of shutdownRuns.values()) {
          running.controller.abort();
          if (running.knowledgeRuntimeSourceSha) {
            // Knowledge tools are read-only, turn-local operations and never create sandbox
            // descendants. Their abort fence is sufficient for terminalization.
            cleanupStates.set(running.runId, 'safe');
            continue;
          }
          cleanupStates.set(running.runId, 'pending');
          const cleanup = stopSandboxCommands(sessionId, 'runtime-shutdown', {
            localExecution: true,
          }).then(
            () => cleanupStates.set(running.runId, 'safe'),
            (err: unknown) => {
              cleanupStates.set(running.runId, 'failed');
              deps.log.error({ err, sessionId }, 'runtime shutdown sandbox cleanup failed');
            },
          );
          firstPhase.push(cleanup);
        }
        await waitUntilSignal(Promise.allSettled(firstPhase), shutdownSignal);

        if (!shutdownSignal.aborted) {
          // StartingTurn.settled is resolved only after startTurn has either
          // installed its final completion Promise or fenced Pi from starting.
          await waitUntilSignal(
            Promise.allSettled([...shutdownRuns.values()].map(({ running }) => running.completion)),
            shutdownSignal,
          );
        }

        if (!shutdownSignal.aborted) {
          const terminalFallbacks = [...shutdownRuns.values()].map(
            async ({ sessionId, running }) => {
              if (cleanupStates.get(running.runId) !== 'safe') {
                deps.log.error(
                  { sessionId, runId: running.runId },
                  'shutdown kept Turn running because sandbox cleanup was unconfirmed',
                );
                return;
              }
              const remaining = remainingMilliseconds(deadline);
              if (remaining <= 0 || shutdownSignal.aborted) return;
              const lastError = {
                code: 'TURN_SHUTDOWN',
                message: 'Runtime 正在关闭，本轮已终止，请重试。',
              };
              const won = await finishInterruptedRun({
                sessionId,
                runId: running.runId,
                lastError,
                knowledgeRuntimeSourceSha: running.knowledgeRuntimeSourceSha,
                transaction: { signal: shutdownSignal, timeoutMs: remaining },
              }).catch((err) => {
                deps.log.error({ err, runId: running.runId }, 'shutdown terminal fallback failed');
                return false;
              });
              if (won) {
                await appendCommittedTerminal(
                  terminalTurn(running.runId, sessionId, 'interrupted', lastError),
                  shutdownSignal,
                ).catch((err) => {
                  deps.log.error(
                    { err, runId: running.runId },
                    'shutdown terminal event append failed',
                  );
                });
              }
            },
          );
          await waitUntilSignal(Promise.allSettled(terminalFallbacks), shutdownSignal);
        }
        shutdownSignal.removeEventListener('abort', abortOpeningTransactions);
        active.clear();
      })();
      void disposal.then(settleDispose, failDispose);
      return disposePromise;
    },
  };
}
