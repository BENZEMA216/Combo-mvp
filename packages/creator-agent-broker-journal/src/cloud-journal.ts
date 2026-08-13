import type { ExpectedExecutionCapabilityBinding } from '@cb/creator-agent-protocol';

import type { ExecutionCapabilityAuthorityPort } from './capability-authority.js';
import {
  isTerminalInvocationState,
  transitionInvocation,
  type InvocationState,
} from './invocation.js';
import {
  BrokerAckLedger,
  formatFence,
  parseFence,
  type BrokerAckDurableProof,
  type LeaseAuthorityPort,
  type LeaseBinding,
} from './protocol.js';

export interface CloudConversation {
  readonly id: string;
  readonly agentVersionId: string;
  state: 'IDLE' | 'BUSY';
  activeInvocationId?: string;
}

export interface CloudMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly role: 'USER' | 'ASSISTANT';
  readonly clientMessageId?: string;
  readonly invocationId: string;
  readonly contentDigest: string;
}

export interface CloudInvocation {
  readonly id: string;
  readonly userMessageId: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly requestDigest: string;
  readonly contentDigest: string;
  readonly agentVersionId: string;
  readonly deploymentId: string;
  readonly workerInstallationId: string;
  readonly assignmentLeaseId: string;
  readonly assignmentFence: bigint;
  readonly executionCapabilityBinding: ExpectedExecutionCapabilityBinding;
  readonly executionCapabilityDigest: string;
  readonly executionCapabilityDeadlineAtMs: number;
  readonly executionCapabilityVerifiedAtMs: number;
  readonly prepareCommandId: string;
  readonly acceptedSourceEventId: string;
  state: InvocationState;
  resultDigest?: string;
  resultMessageId?: string;
  terminalSourceEventId?: string;
  terminalCommittedAtMs?: number;
  uncertaintyReason?: CloudUncertaintyReason;
}

export interface CloudInvocationEvent {
  readonly invocationId: string;
  readonly journalSeq: number;
  readonly source: 'API' | 'BROKER' | 'WORKER' | 'RUNTIME' | 'RECONCILER';
  readonly sourceEventId: string;
  readonly eventType: string;
  readonly payloadDigest: string;
  readonly canonicalBody: string;
}

export interface BrokerOutboxRecord {
  readonly commandId: string;
  readonly invocationId: string;
  readonly targetWorkerId: string;
  readonly commandType: 'invocation.prepare' | 'invocation.start' | 'invocation.cancel';
  readonly dedupeKey: string;
  readonly canonicalDigest: string;
  readonly deadlineAtMs: number;
  state: 'PENDING' | 'SENT' | 'ACKED' | 'EXPIRED';
  attemptCount: number;
  ackLevel?: 'RECEIVED' | 'PERSISTED';
  durableAckProof?: BrokerAckDurableProof;
}

export interface CloudJournalSnapshot {
  readonly conversations: ReadonlyMap<string, CloudConversation>;
  readonly invocations: ReadonlyMap<string, CloudInvocation>;
  readonly messages: readonly CloudMessage[];
  readonly events: readonly CloudInvocationEvent[];
  readonly outbox: readonly BrokerOutboxRecord[];
}

export type CloudJournalErrorCode =
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_BUSY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVOCATION_NOT_FOUND'
  | 'STALE_LEASE'
  | 'STALE_FENCE'
  | 'SOURCE_EVENT_CONFLICT'
  | 'FINAL_CONFLICT'
  | 'OUTBOX_NOT_FOUND'
  | 'OUTBOX_ACK_INVALID'
  | 'OUTBOX_CAPACITY'
  | 'JOURNAL_CAPACITY'
  | 'INVOCATION_DEADLINE_EXPIRED'
  | 'EXECUTION_CAPABILITY_INVALID';

export class CloudJournalError extends Error {
  constructor(readonly code: CloudJournalErrorCode) {
    super(code);
    this.name = 'CloudJournalError';
  }
}

export interface CapabilityBoundInput {
  readonly executionCapability: unknown;
  readonly expectedExecutionCapability: ExpectedExecutionCapabilityBinding;
}

export interface AcceptInvocationInput extends CapabilityBoundInput {
  readonly invocationId: string;
  readonly userMessageId: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly requestDigest: string;
  readonly contentDigest: string;
  readonly agentVersionDigest: string;
  readonly providerRequestId: string;
  readonly workerInstallationId: string;
  readonly lease: LeaseBinding;
  readonly nowMs: number;
  readonly prepareCommandId: string;
  readonly sourceEventId: string;
}

