import type { ExpectedExecutionCapabilityBinding } from '@cb/creator-agent-protocol';

import type { ExecutionCapabilityAuthorityPort } from './capability-authority.js';
import { parseFence, type LeaseBinding } from './protocol.js';

export const LOCAL_INVOCATION_STATES = [
  'RECEIVED',
  'PREPARED',
  'STARTING',
  'RUNNING',
  'FINAL_READY',
  'CLOUD_COMMITTED',
  'FAILED',
  'CANCELLED',
  'UNCERTAIN',
] as const;

export type LocalInvocationState = (typeof LOCAL_INVOCATION_STATES)[number];

const LOCAL_TERMINAL = new Set<LocalInvocationState>([
  'CLOUD_COMMITTED',
  'FAILED',
  'CANCELLED',
  'UNCERTAIN',
]);

export interface LocalInvocation {
  readonly invocationId: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly requestDigest: string;
  readonly agentVersionId: string;
  readonly deploymentId: string;
  readonly workerInstallationId: string;
  readonly leaseId: string;
  readonly fence: bigint;
  readonly executionCapabilityBinding: ExpectedExecutionCapabilityBinding;
  readonly executionCapabilityDigest: string;
  readonly executionCapabilityDeadlineAtMs: number;
  readonly executionCapabilityVerifiedAtMs: number;
  readonly prepareCommandId: string;
  state: LocalInvocationState;
  startCommandId?: string;
  runtimeTurnId?: string;
  resultDigest?: string;
  resultSourceEventId?: string;
  terminalSourceEventId?: string;
  terminalPayloadDigest?: string;
  hostDispatchIntentCount: number;
  hostDispatchConfirmedCount: number;
  cloudCommitted: boolean;
}

export interface LocalOutboxRecord {
  readonly sourceEventId: string;
  readonly invocationId: string;
  readonly eventType:
    | 'invocation.prepared'
    | 'invocation.started'
    | 'invocation.succeeded'
    | 'invocation.failed'
    | 'invocation.cancelled'
    | 'invocation.uncertain';
  readonly payloadDigest: string;
  readonly deadlineAtMs: number;
  state: 'PENDING' | 'CLOUD_COMMITTED' | 'EXPIRED';
  attemptCount: number;
}

export interface WorkerJournalSnapshot {
  readonly invocations: ReadonlyMap<string, LocalInvocation>;
  readonly outbox: readonly LocalOutboxRecord[];
  readonly activeInvocationId?: string;
}

export type WorkerJournalErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'CLIENT_MESSAGE_CONFLICT'
  | 'WORKER_BUSY'
  | 'INVOCATION_NOT_FOUND'
  | 'STALE_LEASE'
  | 'STALE_FENCE'
  | 'ILLEGAL_LOCAL_TRANSITION'
  | 'START_COMMAND_CONFLICT'
  | 'HOST_DISPATCH_ALREADY_CONFIRMED'
  | 'FINAL_CONFLICT'
  | 'OUTBOX_NOT_FOUND'
  | 'OUTBOX_CAPACITY'
  | 'INVOCATION_CAPACITY'
  | 'INVOCATION_DEADLINE_EXPIRED'
  | 'EXECUTION_CAPABILITY_INVALID';

export class WorkerJournalError extends Error {
  constructor(readonly code: WorkerJournalErrorCode) {
    super(code);
    this.name = 'WorkerJournalError';
  }
}

export interface WorkerCapabilityBoundInput {
  readonly executionCapability: unknown;
  readonly expectedExecutionCapability: ExpectedExecutionCapabilityBinding;
}

export interface WorkerPrepareInput extends WorkerCapabilityBoundInput {
  readonly invocationId: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly requestDigest: string;
  readonly agentVersionId: string;
  readonly agentVersionDigest: string;
  readonly providerRequestId: string;
  readonly workerInstallationId: string;
  readonly lease: LeaseBinding;
  readonly nowMs: number;
  readonly commandId: string;
  readonly sourceEventId: string;
}

export interface WorkerStartInput extends WorkerCapabilityBoundInput {
  readonly invocationId: string;
  readonly requestDigest: string;
  readonly workerInstallationId: string;
  readonly lease: LeaseBinding;
  readonly nowMs: number;
  readonly commandId: string;
}

