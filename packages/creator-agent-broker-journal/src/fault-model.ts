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
    'interrupt receipt is not implemented',
  ),
  entry(
    'FLT-015_CANCEL_FINAL_RACE',
    'MODEL_ONLY_E1',
    'state reducer only; no real concurrent runtime',
  ),
  entry(
    'FLT-016_LEASE_EXPIRY_OLD_WORKER_FINAL',
    'MODEL_ONLY_E1',
    'signed binding model only; no WSS failover',
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
  private readonly codexTurns = new Set<string>();
  private readonly providerRequests = new Map<string, string>();
  private readonly consumerFinals = new Map<string, string>();

  recordCodexTurnStart(invocationId: string): void {
    this.codexTurns.add(invocationId);
  }

  recordProviderRequest(providerRequestId: string, requestDigest: string): void {
    const known = this.providerRequests.get(providerRequestId);
    if (known !== undefined && known !== requestDigest) throw new Error('PROVIDER_REPLAY_CONFLICT');
    this.providerRequests.set(providerRequestId, requestDigest);
  }

  recordConsumerFinal(invocationId: string, resultDigest: string): void {
    const known = this.consumerFinals.get(invocationId);
    if (known !== undefined && known !== resultDigest) throw new Error('CONSUMER_FINAL_CONFLICT');
    this.consumerFinals.set(invocationId, resultDigest);
  }

  snapshot(): FaultObservation {
    return {
      codexTurnStartCount: this.codexTurns.size,
      providerUpstreamRequestCount: this.providerRequests.size,
      consumerVisibleFinalCount: this.consumerFinals.size,
    };
  }

  serialize(): string {
    return JSON.stringify({
      schemaVersion: 1,
      codexTurns: [...this.codexTurns],
      providerRequests: [...this.providerRequests],
      consumerFinals: [...this.consumerFinals],
    });
  }

  static restore(serialized: string): RecordingFaultPort {
    const parsed = JSON.parse(serialized) as {
      schemaVersion: number;
      codexTurns: string[];
      providerRequests: Array<[string, string]>;
      consumerFinals: Array<[string, string]>;
    };
    if (parsed.schemaVersion !== 1) throw new Error('INVALID_RECORDING_PORT');
    const port = new RecordingFaultPort();
    for (const invocationId of parsed.codexTurns) port.recordCodexTurnStart(invocationId);
    for (const [requestId, digest] of parsed.providerRequests) {
      port.recordProviderRequest(requestId, digest);
    }
    for (const [invocationId, digest] of parsed.consumerFinals) {
      port.recordConsumerFinal(invocationId, digest);
    }
    return port;
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
