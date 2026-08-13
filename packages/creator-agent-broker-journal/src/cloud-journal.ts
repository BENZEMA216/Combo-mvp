import {
  isTerminalInvocationState,
  transitionInvocation,
  type InvocationState,
} from './invocation.js';
import { parseFence, type LeaseBinding } from './protocol.js';

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
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly requestDigest: string;
  readonly agentVersionId: string;
  readonly assignedWorkerId: string;
  readonly assignmentLeaseId: string;
  readonly assignmentFence: bigint;
  state: InvocationState;
  resultDigest?: string;
  resultMessageId?: string;
  uncertaintyReason?: string;
}

export interface CloudInvocationEvent {
  readonly invocationId: string;
  readonly journalSeq: number;
  readonly source: 'API' | 'BROKER' | 'WORKER' | 'RUNTIME' | 'RECONCILER';
  readonly sourceEventId: string;
  readonly eventType: string;
  readonly payloadDigest: string;
}

export interface BrokerOutboxRecord {
  readonly commandId: string;
  readonly invocationId: string;
  readonly targetWorkerId: string;
  readonly commandType: 'invocation.prepare' | 'invocation.start' | 'invocation.cancel';
  readonly dedupeKey: string;
  state: 'PENDING' | 'SENT' | 'ACKED' | 'EXPIRED';
  attemptCount: number;
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
  | 'OUTBOX_NOT_FOUND';

export class CloudJournalError extends Error {
  constructor(readonly code: CloudJournalErrorCode) {
    super(code);
    this.name = 'CloudJournalError';
  }
}

export interface CloudJournalTransactionPort {
  createConversation(input: { id: string; agentVersionId: string }): CloudConversation;
  acceptInvocation(input: {
    invocationId: string;
    userMessageId: string;
    conversationId: string;
    clientMessageId: string;
    requestDigest: string;
    contentDigest: string;
    assignedWorkerId: string;
    lease: LeaseBinding;
    prepareCommandId: string;
    sourceEventId: string;
  }): CloudInvocation;
  markDispatchPending(invocationId: string, sourceEventId: string): CloudInvocation;
  recordWorkerPersisted(input: {
    invocationId: string;
    workerId: string;
    lease: LeaseBinding;
    sourceEventId: string;
    payloadDigest: string;
  }): CloudInvocation;
  requestStart(input: {
    invocationId: string;
    commandId: string;
    sourceEventId: string;
  }): CloudInvocation;
  recordRunning(input: {
    invocationId: string;
    workerId: string;
    lease: LeaseBinding;
    sourceEventId: string;
    payloadDigest: string;
  }): CloudInvocation;
  commitFinal(input: {
    invocationId: string;
    workerId: string;
    lease: LeaseBinding;
    sourceEventId: string;
    resultMessageId: string;
    resultDigest: string;
    executionCapabilityValid: boolean;
  }): CloudInvocation;
  markUncertain(input: {
    invocationId: string;
    sourceEventId: string;
    reason: string;
  }): CloudInvocation;
  acknowledgeOutbox(commandId: string): BrokerOutboxRecord;
  snapshot(): CloudJournalSnapshot;
}

/**
 * PostgreSQL-style reference reducer. This adapter is deliberately in-memory:
 * clone-and-swap models one SQL transaction, but it is not E2 persistence evidence.
 */
export class InMemoryCloudJournal implements CloudJournalTransactionPort {
  private conversations = new Map<string, CloudConversation>();
  private invocations = new Map<string, CloudInvocation>();
  private messages: CloudMessage[] = [];
  private events: CloudInvocationEvent[] = [];
  private outbox: BrokerOutboxRecord[] = [];
  private readonly eventBodies = new Map<string, string>();

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
    this.conversations.set(input.id, conversation);
    return { ...conversation };
  }