export interface AuthorityBoundEventInput {
  readonly invocationId: string;
  readonly workerInstallationId: string;
  readonly lease: LeaseBinding;
  readonly sourceEventId: string;
  readonly nowMs: number;
}

export interface WorkerEventInput {
  readonly invocationId: string;
  readonly workerInstallationId: string;
  readonly lease: LeaseBinding;
  readonly sourceEventId: string;
  readonly payloadDigest: string;
}

export interface BrokerOutboxAckInput {
  readonly commandId: string;
  readonly invocationId: string;
  readonly workerInstallationId: string;
  readonly lease: LeaseBinding;
  readonly level: 'RECEIVED' | 'PERSISTED';
  readonly canonicalDigest: string;
  readonly durableProof?: BrokerAckDurableProof;
}

export interface RequestStartInput extends AuthorityBoundEventInput, CapabilityBoundInput {
  readonly commandId: string;
}

export interface CommitFinalInput extends CapabilityBoundInput {
  readonly invocationId: string;
  readonly workerInstallationId: string;
  readonly lease: LeaseBinding;
  readonly sourceEventId: string;
  readonly resultMessageId: string;
  readonly resultDigest: string;
  readonly nowMs: number;
}

export type CloudUncertaintyReason =
  | 'START_DISPATCH_UNKNOWN'
  | 'HOST_EVIDENCE_LOST'
  | 'MODEL_ATTEMPT_UNKNOWN'
  | 'CANCEL_NOT_CONFIRMED'
  | 'JOURNAL_LOST';

export interface CloudJournalTransactionPort {
  createConversation(input: { id: string; agentVersionId: string }): CloudConversation;
  acceptInvocation(input: AcceptInvocationInput): CloudInvocation;
  markDispatchPending(input: AuthorityBoundEventInput): CloudInvocation;
  recordWorkerPersisted(input: WorkerEventInput): CloudInvocation;
  requestStart(input: RequestStartInput): CloudInvocation;
  recordRunning(input: WorkerEventInput): CloudInvocation;
  commitFinal(input: CommitFinalInput): CloudInvocation;
  markUncertain(input: {
    invocationId: string;
    sourceEventId: string;
    reason: CloudUncertaintyReason;
  }): CloudInvocation;
  acknowledgeOutbox(input: BrokerOutboxAckInput): BrokerOutboxRecord;
  snapshot(): CloudJournalSnapshot;
}

/**
 * PostgreSQL-style E1 reference reducer. Clone-and-swap models one SQL
 * transaction, but this adapter is explicitly not PostgreSQL persistence evidence.
 */
export class InMemoryCloudJournal implements CloudJournalTransactionPort {
  private conversations = new Map<string, CloudConversation>();
  private invocations = new Map<string, CloudInvocation>();
  private messages: CloudMessage[] = [];
  private events: CloudInvocationEvent[] = [];
  private outbox: BrokerOutboxRecord[] = [];
  private eventBodies = new Map<string, string>();

  constructor(
    private readonly leaseAuthority: LeaseAuthorityPort,
    private readonly capabilityAuthority: ExecutionCapabilityAuthorityPort,
    private readonly maxOutboxRecords = 1_000,
    private readonly maxJournalRecords = 100_000,
  ) {
    if (!Number.isSafeInteger(maxOutboxRecords) || maxOutboxRecords < 1) {
      throw new CloudJournalError('OUTBOX_CAPACITY');
    }
    if (!Number.isSafeInteger(maxJournalRecords) || maxJournalRecords < 1) {
      throw new CloudJournalError('JOURNAL_CAPACITY');
    }
  }

  createConversation(input: { id: string; agentVersionId: string }): CloudConversation {
    const existing = this.conversations.get(input.id);
    if (existing) {
      if (existing.agentVersionId !== input.agentVersionId) {
        throw new CloudJournalError('IDEMPOTENCY_CONFLICT');
      }
      return { ...existing };
    }
    const conversation: CloudConversation = {
      id: input.id,
      agentVersionId: input.agentVersionId,
      state: 'IDLE',
    };
    if (this.conversations.size >= this.maxJournalRecords) {
      throw new CloudJournalError('JOURNAL_CAPACITY');
    }
    this.conversations.set(input.id, conversation);
    return { ...conversation };
  }

  acceptInvocation(input: AcceptInvocationInput): CloudInvocation {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) throw new CloudJournalError('CONVERSATION_NOT_FOUND');
    const expected = expectedForAcceptance(input, conversation.agentVersionId);