export interface WorkerJournalTransactionPort {
  prepare(input: WorkerPrepareInput): LocalInvocation;
  start(input: WorkerStartInput): LocalInvocation;
  confirmHostDispatch(input: {
    invocationId: string;
    requestDigest: string;
    runtimeTurnId: string;
    sourceEventId: string;
    nowMs: number;
  }): LocalInvocation;
  writeFinal(input: {
    invocationId: string;
    requestDigest: string;
    resultDigest: string;
    sourceEventId: string;
    nowMs: number;
  }): LocalInvocation;
  markCloudCommitted(invocationId: string, sourceEventId: string): LocalInvocation;
  markUncertain(input: {
    invocationId: string;
    sourceEventId: string;
    reasonDigest: string;
  }): LocalInvocation;
  markFailed(input: {
    invocationId: string;
    sourceEventId: string;
    errorDigest: string;
  }): LocalInvocation;
  markCancelled(input: {
    invocationId: string;
    sourceEventId: string;
    interruptEvidenceDigest: string;
  }): LocalInvocation;
  snapshot(): WorkerJournalSnapshot;
}

/**
 * SQLite-style E1 reference reducer. Clone-and-swap stands in for one SQLite
 * transaction; it is not WAL/FULL-fsync or process-crash evidence.
 */
export class InMemoryWorkerJournal implements WorkerJournalTransactionPort {
  private invocations = new Map<string, LocalInvocation>();
  private outbox: LocalOutboxRecord[] = [];
  private activeInvocationId?: string;

  constructor(
    private readonly capabilityAuthority: ExecutionCapabilityAuthorityPort,
    private readonly maxOutboxRecords = 1_000,
    private readonly maxInvocationRecords = 10_000,
  ) {
    if (!Number.isSafeInteger(maxOutboxRecords) || maxOutboxRecords < 1) {
      throw new WorkerJournalError('OUTBOX_CAPACITY');
    }
    if (!Number.isSafeInteger(maxInvocationRecords) || maxInvocationRecords < 1) {
      throw new WorkerJournalError('INVOCATION_CAPACITY');
    }
  }

  prepare(input: WorkerPrepareInput): LocalInvocation {
    const expected = expectedForPrepare(input);
    const existing = this.invocations.get(input.invocationId);
    if (existing) {
      if (!samePrepareBinding(existing, input)) {
        throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
      }
      const verified = this.verifyCapability(
        input.executionCapability,
        expected,
        existing.executionCapabilityVerifiedAtMs,
      );
      if (existing.executionCapabilityDigest !== verified.capabilityDigest) {
        throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
      }
      const preparedEvent = this.outbox.find(
        (item) =>
          item.invocationId === existing.invocationId && item.eventType === 'invocation.prepared',
      );
      if (!preparedEvent || preparedEvent.sourceEventId !== input.sourceEventId) {
        throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
      }
      return cloneInvocation(existing);
    }
    const clientReplay = [...this.invocations.values()].find(
      (item) =>
        item.conversationId === input.conversationId &&
        item.clientMessageId === input.clientMessageId,
    );
    if (clientReplay) throw new WorkerJournalError('CLIENT_MESSAGE_CONFLICT');
    if (this.activeInvocationId) throw new WorkerJournalError('WORKER_BUSY');
    if (this.invocations.size >= this.maxInvocationRecords) {
      throw new WorkerJournalError('INVOCATION_CAPACITY');
    }
    const verified = this.verifyCapability(input.executionCapability, expected, input.nowMs);
    const deadlineAtMs = Date.parse(verified.capability.expiresAt);

    return this.atomic((draft) => {
      draft.assertOutboxCapacity(this.maxOutboxRecords);
      const invocation: LocalInvocation = {
        invocationId: input.invocationId,
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
        requestDigest: input.requestDigest,
        agentVersionId: input.agentVersionId,
        deploymentId: input.lease.deploymentId,
        workerInstallationId: input.workerInstallationId,
        leaseId: input.lease.leaseId,
        fence: parseFence(input.lease.fence),
        executionCapabilityBinding: cloneExpectedBinding(expected),
        executionCapabilityDigest: verified.capabilityDigest,
        executionCapabilityDeadlineAtMs: deadlineAtMs,
        executionCapabilityVerifiedAtMs: input.nowMs,
        prepareCommandId: input.commandId,
        state: 'PREPARED',
        hostDispatchIntentCount: 0,
        hostDispatchConfirmedCount: 0,
        cloudCommitted: false,
      };
      draft.invocations.set(invocation.invocationId, invocation);
      draft.activeInvocationId = invocation.invocationId;
      draft.appendOutbox({
        sourceEventId: input.sourceEventId,
        invocationId: invocation.invocationId,
        eventType: 'invocation.prepared',
        payloadDigest: invocation.requestDigest,
        deadlineAtMs,
        state: 'PENDING',
        attemptCount: 0,
      });
      return invocation;
    });
  }

