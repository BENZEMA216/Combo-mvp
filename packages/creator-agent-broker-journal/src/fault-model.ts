import { InMemoryCloudJournal } from './cloud-journal.js';
import { ExecutionCapabilityUseJournal } from './capability-authority.js';
import {
  AGENT_VERSION_DIGEST,
  IDS,
  NOW_MS,
  REQUEST_DIGEST,
  createLeaseAuthority,
  createSignedCapabilityFixture,
} from './reference-fixture.js';
import { LeaseRegistry, type LeaseBinding } from './protocol.js';
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
export type FaultEvidence = 'SIMULATED_RECOVERY_E1' | 'MODEL_ONLY_E1' | 'BLOCKED_E2_E6';

export interface FaultCoverageEntry {
  readonly point: FaultPoint;
  readonly evidence: FaultEvidence;
  readonly reason: string;
}

export const FAULT_COVERAGE: readonly FaultCoverageEntry[] = [
  entry(
    'FLT-001_API_BEFORE_TRANSACTION',
    'SIMULATED_RECOVERY_E1',
    'empty cloud transaction replay',
  ),
  entry(
    'FLT-002_AFTER_COMMIT_BEFORE_HTTP_202',
    'SIMULATED_RECOVERY_E1',
    'cloud serialization and exact HTTP replay',
  ),
  entry(
    'FLT-003_OUTBOX_COMMIT_BEFORE_SEND',
    'SIMULATED_RECOVERY_E1',
    'durable cloud outbox reconstruction',
  ),
  entry(
    'FLT-004_WORKER_RECEIVE_BEFORE_SQLITE_COMMIT',
    'SIMULATED_RECOVERY_E1',
    'empty worker journal reconstruction',
  ),
  entry(
    'FLT-005_PREPARED_COMMIT_BEFORE_ACK',
    'SIMULATED_RECOVERY_E1',
    'worker prepared row and outbox reconstruction',
  ),
  entry(
    'FLT-006_CLOUD_PERSISTED_BEFORE_START_SEND',
    'SIMULATED_RECOVERY_E1',
    'cloud persisted state reconstruction',
  ),
  entry(
    'FLT-007_STARTING_COMMIT_BEFORE_HOST_CALL',
    'MODEL_ONLY_E1',
    'requires independent Host dispatch receipt in production',
  ),
  entry(
    'FLT-008_HOST_ACCEPTED_BEFORE_TURN_ID',
    'MODEL_ONLY_E1',
    'unknown Host receipt reduces to UNCERTAIN',
  ),
  entry(
    'FLT-009_TURN_ID_SAVED_BEFORE_STARTED_EVENT',
    'SIMULATED_RECOVERY_E1',
    'worker running outbox reconstruction without another Host call',
  ),
  entry(
    'FLT-010_RUNNING_WORKER_CRASH',
    'MODEL_ONLY_E1',
    'Host queryability is outside this adapter',
  ),
  entry(
    'FLT-011_FINAL_BEFORE_SQLITE_COMMIT',
    'MODEL_ONLY_E1',
    'requires exact Host final recovery evidence',
  ),
  entry(
    'FLT-012_FINAL_COMMIT_BEFORE_CLOUD_SUBMIT',
    'SIMULATED_RECOVERY_E1',
    'local final and outbox reconstruction',
  ),
  entry(
    'FLT-013_CLOUD_TERMINAL_BEFORE_ACK',
    'SIMULATED_RECOVERY_E1',
    'cloud final replay and local ACK convergence',
  ),
  entry(
    'FLT-014_CANCEL_BEFORE_INTERRUPT_ACK',
    'MODEL_ONLY_E1',
    'E1 model has no Host interrupt path; receipt machinery implemented and E3-covered (host-interrupt-terminal, journal interruptOnce, 0029 admission)',
  ),
  entry(
    'FLT-015_CANCEL_FINAL_RACE',
    'MODEL_ONLY_E1',
    'E1 state reducer only; SQLite journal cancel/final race tests cover E3',
  ),
  entry(
    'FLT-016_LEASE_EXPIRY_OLD_WORKER_FINAL',
    'MODEL_ONLY_E1',
    'E1 signed binding model; WSS reconnect/fence covered at E3 vertical',
  ),
  entry('FLT-017_REDIS_LOSS', 'BLOCKED_E2_E6', 'Redis topology is not implemented'),
  entry(
    'FLT-018_GATEWAY_ROLLING_RESTART',
    'BLOCKED_E2_E6',
    'Gateway process topology is not implemented',
  ),
  entry(
    'FLT-019_PROXY_RESPONSE_CONNECTION_DROP',
    'MODEL_ONLY_E1',
    'Provider transport and durable attempt journal are not implemented',
  ),
  entry(
    'FLT-020_VM_CLEANUP_FAILURE',
    'BLOCKED_E2_E6',
    'VM supervisor and cleanup are not implemented',
  ),
];