    const invocationReplay = this.invocations.get(input.invocationId);
    if (invocationReplay) return this.replayAcceptance(invocationReplay, input, expected);
    const clientReplay = [...this.invocations.values()].find(
      (invocation) =>
        invocation.conversationId === input.conversationId &&
        invocation.clientMessageId === input.clientMessageId,
    );
    if (clientReplay) return this.replayAcceptance(clientReplay, input, expected);

    if (conversation.state === 'BUSY' || conversation.activeInvocationId) {
      throw new CloudJournalError('CONVERSATION_BUSY');
    }
    if (
      this.messages.some((message) => message.id === input.userMessageId) ||
      this.outbox.some((command) => command.commandId === input.prepareCommandId)
    ) {
      throw new CloudJournalError('IDEMPOTENCY_CONFLICT');
    }
    this.leaseAuthority.assertWorkerCurrent(input.lease, input.workerInstallationId, input.nowMs);
    const verified = this.verifyCapability(input.executionCapability, expected, input.nowMs);
    const deadlineAtMs = Date.parse(verified.capability.expiresAt);

    return this.atomic((draft) => {
      draft.assertOutboxCapacity(this.maxOutboxRecords);
      const invocation: CloudInvocation = {
        id: input.invocationId,
        userMessageId: input.userMessageId,
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
        requestDigest: input.requestDigest,
        contentDigest: input.contentDigest,
        agentVersionId: conversation.agentVersionId,
        deploymentId: input.lease.deploymentId,
        workerInstallationId: input.workerInstallationId,
        assignmentLeaseId: input.lease.leaseId,
        assignmentFence: parseFence(input.lease.fence),
        executionCapabilityBinding: cloneExpectedBinding(expected),
        executionCapabilityDigest: verified.capabilityDigest,
        executionCapabilityDeadlineAtMs: deadlineAtMs,
        executionCapabilityVerifiedAtMs: input.nowMs,
        prepareCommandId: input.prepareCommandId,
        acceptedSourceEventId: input.sourceEventId,
        state: transitionInvocation('ACCEPTED', { type: 'QUEUE' }),
      };
      draft.invocations.set(invocation.id, invocation);
      draft.messages.push({
        id: input.userMessageId,
        conversationId: input.conversationId,
        role: 'USER',
        clientMessageId: input.clientMessageId,
        invocationId: invocation.id,
        contentDigest: input.contentDigest,
      });
      draft.appendEvent({
        invocationId: invocation.id,
        source: 'API',
        sourceEventId: input.sourceEventId,
        eventType: 'invocation.accepted',
        payloadDigest: input.requestDigest,
        canonicalBody: acceptanceEventBody(invocation),
      });
      draft.outbox.push({
        commandId: input.prepareCommandId,
        invocationId: invocation.id,
        targetWorkerId: input.workerInstallationId,
        commandType: 'invocation.prepare',
        dedupeKey: `prepare:${invocation.id}`,
        canonicalDigest: invocation.requestDigest,
        deadlineAtMs,
        state: 'PENDING',
        attemptCount: 0,
      });
      const targetConversation = draft.conversations.get(input.conversationId)!;
      targetConversation.state = 'BUSY';
      targetConversation.activeInvocationId = invocation.id;
      return invocation;
    });
  }

  markDispatchPending(input: AuthorityBoundEventInput): CloudInvocation {
    this.leaseAuthority.assertWorkerCurrent(input.lease, input.workerInstallationId, input.nowMs);
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertAssignment(invocation, input.workerInstallationId, input.lease);
      assertDeadline(invocation.executionCapabilityDeadlineAtMs, input.nowMs);
      const replay = draft.appendEvent({
        invocationId: invocation.id,
        source: 'BROKER',
        sourceEventId: input.sourceEventId,
        eventType: 'invocation.dispatch_pending',
        payloadDigest: invocation.requestDigest,
        canonicalBody: assignmentEventBody(invocation, invocation.requestDigest),
      });
      if (!replay) {
        invocation.state = transitionInvocation(invocation.state, { type: 'REQUEST_DISPATCH' });
      }
      const command = draft.outbox.find(
        (record) =>
          record.invocationId === invocation.id && record.commandType === 'invocation.prepare',
      );
      if (!command) throw new CloudJournalError('OUTBOX_NOT_FOUND');
      if (!replay) {
        command.state = 'SENT';
        command.attemptCount += 1;
      }
      return invocation;
    });
  }

  recordWorkerPersisted(input: WorkerEventInput): CloudInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertAssignment(invocation, input.workerInstallationId, input.lease);
      draft.assertOutboxPersisted(invocation.id, 'invocation.prepare');
      const replay = draft.appendEvent({
        invocationId: invocation.id,
        source: 'WORKER',
        sourceEventId: input.sourceEventId,
        eventType: 'invocation.persisted',
        payloadDigest: input.payloadDigest,
        canonicalBody: assignmentEventBody(invocation, input.payloadDigest),
      });
      if (!replay) {
        invocation.state = transitionInvocation(invocation.state, { type: 'WORKER_PERSISTED' });
      }
      return invocation;
    });
  }

  requestStart(input: RequestStartInput): CloudInvocation {
    this.leaseAuthority.assertWorkerCurrent(input.lease, input.workerInstallationId, input.nowMs);
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertAssignment(invocation, input.workerInstallationId, input.lease);
      this.verifyCapability(
        input.executionCapability,
        invocation.executionCapabilityBinding,
        input.nowMs,
      );
      const canonicalBody = canonicalControlBody({
        ...assignmentFields(invocation),
        commandId: input.commandId,
        requestDigest: invocation.requestDigest,
        executionCapabilityDigest: invocation.executionCapabilityDigest,
      });
      const replay = draft.appendEvent({
        invocationId: invocation.id,
        source: 'BROKER',
        sourceEventId: input.sourceEventId,
        eventType: 'invocation.start_requested',
        payloadDigest: invocation.requestDigest,
        canonicalBody,
      });
      if (!replay) {
        if (
          draft.outbox.some(
            (record) =>
              record.commandId === input.commandId || record.dedupeKey === `start:${invocation.id}`,
          )
        ) {
          throw new CloudJournalError('IDEMPOTENCY_CONFLICT');
        }
        draft.assertOutboxCapacity(this.maxOutboxRecords);
        invocation.state = transitionInvocation(invocation.state, { type: 'REQUEST_START' });
        draft.outbox.push({
          commandId: input.commandId,
          invocationId: invocation.id,
          targetWorkerId: invocation.workerInstallationId,
          commandType: 'invocation.start',
          dedupeKey: `start:${invocation.id}`,
          canonicalDigest: invocation.requestDigest,
          deadlineAtMs: invocation.executionCapabilityDeadlineAtMs,
          state: 'PENDING',
          attemptCount: 0,
        });
      }
      return invocation;
    });
  }

  recordRunning(input: WorkerEventInput): CloudInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertAssignment(invocation, input.workerInstallationId, input.lease);
      draft.assertOutboxPersisted(invocation.id, 'invocation.start');
      const replay = draft.appendEvent({
        invocationId: invocation.id,
        source: 'RUNTIME',
        sourceEventId: input.sourceEventId,
        eventType: 'invocation.started',
        payloadDigest: input.payloadDigest,
        canonicalBody: assignmentEventBody(invocation, input.payloadDigest),
      });
      if (!replay) {
        invocation.state = transitionInvocation(invocation.state, { type: 'HOST_STARTED' });
      }
      return invocation;
    });
  }

  commitFinal(input: CommitFinalInput): CloudInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertAssignment(invocation, input.workerInstallationId, input.lease);
      const exactTerminalReplay =
        invocation.state === 'SUCCEEDED' &&
        invocation.resultDigest === input.resultDigest &&
        invocation.resultMessageId === input.resultMessageId &&
        invocation.terminalSourceEventId === input.sourceEventId;
      const verifyAtMs =
        exactTerminalReplay && invocation.terminalCommittedAtMs !== undefined
          ? invocation.terminalCommittedAtMs
          : input.nowMs;
      const verified = this.verifyCapability(
        input.executionCapability,
        invocation.executionCapabilityBinding,
        verifyAtMs,
      );
      if (verified.capabilityDigest !== invocation.executionCapabilityDigest) {
        throw new CloudJournalError('EXECUTION_CAPABILITY_INVALID');
      }
      const canonicalBody = canonicalControlBody({
        ...assignmentFields(invocation),
        conversationId: invocation.conversationId,
        resultMessageId: input.resultMessageId,
        resultDigest: input.resultDigest,
        executionCapabilityDigest: verified.capabilityDigest,
      });
      const replay = draft.appendEvent({
        invocationId: invocation.id,
        source: 'WORKER',
        sourceEventId: input.sourceEventId,
        eventType: 'invocation.succeeded',
        payloadDigest: input.resultDigest,
        canonicalBody,
      });
      if (exactTerminalReplay) {
        if (!replay) throw new CloudJournalError('SOURCE_EVENT_CONFLICT');
        return invocation;
      }
      if (isTerminalInvocationState(invocation.state) || replay) {
        throw new CloudJournalError('FINAL_CONFLICT');
      }
      if (
        draft.messages.some(
          (message) =>
            message.id === input.resultMessageId ||
            (message.invocationId === invocation.id && message.role === 'ASSISTANT'),
        )
      ) {
        throw new CloudJournalError('FINAL_CONFLICT');
      }
      invocation.state = transitionInvocation(invocation.state, {
        type: 'SUCCEED',
        finalDurable: true,
      });
      invocation.resultDigest = input.resultDigest;
      invocation.resultMessageId = input.resultMessageId;
      invocation.terminalSourceEventId = input.sourceEventId;
      invocation.terminalCommittedAtMs = input.nowMs;
      draft.messages.push({
        id: input.resultMessageId,
        conversationId: invocation.conversationId,
        role: 'ASSISTANT',
        invocationId: invocation.id,
        contentDigest: input.resultDigest,
      });
      const conversation = draft.conversations.get(invocation.conversationId)!;
      conversation.state = 'IDLE';
      delete conversation.activeInvocationId;
      return invocation;
    });
  }

  markUncertain(input: {
    invocationId: string;
    sourceEventId: string;
    reason: CloudUncertaintyReason;
  }): CloudInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      const replay = draft.appendEvent({
        invocationId: invocation.id,
        source: 'RECONCILER',
        sourceEventId: input.sourceEventId,
        eventType: 'invocation.uncertain',
        payloadDigest: input.reason,
        canonicalBody: canonicalControlBody({ invocationId: invocation.id, reason: input.reason }),
      });
      if (replay) return invocation;
      if (invocation.state !== 'RECONCILING') {
        invocation.state = transitionInvocation(invocation.state, {
          type: 'LOSE_EXECUTION_EVIDENCE',
        });
      }
      invocation.state = transitionInvocation(invocation.state, { type: 'RECONCILE_UNCERTAIN' });
      invocation.uncertaintyReason = input.reason;
      const conversation = draft.conversations.get(invocation.conversationId)!;
      conversation.state = 'IDLE';
      delete conversation.activeInvocationId;
      return invocation;
    });
  }

  acknowledgeOutbox(input: BrokerOutboxAckInput): BrokerOutboxRecord {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertAssignment(invocation, input.workerInstallationId, input.lease);
      const command = draft.outbox.find((record) => record.commandId === input.commandId);
      if (!command) throw new CloudJournalError('OUTBOX_NOT_FOUND');
      if (
        command.invocationId !== invocation.id ||
        command.targetWorkerId !== input.workerInstallationId ||
        command.canonicalDigest !== input.canonicalDigest
      ) {
        throw new CloudJournalError('OUTBOX_ACK_INVALID');
      }
      if (input.level === 'RECEIVED') {
        if (input.durableProof) throw new CloudJournalError('OUTBOX_ACK_INVALID');
        if (command.ackLevel === 'PERSISTED') return command;
        command.ackLevel = 'RECEIVED';
        return command;
      }
      const proof = input.durableProof;
      if (!proof) throw new CloudJournalError('OUTBOX_ACK_INVALID');
      if (command.ackLevel === 'PERSISTED') {
        if (canonicalProof(command.durableAckProof) !== canonicalProof(proof)) {
          throw new CloudJournalError('OUTBOX_ACK_INVALID');
        }
        return command;
      }
      try {
        const ledger = new BrokerAckLedger(1);
        ledger.acknowledge({
          messageId: command.commandId,
          canonicalDigest: command.canonicalDigest,
          level: 'RECEIVED',
        });
        ledger.acknowledge({
          messageId: command.commandId,
          canonicalDigest: input.canonicalDigest,
          level: 'PERSISTED',
          durableProof: proof,
        });
      } catch {
        throw new CloudJournalError('OUTBOX_ACK_INVALID');
      }
      command.ackLevel = 'PERSISTED';
      command.durableAckProof = { ...proof };
      command.state = 'ACKED';
      return command;
    });
  }

  expireOutbox(nowMs: number): readonly BrokerOutboxRecord[] {
    return this.atomic((draft) => {
      const expired: BrokerOutboxRecord[] = [];
      for (const record of draft.outbox) {
        if (
          (record.state === 'PENDING' || record.state === 'SENT') &&
          record.deadlineAtMs <= nowMs
        ) {
          record.state = 'EXPIRED';
          expired.push({ ...record });
        }
      }
      return expired;
    });
  }

  snapshot(): CloudJournalSnapshot {
    return {
      conversations: cloneMap(this.conversations),
      invocations: cloneInvocationMap(this.invocations),
      messages: this.messages.map((message) => ({ ...message })),
      events: this.events.map((event) => ({ ...event })),
      outbox: this.outbox.map(cloneOutboxRecord),
    };
  }

  serialize(): string {
    return JSON.stringify({
      schemaVersion: 1,
      conversations: [...this.conversations.values()],
      invocations: [...this.invocations.values()].map((invocation) => ({
        ...invocation,
        assignmentFence: formatFence(invocation.assignmentFence),
      })),
      messages: this.messages,
      events: this.events,
      outbox: this.outbox,
      eventBodies: [...this.eventBodies],
    });
  }

  static restore(
    serialized: string,
    leaseAuthority: LeaseAuthorityPort,
    capabilityAuthority: ExecutionCapabilityAuthorityPort,
    maxOutboxRecords = 1_000,
    maxJournalRecords = 100_000,
  ): InMemoryCloudJournal {
    const parsed = JSON.parse(serialized) as SerializedCloudJournal;
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.conversations) ||
      !Array.isArray(parsed.invocations) ||
      !Array.isArray(parsed.messages) ||
      !Array.isArray(parsed.events) ||
      !Array.isArray(parsed.outbox) ||
      !Array.isArray(parsed.eventBodies) ||
      parsed.outbox.length > maxOutboxRecords ||
      parsed.conversations.length > maxJournalRecords ||
      parsed.invocations.length > maxJournalRecords ||
      parsed.messages.length > maxJournalRecords ||
      parsed.events.length > maxJournalRecords ||
      parsed.eventBodies.length > maxJournalRecords
    ) {
      throw new CloudJournalError('IDEMPOTENCY_CONFLICT');
    }
    const journal = new InMemoryCloudJournal(
      leaseAuthority,
      capabilityAuthority,
      maxOutboxRecords,
      maxJournalRecords,
    );
    journal.conversations = new Map(
      parsed.conversations.map((conversation) => [conversation.id, { ...conversation }]),
    );
    journal.invocations = new Map(
      parsed.invocations.map((invocation) => [
        invocation.id,
        {
          ...invocation,
          assignmentFence: parseFence(invocation.assignmentFence),
          executionCapabilityBinding: cloneExpectedBinding(invocation.executionCapabilityBinding),
        },
      ]),
    );
    journal.messages = parsed.messages.map((message) => ({ ...message }));
    journal.events = parsed.events.map((event) => ({ ...event }));
    journal.outbox = parsed.outbox.map(cloneOutboxRecord);
    journal.eventBodies = new Map(parsed.eventBodies);
    if (
      journal.conversations.size !== parsed.conversations.length ||
      journal.invocations.size !== parsed.invocations.length ||
      journal.eventBodies.size !== parsed.eventBodies.length ||
      new Set(journal.messages.map((message) => message.id)).size !== journal.messages.length ||
      new Set(journal.outbox.map((record) => record.commandId)).size !== journal.outbox.length
    ) {
      throw new CloudJournalError('IDEMPOTENCY_CONFLICT');
    }
    return journal;
  }

  private replayAcceptance(
    invocation: CloudInvocation,
    input: AcceptInvocationInput,
    expected: ExpectedExecutionCapabilityBinding,
  ): CloudInvocation {
    if (!sameAcceptBinding(invocation, input, expected)) {
      throw new CloudJournalError('IDEMPOTENCY_CONFLICT');
    }
    const verified = this.verifyCapability(
      input.executionCapability,
      expected,
      invocation.executionCapabilityVerifiedAtMs,
    );
    if (invocation.executionCapabilityDigest !== verified.capabilityDigest) {
      throw new CloudJournalError('IDEMPOTENCY_CONFLICT');
    }
    const message = this.messages.find((candidate) => candidate.id === input.userMessageId);
    const command = this.outbox.find((candidate) => candidate.commandId === input.prepareCommandId);
    const event = this.events.find(
      (candidate) => candidate.source === 'API' && candidate.sourceEventId === input.sourceEventId,
    );
    if (
      !message ||
      message.invocationId !== invocation.id ||
      message.contentDigest !== input.contentDigest ||
      !command ||
      command.invocationId !== invocation.id ||
      !event ||
      event.invocationId !== invocation.id ||
      event.canonicalBody !== acceptanceEventBody(invocation)
    ) {
      throw new CloudJournalError('IDEMPOTENCY_CONFLICT');
    }
    return cloneInvocation(invocation);
  }

  private verifyCapability(
    input: unknown,
    expected: ExpectedExecutionCapabilityBinding,
    nowMs: number,
  ) {
    try {
      return this.capabilityAuthority.verify(input, expected, new Date(nowMs));
    } catch {
      throw new CloudJournalError('EXECUTION_CAPABILITY_INVALID');
    }
  }

  private atomic<T>(operation: (draft: CloudDraft) => T): T {
    const draft = new CloudDraft({
      conversations: cloneMap(this.conversations),
      invocations: cloneInvocationMap(this.invocations),
      messages: this.messages.map((message) => ({ ...message })),
      events: this.events.map((event) => ({ ...event })),
      outbox: this.outbox.map(cloneOutboxRecord),
      eventBodies: new Map(this.eventBodies),
    });
    const result = operation(draft);
    draft.assertJournalCapacity(this.maxJournalRecords);
    this.conversations = draft.conversations;
    this.invocations = draft.invocations;
    this.messages = draft.messages;
    this.events = draft.events;
    this.outbox = draft.outbox;
    this.eventBodies = draft.eventBodies;
    return cloneResult(result);
  }
}