  start(input: WorkerStartInput): LocalInvocation {
    const current = this.invocations.get(input.invocationId);
    if (!current) throw new WorkerJournalError('INVOCATION_NOT_FOUND');
    const verified = this.verifyCapability(
      input.executionCapability,
      current.executionCapabilityBinding,
      input.nowMs,
    );
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertRequest(invocation, input.requestDigest);
      draft.assertExecutionBinding(
        invocation,
        input.workerInstallationId,
        input.lease,
        verified.capabilityDigest,
        input.nowMs,
      );
      if (invocation.startCommandId) {
        if (invocation.startCommandId !== input.commandId) {
          throw new WorkerJournalError('START_COMMAND_CONFLICT');
        }
        return invocation;
      }
      if (invocation.state !== 'PREPARED') {
        throw new WorkerJournalError('ILLEGAL_LOCAL_TRANSITION');
      }
      invocation.startCommandId = input.commandId;
      invocation.state = 'STARTING';
      invocation.hostDispatchIntentCount += 1;
      return invocation;
    });
  }

  confirmHostDispatch(input: {
    invocationId: string;
    requestDigest: string;
    runtimeTurnId: string;
    sourceEventId: string;
    nowMs: number;
  }): LocalInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertRequest(invocation, input.requestDigest);
      assertLocalDeadline(invocation.executionCapabilityDeadlineAtMs, input.nowMs);
      if (invocation.runtimeTurnId) {
        if (invocation.runtimeTurnId !== input.runtimeTurnId) {
          throw new WorkerJournalError('HOST_DISPATCH_ALREADY_CONFIRMED');
        }
        const startedEvent = draft.outbox.find(
          (item) =>
            item.invocationId === invocation.invocationId &&
            item.eventType === 'invocation.started',
        );
        if (!startedEvent || startedEvent.sourceEventId !== input.sourceEventId) {
          throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
        }
        return invocation;
      }
      if (invocation.state !== 'STARTING') {
        throw new WorkerJournalError('ILLEGAL_LOCAL_TRANSITION');
      }
      draft.assertOutboxCapacity(this.maxOutboxRecords);
      invocation.runtimeTurnId = input.runtimeTurnId;
      invocation.hostDispatchConfirmedCount += 1;
      invocation.state = 'RUNNING';
      draft.appendOutbox({
        sourceEventId: input.sourceEventId,
        invocationId: invocation.invocationId,
        eventType: 'invocation.started',
        payloadDigest: input.runtimeTurnId,
        deadlineAtMs: invocation.executionCapabilityDeadlineAtMs,
        state: 'PENDING',
        attemptCount: 0,
      });
      return invocation;
    });
  }

  writeFinal(input: {
    invocationId: string;
    requestDigest: string;
    resultDigest: string;
    sourceEventId: string;
    nowMs: number;
  }): LocalInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertRequest(invocation, input.requestDigest);
      if (invocation.resultDigest) {
        if (
          invocation.resultDigest !== input.resultDigest ||
          invocation.resultSourceEventId !== input.sourceEventId
        ) {
          throw new WorkerJournalError('FINAL_CONFLICT');
        }
        return invocation;
      }
      assertLocalDeadline(invocation.executionCapabilityDeadlineAtMs, input.nowMs);
      if (invocation.state !== 'RUNNING') {
        throw new WorkerJournalError('ILLEGAL_LOCAL_TRANSITION');
      }
      draft.assertOutboxCapacity(this.maxOutboxRecords);
      invocation.resultDigest = input.resultDigest;
      invocation.resultSourceEventId = input.sourceEventId;
      invocation.terminalSourceEventId = input.sourceEventId;
      invocation.terminalPayloadDigest = input.resultDigest;
      invocation.state = 'FINAL_READY';
      draft.appendOutbox({
        sourceEventId: input.sourceEventId,
        invocationId: invocation.invocationId,
        eventType: 'invocation.succeeded',
        payloadDigest: input.resultDigest,
        deadlineAtMs: invocation.executionCapabilityDeadlineAtMs,
        state: 'PENDING',
        attemptCount: 0,
      });
      return invocation;
    });
  }

  markCloudCommitted(invocationId: string, sourceEventId: string): LocalInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(invocationId);
      if (invocation.cloudCommitted) {
        if (invocation.terminalSourceEventId !== sourceEventId) {
          throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
        }
        return invocation;
      }
      if (
        (invocation.state !== 'FINAL_READY' &&
          invocation.state !== 'FAILED' &&
          invocation.state !== 'CANCELLED' &&
          invocation.state !== 'UNCERTAIN') ||
        invocation.terminalSourceEventId !== sourceEventId
      ) {
        throw new WorkerJournalError('ILLEGAL_LOCAL_TRANSITION');
      }
      const record = draft.outbox.find(
        (item) => item.invocationId === invocationId && item.sourceEventId === sourceEventId,
      );
      if (!record) throw new WorkerJournalError('OUTBOX_NOT_FOUND');
      record.state = 'CLOUD_COMMITTED';
      invocation.cloudCommitted = true;
      if (invocation.state === 'FINAL_READY') invocation.state = 'CLOUD_COMMITTED';
      if (draft.activeInvocationId === invocationId) delete draft.activeInvocationId;
      return invocation;
    });
  }

  markUncertain(input: {
    invocationId: string;
    sourceEventId: string;
    reasonDigest: string;
  }): LocalInvocation {
    return this.markNonSuccessTerminal({
      invocationId: input.invocationId,
      sourceEventId: input.sourceEventId,
      payloadDigest: input.reasonDigest,
      state: 'UNCERTAIN',
      eventType: 'invocation.uncertain',
    });
  }

  markFailed(input: {
    invocationId: string;
    sourceEventId: string;
    errorDigest: string;
  }): LocalInvocation {
    return this.markNonSuccessTerminal({
      invocationId: input.invocationId,
      sourceEventId: input.sourceEventId,
      payloadDigest: input.errorDigest,
      state: 'FAILED',
      eventType: 'invocation.failed',
    });
  }

  markCancelled(input: {
    invocationId: string;
    sourceEventId: string;
    interruptEvidenceDigest: string;
  }): LocalInvocation {
    return this.markNonSuccessTerminal({
      invocationId: input.invocationId,
      sourceEventId: input.sourceEventId,
      payloadDigest: input.interruptEvidenceDigest,
      state: 'CANCELLED',
      eventType: 'invocation.cancelled',
    });
  }

  expireOutbox(nowMs: number): readonly LocalOutboxRecord[] {
    return this.atomic((draft) => {
      const expired: LocalOutboxRecord[] = [];
      for (const record of draft.outbox) {
        if (
          record.state === 'PENDING' &&
          record.deadlineAtMs <= nowMs &&
          !isTerminalOutboxEvent(record.eventType)
        ) {
          record.state = 'EXPIRED';
          expired.push({ ...record });
        }
      }
      return expired;
    });
  }

  serialize(): string {
    return JSON.stringify({
      schemaVersion: 1,
      invocations: [...this.invocations.values()].map((invocation) => ({
        ...invocation,
        fence: invocation.fence.toString(10),
      })),
      outbox: this.outbox,
      activeInvocationId: this.activeInvocationId ?? null,
    });
  }

  static restore(
    serialized: string,
    capabilityAuthority: ExecutionCapabilityAuthorityPort,
    maxOutboxRecords = 1_000,
    maxInvocationRecords = 10_000,
  ): InMemoryWorkerJournal {
    const parsed = JSON.parse(serialized) as SerializedWorkerJournal;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.outbox.length > maxOutboxRecords ||
      parsed.invocations.length > maxInvocationRecords ||
      new Set(parsed.outbox.map((record) => record.sourceEventId)).size !== parsed.outbox.length
    ) {
      throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
    }
    const journal = new InMemoryWorkerJournal(
      capabilityAuthority,
      maxOutboxRecords,
      maxInvocationRecords,
    );
    journal.invocations = new Map(
      parsed.invocations.map((invocation) => [
        invocation.invocationId,
        {
          ...invocation,
          fence: parseFence(invocation.fence),
          executionCapabilityBinding: cloneExpectedBinding(invocation.executionCapabilityBinding),
        },
      ]),
    );
    journal.outbox = parsed.outbox.map((record) => ({ ...record }));
    journal.activeInvocationId = parsed.activeInvocationId ?? undefined;
    if (
      journal.invocations.size !== parsed.invocations.length ||
      (journal.activeInvocationId !== undefined &&
        !journal.invocations.has(journal.activeInvocationId))
    ) {
      throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
    }
    return journal;
  }

  private markNonSuccessTerminal(input: {
    invocationId: string;
    sourceEventId: string;
    payloadDigest: string;
    state: 'FAILED' | 'CANCELLED' | 'UNCERTAIN';
    eventType: 'invocation.failed' | 'invocation.cancelled' | 'invocation.uncertain';
  }): LocalInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      if (invocation.state === input.state) {
        if (
          invocation.terminalSourceEventId !== input.sourceEventId ||
          invocation.terminalPayloadDigest !== input.payloadDigest
        ) {
          throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
        }
        return invocation;
      }
      if (
        invocation.state !== 'PREPARED' &&
        invocation.state !== 'STARTING' &&
        invocation.state !== 'RUNNING'
      ) {
        throw new WorkerJournalError('ILLEGAL_LOCAL_TRANSITION');
      }
      draft.assertOutboxCapacity(this.maxOutboxRecords);
      invocation.state = input.state;
      invocation.terminalSourceEventId = input.sourceEventId;
      invocation.terminalPayloadDigest = input.payloadDigest;
      draft.appendOutbox({
        sourceEventId: input.sourceEventId,
        invocationId: invocation.invocationId,
        eventType: input.eventType,
        payloadDigest: input.payloadDigest,
        deadlineAtMs: invocation.executionCapabilityDeadlineAtMs,
        state: 'PENDING',
        attemptCount: 0,
      });
      if (draft.activeInvocationId === input.invocationId) delete draft.activeInvocationId;
      return invocation;
    });
  }

  snapshot(): WorkerJournalSnapshot {
    return {
      invocations: cloneInvocationMap(this.invocations),
      outbox: this.outbox.map((item) => ({ ...item })),
      ...(this.activeInvocationId ? { activeInvocationId: this.activeInvocationId } : {}),
    };
  }

  private verifyCapability(
    input: unknown,
    expected: ExpectedExecutionCapabilityBinding,
    nowMs: number,
  ) {
    try {
      return this.capabilityAuthority.verify(input, expected, new Date(nowMs));
    } catch {
      throw new WorkerJournalError('EXECUTION_CAPABILITY_INVALID');
    }
  }

  private atomic<T>(operation: (draft: WorkerDraft) => T): T {
    const draft = new WorkerDraft({
      invocations: cloneInvocationMap(this.invocations),
      outbox: this.outbox.map((item) => ({ ...item })),
      activeInvocationId: this.activeInvocationId,
    });
    const result = operation(draft);
    this.invocations = draft.invocations;
    this.outbox = draft.outbox;
    this.activeInvocationId = draft.activeInvocationId;
    return cloneResult(result);
  }
}