export const SIMULATED_RECOVERY_FAULT_POINTS = FAULT_COVERAGE.filter(
  (item) => item.evidence === 'SIMULATED_RECOVERY_E1',
).map((item) => item.point);

export interface FaultObservation {
  readonly codexTurnStartCount: number;
  readonly providerUpstreamRequestCount: number;
  readonly consumerVisibleFinalCount: number;
  readonly providerReplayConflictCount: number;
  readonly consumerFinalConflictCount: number;
}

export interface FaultRecordingPort {
  recordCodexTurnStart(invocationId: string): void;
  recordProviderRequest(providerRequestId: string, requestDigest: string): void;
  recordConsumerFinal(invocationId: string, resultDigest: string): void;
  snapshot(): FaultObservation;
  serialize(): string;
}

/** Independent mock side-effect ledger; it is not derived from either Journal. */
export class RecordingFaultPort implements FaultRecordingPort {
  private readonly codexTurnAttempts: string[] = [];
  private readonly providerRequestAttempts: Array<readonly [string, string]> = [];
  private readonly consumerFinalAttempts: Array<readonly [string, string]> = [];
  private readonly providerRequestBindings = new Map<string, string>();
  private readonly consumerFinalBindings = new Map<string, string>();
  private providerReplayConflictCount = 0;
  private consumerFinalConflictCount = 0;

  constructor(private readonly maxAttemptsPerKind = 100_000) {
    if (!Number.isSafeInteger(maxAttemptsPerKind) || maxAttemptsPerKind < 1) {
      throw new Error('INVALID_RECORDING_PORT');
    }
  }

  recordCodexTurnStart(invocationId: string): void {
    requireFaultToken(invocationId);
    this.assertCapacity(this.codexTurnAttempts.length);
    this.codexTurnAttempts.push(invocationId);
  }

  recordProviderRequest(providerRequestId: string, requestDigest: string): void {
    requireFaultToken(providerRequestId);
    requireFaultToken(requestDigest);
    this.assertCapacity(this.providerRequestAttempts.length);
    this.providerRequestAttempts.push([providerRequestId, requestDigest]);
    const known = this.providerRequestBindings.get(providerRequestId);
    if (known !== undefined && known !== requestDigest) {
      this.providerReplayConflictCount += 1;
      throw new Error('PROVIDER_REPLAY_CONFLICT');
    }
    this.providerRequestBindings.set(providerRequestId, requestDigest);
  }

  recordConsumerFinal(invocationId: string, resultDigest: string): void {
    requireFaultToken(invocationId);
    requireFaultToken(resultDigest);
    this.assertCapacity(this.consumerFinalAttempts.length);
    this.consumerFinalAttempts.push([invocationId, resultDigest]);
    const known = this.consumerFinalBindings.get(invocationId);
    if (known !== undefined && known !== resultDigest) {
      this.consumerFinalConflictCount += 1;
      throw new Error('CONSUMER_FINAL_CONFLICT');
    }
    this.consumerFinalBindings.set(invocationId, resultDigest);
  }

  snapshot(): FaultObservation {
    return {
      codexTurnStartCount: this.codexTurnAttempts.length,
      providerUpstreamRequestCount: this.providerRequestAttempts.length,
      consumerVisibleFinalCount: this.consumerFinalAttempts.length,
      providerReplayConflictCount: this.providerReplayConflictCount,
      consumerFinalConflictCount: this.consumerFinalConflictCount,
    };
  }

  serialize(): string {
    return JSON.stringify({
      schemaVersion: 2,
      codexTurnAttempts: this.codexTurnAttempts,
      providerRequestAttempts: this.providerRequestAttempts,
      consumerFinalAttempts: this.consumerFinalAttempts,
    });
  }