interface SerializedCloudJournal {
  schemaVersion: number;
  conversations: CloudConversation[];
  invocations: Array<Omit<CloudInvocation, 'assignmentFence'> & { assignmentFence: string }>;
  messages: CloudMessage[];
  events: CloudInvocationEvent[];
  outbox: BrokerOutboxRecord[];
  eventBodies: Array<[string, string]>;
}

class CloudDraft {
  readonly conversations: Map<string, CloudConversation>;
  readonly invocations: Map<string, CloudInvocation>;
  readonly messages: CloudMessage[];
  readonly events: CloudInvocationEvent[];
  readonly outbox: BrokerOutboxRecord[];
  readonly eventBodies: Map<string, string>;

  constructor(input: {
    conversations: Map<string, CloudConversation>;
    invocations: Map<string, CloudInvocation>;
    messages: CloudMessage[];
    events: CloudInvocationEvent[];
    outbox: BrokerOutboxRecord[];
    eventBodies: Map<string, string>;
  }) {
    this.conversations = input.conversations;
    this.invocations = input.invocations;
    this.messages = input.messages;
    this.events = input.events;
    this.outbox = input.outbox;
    this.eventBodies = input.eventBodies;
  }

  requireInvocation(invocationId: string): CloudInvocation {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) throw new CloudJournalError('INVOCATION_NOT_FOUND');
    return invocation;
  }

  assertAssignment(
    invocation: CloudInvocation,
    workerInstallationId: string,
    lease: LeaseBinding,
  ): void {
    if (
      invocation.workerInstallationId !== workerInstallationId ||
      invocation.deploymentId !== lease.deploymentId ||
      invocation.assignmentLeaseId !== lease.leaseId
    ) {
      throw new CloudJournalError('STALE_LEASE');
    }
    if (invocation.assignmentFence !== parseFence(lease.fence)) {
      throw new CloudJournalError('STALE_FENCE');
    }
  }

  appendEvent(input: Omit<CloudInvocationEvent, 'journalSeq'>): boolean {
    const eventKey = `${input.source}:${input.sourceEventId}`;
    const canonicalBody = `${input.invocationId}\0${input.eventType}\0${input.payloadDigest}\0${input.canonicalBody}`;
    const known = this.eventBodies.get(eventKey);
    if (known !== undefined) {
      if (known !== canonicalBody) throw new CloudJournalError('SOURCE_EVENT_CONFLICT');
      return true;
    }
    const journalSeq =
      this.events.reduce(
        (max, event) =>
          event.invocationId === input.invocationId ? Math.max(max, event.journalSeq) : max,
        0,
      ) + 1;
    this.events.push({ ...input, journalSeq });
    this.eventBodies.set(eventKey, canonicalBody);
    return false;
  }

  assertOutboxCapacity(maxRecords: number): void {
    if (this.outbox.length >= maxRecords) throw new CloudJournalError('OUTBOX_CAPACITY');
  }

  assertJournalCapacity(maxRecords: number): void {
    if (
      this.conversations.size > maxRecords ||
      this.invocations.size > maxRecords ||
      this.messages.length > maxRecords ||
      this.events.length > maxRecords ||
      this.eventBodies.size > maxRecords
    ) {
      throw new CloudJournalError('JOURNAL_CAPACITY');
    }
  }

  assertOutboxPersisted(
    invocationId: string,
    commandType: BrokerOutboxRecord['commandType'],
  ): void {
    const record = this.outbox.find(
      (candidate) =>
        candidate.invocationId === invocationId && candidate.commandType === commandType,
    );
    if (!record || record.state !== 'ACKED' || record.ackLevel !== 'PERSISTED') {
      throw new CloudJournalError('OUTBOX_ACK_INVALID');
    }
  }
}