interface SerializedWorkerJournal {
  schemaVersion: number;
  invocations: Array<Omit<LocalInvocation, 'fence'> & { fence: string }>;
  outbox: LocalOutboxRecord[];
  activeInvocationId: string | null;
}

class WorkerDraft {
  readonly invocations: Map<string, LocalInvocation>;
  readonly outbox: LocalOutboxRecord[];
  activeInvocationId?: string;

  constructor(input: {
    invocations: Map<string, LocalInvocation>;
    outbox: LocalOutboxRecord[];
    activeInvocationId?: string;
  }) {
    this.invocations = input.invocations;
    this.outbox = input.outbox;
    this.activeInvocationId = input.activeInvocationId;
  }

  requireInvocation(invocationId: string): LocalInvocation {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) throw new WorkerJournalError('INVOCATION_NOT_FOUND');
    return invocation;
  }

  assertRequest(invocation: LocalInvocation, requestDigest: string): void {
    if (invocation.requestDigest !== requestDigest) {
      throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
    }
  }

  assertExecutionBinding(
    invocation: LocalInvocation,
    workerInstallationId: string,
    lease: LeaseBinding,
    executionCapabilityDigest: string,
    nowMs: number,
  ): void {
    if (
      invocation.workerInstallationId !== workerInstallationId ||
      invocation.deploymentId !== lease.deploymentId ||
      invocation.leaseId !== lease.leaseId ||
      invocation.executionCapabilityDigest !== executionCapabilityDigest
    ) {
      throw new WorkerJournalError('STALE_LEASE');
    }
    if (invocation.fence !== parseFence(lease.fence)) throw new WorkerJournalError('STALE_FENCE');
    assertLocalDeadline(invocation.executionCapabilityDeadlineAtMs, nowMs);
  }

  assertOutboxCapacity(maxRecords: number): void {
    if (this.outbox.length >= maxRecords) throw new WorkerJournalError('OUTBOX_CAPACITY');
  }

  appendOutbox(record: LocalOutboxRecord): void {
    const existing = this.outbox.find((item) => item.sourceEventId === record.sourceEventId);
    if (existing) {
      if (
        existing.invocationId !== record.invocationId ||
        existing.eventType !== record.eventType ||
        existing.payloadDigest !== record.payloadDigest ||
        existing.deadlineAtMs !== record.deadlineAtMs
      ) {
        throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
      }
      return;
    }
    this.outbox.push(record);
  }
}

