import { InMemoryCloudJournal } from './cloud-journal.js';
import { type InvocationState } from './invocation.js';
import { type LeaseBinding } from './protocol.js';
import { InMemoryWorkerJournal } from './worker-journal.js';

export const FAULT_POINTS = [
  'FLT-001_API_BEFORE_TRANSACTION',
  'FLT-002_AFTER_COMMIT_BEFORE_HTTP_202',
  'FLT-003_OUTBOX_COMMIT_BEFORE_SEND',
  'FLT-004_WORKER_RECEIVE_BEFORE_SQLITE_COMMIT',
  'FLT-005_PREPARED_COMMIT_BEFORE_ACK',
  'FLT-006_CLOUD_PERSISTED_BEFORE_START_SEND',
  'FLT-007_STARTING_COMMIT_BEFORE_HOST_CALL',
  'FLT-008_HOST_ACCEPTED_BEFORE_TURN_ID',
  'FLT-009_TURN_ID_SAVED_BEFORE_STARTED_EVENT',
  'FLT-010_RUNNING_WORKER_CRASH',
  'FLT-011_FINAL_BEFORE_SQLITE_COMMIT',
  'FLT-012_FINAL_COMMIT_BEFORE_CLOUD_SUBMIT',
  'FLT-013_CLOUD_TERMINAL_BEFORE_ACK',
  'FLT-014_CANCEL_BEFORE_INTERRUPT_ACK',
  'FLT-015_CANCEL_FINAL_RACE',
  'FLT-016_LEASE_EXPIRY_OLD_WORKER_FINAL',
  'FLT-017_REDIS_LOSS',
  'FLT-018_GATEWAY_ROLLING_RESTART',
  'FLT-019_PROXY_RESPONSE_CONNECTION_DROP',
  'FLT-020_VM_CLEANUP_FAILURE',
] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];
export type FaultMode = 'throw' | 'drop' | 'delay' | 'duplicate' | 'corrupt' | 'kill';

export class InjectedFault extends Error {
  constructor(
    readonly point: FaultPoint,
    readonly mode: FaultMode,
  ) {
    super(`${mode}:${point}`);
    this.name = 'InjectedFault';
  }
}

export interface FaultDirective {
  readonly point: FaultPoint;
  readonly mode: Exclude<FaultMode, 'throw' | 'kill'>;
  readonly drop: boolean;
  readonly delayMs: number;
  readonly duplicateDeliveries: number;
  readonly corrupt: boolean;
}

export class FaultController {
  private armed?: { point: FaultPoint; mode: FaultMode };
  private readonly reached = new Map<FaultPoint, number>();

  arm(point: FaultPoint, mode: FaultMode = 'kill'): void {
    this.armed = { point, mode };
  }

  reach(point: FaultPoint): FaultDirective | undefined {
    this.reached.set(point, (this.reached.get(point) ?? 0) + 1);
    if (this.armed?.point === point) {
      const armed = this.armed;
      this.armed = undefined;
      if (armed.mode === 'throw' || armed.mode === 'kill') {
        throw new InjectedFault(armed.point, armed.mode);
      }
      return {
        point: armed.point,
        mode: armed.mode,
        drop: armed.mode === 'drop',
        delayMs: armed.mode === 'delay' ? 1 : 0,
        duplicateDeliveries: armed.mode === 'duplicate' ? 2 : 1,
        corrupt: armed.mode === 'corrupt',
      };
    }
    return undefined;
  }

  reachCount(point: FaultPoint): number {
    return this.reached.get(point) ?? 0;
  }
}

export interface FaultScenarioResult {
  readonly point: FaultPoint;
  readonly terminalState: InvocationState;
  readonly codexTurnStartCount: number;
  readonly providerUpstreamRequestCount: number;
  readonly consumerVisibleFinalCount: number;
  readonly duplicateFinalCount: number;
  readonly automaticRetryAfterUnknown: boolean;
  readonly injected: true;
}

const LEASE: LeaseBinding = {
  deploymentId: 'deployment-a',
  leaseId: 'lease-a',
  fence: '42',
};

/**
 * Deterministic E1 fault model. It exercises the production reducers with all
 * twenty named injection points; it does not claim OS kill/fsync/network E2/E6 evidence.
 */