function expectedForAcceptance(
  input: AcceptInvocationInput,
  agentVersionId: string,
): ExpectedExecutionCapabilityBinding {
  return {
    ...input.expectedExecutionCapability,
    invocationId: input.invocationId,
    conversationId: input.conversationId,
    deploymentId: input.lease.deploymentId,
    agentVersionId,
    agentVersionDigest: input.agentVersionDigest,
    workerInstallationId: input.workerInstallationId,
    leaseId: input.lease.leaseId,
    fence: input.lease.fence,
    providerRequestId: input.providerRequestId,
    requestDigest: input.requestDigest,
  };
}

function sameAcceptBinding(
  invocation: CloudInvocation,
  input: AcceptInvocationInput,
  expected: ExpectedExecutionCapabilityBinding,
): boolean {
  return (
    invocation.id === input.invocationId &&
    invocation.userMessageId === input.userMessageId &&
    invocation.conversationId === input.conversationId &&
    invocation.clientMessageId === input.clientMessageId &&
    invocation.requestDigest === input.requestDigest &&
    invocation.contentDigest === input.contentDigest &&
    invocation.agentVersionId === expected.agentVersionId &&
    invocation.workerInstallationId === input.workerInstallationId &&
    invocation.deploymentId === input.lease.deploymentId &&
    invocation.assignmentLeaseId === input.lease.leaseId &&
    invocation.assignmentFence === parseFence(input.lease.fence) &&
    canonicalControlBody({
      capabilityId: invocation.executionCapabilityBinding.capabilityId,
      nonce: invocation.executionCapabilityBinding.nonce,
    }) === canonicalControlBody({ capabilityId: expected.capabilityId, nonce: expected.nonce }) &&
    invocation.prepareCommandId === input.prepareCommandId &&
    invocation.acceptedSourceEventId === input.sourceEventId
  );
}