function expectedForPrepare(input: WorkerPrepareInput): ExpectedExecutionCapabilityBinding {
  return {
    ...input.expectedExecutionCapability,
    invocationId: input.invocationId,
    conversationId: input.conversationId,
    deploymentId: input.lease.deploymentId,
    agentVersionId: input.agentVersionId,
    agentVersionDigest: input.agentVersionDigest,
    workerInstallationId: input.workerInstallationId,
    leaseId: input.lease.leaseId,
    fence: input.lease.fence,
    providerRequestId: input.providerRequestId,
    requestDigest: input.requestDigest,
  };
}

function samePrepareBinding(existing: LocalInvocation, input: WorkerPrepareInput): boolean {
  return (
    existing.invocationId === input.invocationId &&
    existing.requestDigest === input.requestDigest &&
    existing.conversationId === input.conversationId &&
    existing.clientMessageId === input.clientMessageId &&
    existing.agentVersionId === input.agentVersionId &&
    existing.workerInstallationId === input.workerInstallationId &&
    existing.deploymentId === input.lease.deploymentId &&
    existing.prepareCommandId === input.commandId &&
    existing.leaseId === input.lease.leaseId &&
    existing.fence === parseFence(input.lease.fence) &&
    existing.executionCapabilityBinding.capabilityId ===
      input.expectedExecutionCapability.capabilityId &&
    existing.executionCapabilityBinding.nonce === input.expectedExecutionCapability.nonce
  );
}