  static restore(serialized: string, maxAttemptsPerKind = 100_000): RecordingFaultPort {
    const parsed = JSON.parse(serialized) as {
      schemaVersion: number;
      codexTurnAttempts: string[];
      providerRequestAttempts: Array<[string, string]>;
      consumerFinalAttempts: Array<[string, string]>;
    };
    if (
      parsed.schemaVersion !== 2 ||
      !Array.isArray(parsed.codexTurnAttempts) ||
      !Array.isArray(parsed.providerRequestAttempts) ||
      !Array.isArray(parsed.consumerFinalAttempts) ||
      parsed.codexTurnAttempts.length > maxAttemptsPerKind ||
      parsed.providerRequestAttempts.length > maxAttemptsPerKind ||
      parsed.consumerFinalAttempts.length > maxAttemptsPerKind
    ) {
      throw new Error('INVALID_RECORDING_PORT');
    }
    const port = new RecordingFaultPort(maxAttemptsPerKind);
    for (const invocationId of parsed.codexTurnAttempts) {
      port.recordCodexTurnStart(invocationId);
    }
    for (const attempt of parsed.providerRequestAttempts) {
      if (!Array.isArray(attempt) || attempt.length !== 2) {
        throw new Error('INVALID_RECORDING_PORT');
      }
      try {
        port.recordProviderRequest(attempt[0], attempt[1]);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'PROVIDER_REPLAY_CONFLICT') throw error;
      }
    }
    for (const attempt of parsed.consumerFinalAttempts) {
      if (!Array.isArray(attempt) || attempt.length !== 2) {
        throw new Error('INVALID_RECORDING_PORT');
      }
      try {
        port.recordConsumerFinal(attempt[0], attempt[1]);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'CONSUMER_FINAL_CONFLICT') throw error;
      }
    }
    return port;
  }

  private assertCapacity(currentSize: number): void {
    if (currentSize >= this.maxAttemptsPerKind) throw new Error('RECORDING_PORT_CAPACITY');
  }
}

function requireFaultToken(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new Error('INVALID_RECORDING_PORT');
  }
}

export interface SimulatedRecoveryResult extends FaultObservation {
  readonly point: FaultPoint;
  readonly evidence: 'SIMULATED_RECOVERY_E1';
  readonly reconstructionCount: number;
  readonly cloudState: string;
  readonly workerState: string;
  readonly cloudAssistantMessageCount: number;
  readonly automaticRetryAfterUnknown: false;
}

/**
 * Executes only the nine failpoints for which this in-memory adapter can
 * genuinely serialize, discard and reconstruct durable state. Transport,
 * PostgreSQL, SQLite fsync, process kill and VM recovery remain unproven.
 */