function acceptanceEventBody(invocation: CloudInvocation): string {
  return canonicalControlBody({
    ...assignmentFields(invocation),
    invocationId: invocation.id,
    conversationId: invocation.conversationId,
    clientMessageId: invocation.clientMessageId,
    requestDigest: invocation.requestDigest,
    contentDigest: invocation.contentDigest,
    userMessageId: invocation.userMessageId,
    prepareCommandId: invocation.prepareCommandId,
    executionCapabilityDigest: invocation.executionCapabilityDigest,
  });
}

function assignmentFields(invocation: CloudInvocation): Readonly<Record<string, string>> {
  return {
    invocationId: invocation.id,
    workerInstallationId: invocation.workerInstallationId,
    deploymentId: invocation.deploymentId,
    leaseId: invocation.assignmentLeaseId,
    fence: formatFence(invocation.assignmentFence),
  };
}

function assignmentEventBody(invocation: CloudInvocation, payloadDigest: string): string {
  return canonicalControlBody({ ...assignmentFields(invocation), payloadDigest });
}

function canonicalControlBody(value: Readonly<Record<string, string | number | boolean>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function assertDeadline(deadlineAtMs: number, nowMs: number): void {
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= nowMs) {
    throw new CloudJournalError('INVOCATION_DEADLINE_EXPIRED');
  }
}