function assertLocalDeadline(deadlineAtMs: number, nowMs: number): void {
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= nowMs) {
    throw new WorkerJournalError('INVOCATION_DEADLINE_EXPIRED');
  }
}

function cloneExpectedBinding(
  binding: ExpectedExecutionCapabilityBinding,
): ExpectedExecutionCapabilityBinding {
  return { ...binding, budget: { ...binding.budget } };
}

function cloneInvocation(invocation: LocalInvocation): LocalInvocation {
  return {
    ...invocation,
    executionCapabilityBinding: cloneExpectedBinding(invocation.executionCapabilityBinding),
  };
}

function cloneInvocationMap(
  source: ReadonlyMap<string, LocalInvocation>,
): Map<string, LocalInvocation> {
  return new Map([...source].map(([key, value]) => [key, cloneInvocation(value)]));
}

function cloneResult<T>(value: T): T {
  if (value && typeof value === 'object' && 'executionCapabilityBinding' in value) {
    return cloneInvocation(value as unknown as LocalInvocation) as T;
  }
  if (Array.isArray(value)) return value.map((item) => ({ ...item })) as T;
  if (value && typeof value === 'object') return { ...value } as T;
  return value;
}

export function isLocalInvocationTerminal(state: LocalInvocationState): boolean {
  return LOCAL_TERMINAL.has(state);
}

function isTerminalOutboxEvent(eventType: LocalOutboxRecord['eventType']): boolean {
  return (
    eventType === 'invocation.succeeded' ||
    eventType === 'invocation.failed' ||
    eventType === 'invocation.cancelled' ||
    eventType === 'invocation.uncertain'
  );
}