export function runSimulatedRecoveryScenario(point: FaultPoint): SimulatedRecoveryResult {
  if (!SIMULATED_RECOVERY_FAULT_POINTS.includes(point)) {
    throw new Error(`FAULT_POINT_NOT_SIMULATED:${point}`);
  }
  const signed = createSignedCapabilityFixture();
  let { registry: leases, lease } = createLeaseAuthority();
  let cloud = new InMemoryCloudJournal(leases, signed.authority);
  let worker = new InMemoryWorkerJournal(signed.authority);
  let recording = new RecordingFaultPort();
  let capabilityUses = new ExecutionCapabilityUseJournal();
  let reconstructionCount = 0;

  cloud.createConversation({ id: IDS.conversationA, agentVersionId: IDS.agentVersion });

  const reconstruct = (options: { cloud?: boolean; worker?: boolean } = {}): void => {
    const leaseBytes = leases.serialize();
    const cloudBytes = cloud.serialize();
    const workerBytes = worker.serialize();
    const recordingBytes = recording.serialize();
    const capabilityUseBytes = capabilityUses.serialize();
    leases = LeaseRegistry.restore(leaseBytes);
    lease = leaseBindingFrom(leases);
    if (options.cloud !== false) {
      cloud = InMemoryCloudJournal.restore(cloudBytes, leases, signed.authority);
    }
    if (options.worker !== false) {
      worker = InMemoryWorkerJournal.restore(workerBytes, signed.authority);
    }
    recording = RecordingFaultPort.restore(recordingBytes);
    capabilityUses = ExecutionCapabilityUseJournal.restore(capabilityUseBytes);
    reconstructionCount += 1;
  };

  if (point === 'FLT-001_API_BEFORE_TRANSACTION') reconstruct({ worker: false });
  const accepted = cloud.acceptInvocation(acceptInput(signed, lease));
  if (point === 'FLT-002_AFTER_COMMIT_BEFORE_HTTP_202') {
    reconstruct({ worker: false });
    const replay = cloud.acceptInvocation(acceptInput(signed, lease));
    if (replay.id !== accepted.id) throw new Error('SECOND_INVOCATION');
  }
  if (point === 'FLT-003_OUTBOX_COMMIT_BEFORE_SEND') reconstruct({ worker: false });

  cloud.markDispatchPending({
    invocationId: IDS.invocationA,
    workerInstallationId: IDS.worker,
    lease,
    sourceEventId: 'broker-dispatch',
    nowMs: NOW_MS + 1,
  });

  if (point === 'FLT-004_WORKER_RECEIVE_BEFORE_SQLITE_COMMIT') {
    const emptyWorkerBytes = worker.serialize();
    worker = InMemoryWorkerJournal.restore(emptyWorkerBytes, signed.authority);
    reconstructionCount += 1;
  }
  const prepared = worker.prepare(prepareInput(signed, lease));
  if (point === 'FLT-005_PREPARED_COMMIT_BEFORE_ACK') {
    reconstruct({ cloud: false });
    const replay = worker.prepare(prepareInput(signed, lease));
    if (replay.invocationId !== prepared.invocationId) throw new Error('SECOND_PREPARE');
  }
  acknowledgeCommand(cloud, lease, 'prepare-command');
  cloud.recordWorkerPersisted({
    invocationId: IDS.invocationA,
    workerInstallationId: IDS.worker,
    lease,
    sourceEventId: 'worker-prepared',
    payloadDigest: REQUEST_DIGEST,
  });
  if (point === 'FLT-006_CLOUD_PERSISTED_BEFORE_START_SEND') reconstruct();

  cloud.requestStart({
    invocationId: IDS.invocationA,
    workerInstallationId: IDS.worker,
    lease,
    sourceEventId: 'broker-start',
    commandId: 'start-command',
    executionCapability: signed.capability,
    expectedExecutionCapability: signed.expected,
    nowMs: NOW_MS + 2,
  });
  acknowledgeCommand(cloud, lease, 'start-command');
  worker.start({
    invocationId: IDS.invocationA,
    requestDigest: REQUEST_DIGEST,
    workerInstallationId: IDS.worker,
    lease,
    commandId: 'start-command',
    executionCapability: signed.capability,
    expectedExecutionCapability: signed.expected,
    nowMs: NOW_MS + 2,
  });
  recording.recordCodexTurnStart(IDS.invocationA);
  const useDecision = capabilityUses.authorize(signed.capability);
  if (useDecision.action !== 'DISPATCH_ONCE') throw new Error('CAPABILITY_NOT_FIRST_USE');
  recording.recordProviderRequest(IDS.providerRequest, REQUEST_DIGEST);
  worker.confirmHostDispatch({
    invocationId: IDS.invocationA,
    requestDigest: REQUEST_DIGEST,
    runtimeTurnId: 'turn-a',
    sourceEventId: 'worker-started',
    nowMs: NOW_MS + 3,
  });
  if (point === 'FLT-009_TURN_ID_SAVED_BEFORE_STARTED_EVENT') reconstruct();
  cloud.recordRunning({
    invocationId: IDS.invocationA,
    workerInstallationId: IDS.worker,
    lease,
    sourceEventId: 'worker-started',
    payloadDigest: 'turn-a',
  });

  worker.writeFinal({
    invocationId: IDS.invocationA,
    requestDigest: REQUEST_DIGEST,
    resultDigest: 'result-digest',
    sourceEventId: 'worker-final',
    nowMs: NOW_MS + 4,
  });
  capabilityUses.markDurableResult(signed.capability, `hmac-sha256:${'3'.repeat(64)}`);
  if (point === 'FLT-012_FINAL_COMMIT_BEFORE_CLOUD_SUBMIT') reconstruct();
  const finalInput = {
    invocationId: IDS.invocationA,
    workerInstallationId: IDS.worker,
    lease,
    sourceEventId: 'worker-final',
    resultMessageId: IDS.resultMessage,
    resultDigest: 'result-digest',
    executionCapability: signed.capability,
    expectedExecutionCapability: signed.expected,
    nowMs: NOW_MS + 5,
  } as const;
  cloud.commitFinal(finalInput);
  if (point === 'FLT-013_CLOUD_TERMINAL_BEFORE_ACK') {
    reconstruct();
    cloud.commitFinal({ ...finalInput, lease, nowMs: NOW_MS + 6 });
  }
  recording.recordConsumerFinal(IDS.invocationA, 'result-digest');
  worker.markCloudCommitted(IDS.invocationA, 'worker-final');

  const cloudSnapshot = cloud.snapshot();
  const workerSnapshot = worker.snapshot();
  const observation = recording.snapshot();
  return {
    point,
    evidence: 'SIMULATED_RECOVERY_E1',
    reconstructionCount,
    cloudState: cloudSnapshot.invocations.get(IDS.invocationA)?.state ?? 'MISSING',
    workerState: workerSnapshot.invocations.get(IDS.invocationA)?.state ?? 'MISSING',
    cloudAssistantMessageCount: cloudSnapshot.messages.filter(
      (message) => message.invocationId === IDS.invocationA && message.role === 'ASSISTANT',
    ).length,
    ...observation,
    automaticRetryAfterUnknown: false,
  };
}