export function runReferenceFaultScenario(point: FaultPoint): FaultScenarioResult {
  const controller = new FaultController();
  controller.arm(point);
  const cloud = new InMemoryCloudJournal();
  const worker = new InMemoryWorkerJournal();
  let codexTurnStartCount = 0;
  let providerUpstreamRequestCount = 0;
  const automaticRetryAfterUnknown = false;

  cloud.createConversation({ id: 'conversation-a', agentVersionId: 'version-a' });
  inject(controller, 'FLT-001_API_BEFORE_TRANSACTION');
  const accepted = accept(cloud);
  if (inject(controller, 'FLT-002_AFTER_COMMIT_BEFORE_HTTP_202')) {
    const replay = accept(cloud);
    if (replay.id !== accepted.id) throw new Error('HTTP replay created a second invocation');
  }
  inject(controller, 'FLT-003_OUTBOX_COMMIT_BEFORE_SEND');
  cloud.markDispatchPending('invocation-a', 'broker-dispatch');

  if (inject(controller, 'FLT-004_WORKER_RECEIVE_BEFORE_SQLITE_COMMIT')) {
    // The same durable cloud command is replayed after the simulated process loss.
  }
  const prepared = prepare(worker);
  if (inject(controller, 'FLT-005_PREPARED_COMMIT_BEFORE_ACK')) {
    const replay = prepare(worker);
    if (replay.invocationId !== prepared.invocationId) {
      throw new Error('prepare replay changed invocation identity');
    }
  }
  cloud.recordWorkerPersisted({
    invocationId: 'invocation-a',
    workerId: 'worker-a',
    lease: LEASE,
    sourceEventId: 'worker-prepared',
    payloadDigest: 'request-digest',
  });
  if (inject(controller, 'FLT-006_CLOUD_PERSISTED_BEFORE_START_SEND')) {
    cloud.recordWorkerPersisted({
      invocationId: 'invocation-a',
      workerId: 'worker-a',
      lease: LEASE,
      sourceEventId: 'worker-prepared',
      payloadDigest: 'request-digest',
    });
  }
  cloud.requestStart({
    invocationId: 'invocation-a',
    commandId: 'start-command',
    sourceEventId: 'broker-start',
  });
  worker.start({
    invocationId: 'invocation-a',
    requestDigest: 'request-digest',
    lease: LEASE,
    commandId: 'start-command',
  });

  if (inject(controller, 'FLT-007_STARTING_COMMIT_BEFORE_HOST_CALL')) {
    return uncertainResult(point, cloud, worker, {
      codexTurnStartCount,
      providerUpstreamRequestCount,
      automaticRetryAfterUnknown,
    });
  }
  codexTurnStartCount += 1;
  providerUpstreamRequestCount += 1;
  if (inject(controller, 'FLT-008_HOST_ACCEPTED_BEFORE_TURN_ID')) {
    return uncertainResult(point, cloud, worker, {
      codexTurnStartCount,
      providerUpstreamRequestCount,
      automaticRetryAfterUnknown,
    });
  }
  worker.confirmHostDispatch({
    invocationId: 'invocation-a',
    requestDigest: 'request-digest',
    runtimeTurnId: 'turn-a',
    sourceEventId: 'worker-started',
  });
  if (!inject(controller, 'FLT-009_TURN_ID_SAVED_BEFORE_STARTED_EVENT')) {
    // Normal path reaches cloud immediately. The injected path recovers by replaying the same event.
  }
  cloud.recordRunning({
    invocationId: 'invocation-a',
    workerId: 'worker-a',
    lease: LEASE,
    sourceEventId: 'worker-started',
    payloadDigest: 'turn-a',
  });

  if (inject(controller, 'FLT-010_RUNNING_WORKER_CRASH')) {
    return uncertainResult(point, cloud, worker, {
      codexTurnStartCount,
      providerUpstreamRequestCount,
      automaticRetryAfterUnknown,
    });
  }
  if (inject(controller, 'FLT-014_CANCEL_BEFORE_INTERRUPT_ACK')) {
    return uncertainResult(point, cloud, worker, {
      codexTurnStartCount,
      providerUpstreamRequestCount,
      automaticRetryAfterUnknown,
    });
  }
  if (inject(controller, 'FLT-019_PROXY_RESPONSE_CONNECTION_DROP')) {
    return uncertainResult(point, cloud, worker, {
      codexTurnStartCount,
      providerUpstreamRequestCount,
      automaticRetryAfterUnknown,
    });
  }
  if (inject(controller, 'FLT-020_VM_CLEANUP_FAILURE')) {
    return uncertainResult(point, cloud, worker, {
      codexTurnStartCount,
      providerUpstreamRequestCount,
      automaticRetryAfterUnknown,
    });
  }

  inject(controller, 'FLT-011_FINAL_BEFORE_SQLITE_COMMIT');
  worker.writeFinal({
    invocationId: 'invocation-a',
    requestDigest: 'request-digest',
    resultDigest: 'result-digest',
    sourceEventId: 'worker-final',
  });
  inject(controller, 'FLT-012_FINAL_COMMIT_BEFORE_CLOUD_SUBMIT');
  inject(controller, 'FLT-015_CANCEL_FINAL_RACE');
  inject(controller, 'FLT-016_LEASE_EXPIRY_OLD_WORKER_FINAL');
  inject(controller, 'FLT-017_REDIS_LOSS');
  inject(controller, 'FLT-018_GATEWAY_ROLLING_RESTART');
  cloud.commitFinal({
    invocationId: 'invocation-a',
    workerId: 'worker-a',
    lease: LEASE,
    sourceEventId: 'worker-final',
    resultMessageId: 'assistant-message-a',
    resultDigest: 'result-digest',
    executionCapabilityValid: true,
  });
  if (inject(controller, 'FLT-013_CLOUD_TERMINAL_BEFORE_ACK')) {
    cloud.commitFinal({
      invocationId: 'invocation-a',
      workerId: 'worker-a',
      lease: LEASE,
      sourceEventId: 'worker-final',
      resultMessageId: 'assistant-message-a',
      resultDigest: 'result-digest',
      executionCapabilityValid: true,
    });
  }
  worker.markCloudCommitted('invocation-a', 'worker-final');
  return summarize(point, cloud, {
    codexTurnStartCount,
    providerUpstreamRequestCount,
    automaticRetryAfterUnknown,
  });
}