function cloneExpectedBinding(
  binding: ExpectedExecutionCapabilityBinding,
): ExpectedExecutionCapabilityBinding {
  return { ...binding, budget: { ...binding.budget } };
}

function cloneInvocation(invocation: CloudInvocation): CloudInvocation {
  return {
    ...invocation,
    executionCapabilityBinding: cloneExpectedBinding(invocation.executionCapabilityBinding),
  };
}

function cloneInvocationMap(
  source: ReadonlyMap<string, CloudInvocation>,
): Map<string, CloudInvocation> {
  return new Map([...source].map(([key, value]) => [key, cloneInvocation(value)]));
}

function cloneMap<T extends object>(source: ReadonlyMap<string, T>): Map<string, T> {
  return new Map([...source].map(([key, value]) => [key, { ...value }]));
}

function cloneResult<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => ({ ...item })) as T;
  if (value && typeof value === 'object') {
    if ('executionCapabilityBinding' in value) {
      return cloneInvocation(value as unknown as CloudInvocation) as T;
    }
    return { ...value } as T;
  }
  return value;
}

function cloneOutboxRecord(record: BrokerOutboxRecord): BrokerOutboxRecord {
  return {
    ...record,
    ...(record.durableAckProof ? { durableAckProof: { ...record.durableAckProof } } : {}),
  };
}

function canonicalProof(proof: BrokerAckDurableProof | undefined): string {
  return proof ? `${proof.journal}\0${proof.transactionId}\0${proof.canonicalDigest}` : '';
}