function entry(point: FaultPoint, evidence: FaultEvidence, reason: string): FaultCoverageEntry {
  return { point, evidence, reason };
}

function leaseBindingFrom(registry: LeaseRegistry): LeaseBinding {
  const lease = registry.current(IDS.deployment);
  if (!lease) throw new Error('LEASE_LOST');
  return {
    deploymentId: lease.deploymentId,
    leaseId: lease.leaseId,
    workerSessionId: lease.workerSessionId,
    fence: lease.fence.toString(10),
  };
}

function acceptInput(
  signed: ReturnType<typeof createSignedCapabilityFixture>,
  lease: LeaseBinding,
) {
  return {
    invocationId: IDS.invocationA,
    userMessageId: IDS.userMessage,
    conversationId: IDS.conversationA,
    clientMessageId: 'client-message-a',
    requestDigest: REQUEST_DIGEST,
    contentDigest: 'content-digest',
    agentVersionDigest: AGENT_VERSION_DIGEST,
    providerRequestId: IDS.providerRequest,
    workerInstallationId: IDS.worker,
    lease,
    executionCapability: signed.capability,
    expectedExecutionCapability: signed.expected,
    nowMs: NOW_MS,
    prepareCommandId: 'prepare-command',
    sourceEventId: 'api-accepted',
  };
}

function prepareInput(
  signed: ReturnType<typeof createSignedCapabilityFixture>,
  lease: LeaseBinding,
) {
  return {
    invocationId: IDS.invocationA,
    conversationId: IDS.conversationA,
    clientMessageId: 'client-message-a',
    requestDigest: REQUEST_DIGEST,
    agentVersionId: IDS.agentVersion,
    agentVersionDigest: AGENT_VERSION_DIGEST,
    providerRequestId: IDS.providerRequest,
    workerInstallationId: IDS.worker,
    lease,
    executionCapability: signed.capability,
    expectedExecutionCapability: signed.expected,
    nowMs: NOW_MS,
    commandId: 'prepare-command',
    sourceEventId: 'worker-prepared',
  };
}

function acknowledgeCommand(
  cloud: InMemoryCloudJournal,
  lease: LeaseBinding,
  commandId: string,
): void {
  const common = {
    commandId,
    invocationId: IDS.invocationA,
    workerInstallationId: IDS.worker,
    lease,
    canonicalDigest: REQUEST_DIGEST,
  } as const;
  cloud.acknowledgeOutbox({ ...common, level: 'RECEIVED' });
  cloud.acknowledgeOutbox({
    ...common,
    level: 'PERSISTED',
    durableProof: {
      journal: 'WORKER_SQLITE',
      transactionId: `sqlite-${commandId}`,
      canonicalDigest: REQUEST_DIGEST,
    },
  });
}