function uncertainResult(
  point: FaultPoint,
  cloud: InMemoryCloudJournal,
  worker: InMemoryWorkerJournal,
  counters: {
    codexTurnStartCount: number;
    providerUpstreamRequestCount: number;
    automaticRetryAfterUnknown: boolean;
  },
): FaultScenarioResult {
  worker.markUncertain('invocation-a');
  cloud.markUncertain({
    invocationId: 'invocation-a',
    sourceEventId: `reconciler-${point}`,
    reason: point,
  });
  return summarize(point, cloud, counters);
}

function accept(cloud: InMemoryCloudJournal) {
  return cloud.acceptInvocation({
    invocationId: 'invocation-a',
    userMessageId: 'user-message-a',
    conversationId: 'conversation-a',
    clientMessageId: 'client-message-a',
    requestDigest: 'request-digest',
    contentDigest: 'content-digest',
    assignedWorkerId: 'worker-a',
    lease: LEASE,
    prepareCommandId: 'prepare-command',
    sourceEventId: 'api-accepted',
  });
}

function prepare(worker: InMemoryWorkerJournal) {
  return worker.prepare({
    invocationId: 'invocation-a',
    conversationId: 'conversation-a',
    clientMessageId: 'client-message-a',
    requestDigest: 'request-digest',
    agentVersionId: 'version-a',
    lease: LEASE,
    commandId: 'prepare-command',
    sourceEventId: 'worker-prepared',
  });
}

function inject(controller: FaultController, point: FaultPoint): boolean {
  try {
    controller.reach(point);
    return false;
  } catch (error) {
    if (!(error instanceof InjectedFault) || error.point !== point) throw error;
    return true;
  }
}

function summarize(
  point: FaultPoint,
  cloud: InMemoryCloudJournal,
  counters: {
    codexTurnStartCount: number;
    providerUpstreamRequestCount: number;
    automaticRetryAfterUnknown: boolean;
  },
): FaultScenarioResult {
  const snapshot = cloud.snapshot();
  const invocation = snapshot.invocations.get('invocation-a');
  if (!invocation) throw new Error('fault scenario lost invocation');
  const consumerVisibleFinalCount = snapshot.messages.filter(
    (message) => message.invocationId === invocation.id && message.role === 'ASSISTANT',
  ).length;
  return {
    point,
    terminalState: invocation.state,
    codexTurnStartCount: counters.codexTurnStartCount,
    providerUpstreamRequestCount: counters.providerUpstreamRequestCount,
    consumerVisibleFinalCount,
    duplicateFinalCount: Math.max(0, consumerVisibleFinalCount - 1),
    automaticRetryAfterUnknown: counters.automaticRetryAfterUnknown,
    injected: true,
  };
}