  acceptInvocation(input: {
    invocationId: string;
    userMessageId: string;
    conversationId: string;
    clientMessageId: string;
    requestDigest: string;
    contentDigest: string;
    assignedWorkerId: string;
    lease: LeaseBinding;
    prepareCommandId: string;
    sourceEventId: string;
  }): CloudInvocation {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) throw new CloudJournalError('CONVERSATION_NOT_FOUND');
    const invocationReplay = this.invocations.get(input.invocationId);
    if (invocationReplay) {
      if (
        invocationReplay.conversationId !== input.conversationId ||
        invocationReplay.clientMessageId !== input.clientMessageId ||
        invocationReplay.requestDigest !== input.requestDigest
      ) {
        throw new CloudJournalError('IDEMPOTENCY_CONFLICT');
      }
      return { ...invocationReplay };
    }
    const replay = [...this.invocations.values()].find(
      (item) =>
        item.conversationId === input.conversationId &&
        item.clientMessageId === input.clientMessageId,
    );
    if (replay) {
      if (replay.requestDigest !== input.requestDigest) {
        throw new CloudJournalError('IDEMPOTENCY_CONFLICT');
      }
      return { ...replay };
    }
    if (conversation.state === 'BUSY' || conversation.activeInvocationId) {
      throw new CloudJournalError('CONVERSATION_BUSY');
    }
    if (
      this.messages.some((message) => message.id === input.userMessageId) ||
      this.outbox.some((command) => command.commandId === input.prepareCommandId)
    ) {
      throw new CloudJournalError('IDEMPOTENCY_CONFLICT');
    }

    return this.atomic((draft) => {
      const invocation: CloudInvocation = {
        id: input.invocationId,
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
        requestDigest: input.requestDigest,
        agentVersionId: conversation.agentVersionId,
        assignedWorkerId: input.assignedWorkerId,
        assignmentLeaseId: input.lease.leaseId,
        assignmentFence: parseFence(input.lease.fence),
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
      });
      draft.outbox.push({
        commandId: input.prepareCommandId,
        invocationId: invocation.id,
        targetWorkerId: input.assignedWorkerId,
        commandType: 'invocation.prepare',
        dedupeKey: `prepare:${invocation.id}`,
        state: 'PENDING',
        attemptCount: 0,
      });
      const targetConversation = draft.conversations.get(input.conversationId)!;
      targetConversation.state = 'BUSY';
      targetConversation.activeInvocationId = invocation.id;
      return invocation;
    });
  }

  markDispatchPending(invocationId: string, sourceEventId: string): CloudInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(invocationId);
      const replay = draft.appendEvent({
        invocationId,
        source: 'BROKER',
        sourceEventId,
        eventType: 'invocation.dispatch_pending',
        payloadDigest: invocation.requestDigest,
      });
      if (!replay) {
        invocation.state = transitionInvocation(invocation.state, { type: 'REQUEST_DISPATCH' });
      }
      const command = draft.outbox.find(
        (item) => item.invocationId === invocationId && item.commandType === 'invocation.prepare',
      );
      if (!command) throw new CloudJournalError('OUTBOX_NOT_FOUND');
      if (!replay) {
        command.state = 'SENT';
        command.attemptCount += 1;
      }
      return invocation;
    });
  }

  recordWorkerPersisted(input: {
    invocationId: string;
    workerId: string;
    lease: LeaseBinding;
    sourceEventId: string;
    payloadDigest: string;
  }): CloudInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertAssignment(invocation, input.workerId, input.lease);
      const replay = draft.appendEvent({
        invocationId: invocation.id,
        source: 'WORKER',
        sourceEventId: input.sourceEventId,
        eventType: 'invocation.persisted',
        payloadDigest: input.payloadDigest,
      });
      if (!replay) {
        invocation.state = transitionInvocation(invocation.state, { type: 'WORKER_PERSISTED' });
      }
      return invocation;
    });
  }

  requestStart(input: {
    invocationId: string;
    commandId: string;
    sourceEventId: string;
  }): CloudInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      const replay = draft.appendEvent({
        invocationId: invocation.id,
        source: 'BROKER',
        sourceEventId: input.sourceEventId,
        eventType: 'invocation.start_requested',
        payloadDigest: invocation.requestDigest,
      });
      if (!replay) {
        invocation.state = transitionInvocation(invocation.state, { type: 'REQUEST_START' });
        if (
          draft.outbox.some(
            (item) =>
              item.commandId === input.commandId || item.dedupeKey === `start:${invocation.id}`,
          )
        ) {
          throw new CloudJournalError('IDEMPOTENCY_CONFLICT');
        }
        draft.outbox.push({
          commandId: input.commandId,
          invocationId: invocation.id,
          targetWorkerId: invocation.assignedWorkerId,
          commandType: 'invocation.start',
          dedupeKey: `start:${invocation.id}`,
          state: 'PENDING',
          attemptCount: 0,
        });
      }
      return invocation;
    });
  }

  recordRunning(input: {
    invocationId: string;
    workerId: string;
    lease: LeaseBinding;
    sourceEventId: string;
    payloadDigest: string;
  }): CloudInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertAssignment(invocation, input.workerId, input.lease);
      const replay = draft.appendEvent({
        invocationId: invocation.id,
        source: 'RUNTIME',
        sourceEventId: input.sourceEventId,
        eventType: 'invocation.started',
        payloadDigest: input.payloadDigest,
      });
      if (!replay) {
        invocation.state = transitionInvocation(invocation.state, { type: 'HOST_STARTED' });
      }
      return invocation;
    });
  }

  commitFinal(input: {
    invocationId: string;
    workerId: string;
    lease: LeaseBinding;
    sourceEventId: string;
    resultMessageId: string;
    resultDigest: string;
    executionCapabilityValid: boolean;
  }): CloudInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      const sameFinal =
        invocation.state === 'SUCCEEDED' &&
        invocation.resultDigest === input.resultDigest &&
        invocation.resultMessageId === input.resultMessageId;
      if (sameFinal) {
        draft.assertSourceReplay('WORKER', input.sourceEventId, input.resultDigest);
        return invocation;
      }
      if (isTerminalInvocationState(invocation.state)) {
        throw new CloudJournalError('FINAL_CONFLICT');
      }
      if (!input.executionCapabilityValid) throw new CloudJournalError('STALE_LEASE');
      draft.assertAssignment(invocation, input.workerId, input.lease);
      if (
        draft.messages.some(
          (message) => message.invocationId === invocation.id && message.role === 'ASSISTANT',
        )
      ) {
        throw new CloudJournalError('FINAL_CONFLICT');
      }
      if (draft.messages.some((message) => message.id === input.resultMessageId)) {
        throw new CloudJournalError('FINAL_CONFLICT');
      }
      const replay = draft.appendEvent({
        invocationId: invocation.id,
        source: 'WORKER',
        sourceEventId: input.sourceEventId,
        eventType: 'invocation.succeeded',
        payloadDigest: input.resultDigest,
      });
      if (replay) return invocation;
      invocation.state = transitionInvocation(invocation.state, {
        type: 'SUCCEED',
        finalDurable: true,
      });
      invocation.resultDigest = input.resultDigest;
      invocation.resultMessageId = input.resultMessageId;
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
    reason: string;
  }): CloudInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      const replay = draft.appendEvent({
        invocationId: invocation.id,
        source: 'RECONCILER',
        sourceEventId: input.sourceEventId,
        eventType: 'invocation.uncertain',
        payloadDigest: input.reason,
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

  acknowledgeOutbox(commandId: string): BrokerOutboxRecord {
    return this.atomic((draft) => {
      const command = draft.outbox.find((item) => item.commandId === commandId);
      if (!command) throw new CloudJournalError('OUTBOX_NOT_FOUND');
      command.state = 'ACKED';
      return command;
    });
  }

  snapshot(): CloudJournalSnapshot {
    return {
      conversations: cloneMap(this.conversations),
      invocations: cloneMap(this.invocations),
      messages: this.messages.map((item) => ({ ...item })),
      events: this.events.map((item) => ({ ...item })),
      outbox: this.outbox.map((item) => ({ ...item })),
    };
  }

  private atomic<T>(operation: (draft: CloudDraft) => T): T {
    const draft = new CloudDraft({
      conversations: cloneMap(this.conversations),
      invocations: cloneMap(this.invocations),
      messages: this.messages.map((item) => ({ ...item })),
      events: this.events.map((item) => ({ ...item })),
      outbox: this.outbox.map((item) => ({ ...item })),
      eventBodies: new Map(this.eventBodies),
    });
    const result = operation(draft);
    this.conversations = draft.conversations;
    this.invocations = draft.invocations;
    this.messages = draft.messages;
    this.events = draft.events;
    this.outbox = draft.outbox;
    this.eventBodies.clear();
    for (const [key, value] of draft.eventBodies) this.eventBodies.set(key, value);
    return { ...result } as T;
  }
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

  assertAssignment(invocation: CloudInvocation, workerId: string, lease: LeaseBinding): void {
    if (
      invocation.assignedWorkerId !== workerId ||
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
    const canonicalBody = `${input.invocationId}\0${input.eventType}\0${input.payloadDigest}`;
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

  assertSourceReplay(
    source: CloudInvocationEvent['source'],
    sourceEventId: string,
    digest: string,
  ): void {
    const prefix = `${source}:${sourceEventId}`;
    const known = this.eventBodies.get(prefix);
    if (!known || !known.endsWith(`\0${digest}`)) {
      throw new CloudJournalError('SOURCE_EVENT_CONFLICT');
    }
  }
}

function cloneMap<T extends object>(source: ReadonlyMap<string, T>): Map<string, T> {
  return new Map([...source].map(([key, value]) => [key, { ...value }]));
}
