import type { CreatorHost } from '@cb/creator-agent-protocol/host';
import type {
  WorkerResultSealInput,
  WorkerResultSealOutput,
} from '@cb/creator-agent-broker-journal/host-executor';
import type { WorkerSqliteStoreOptions } from '@cb/creator-agent-broker-journal/sqlite-store';
import type { WorkerTransportStoreOptions } from '@cb/creator-worker-broker-client/sqlite-repository';
import type { WorkerBrokerWebSocketDriverOptions } from '@cb/creator-worker-broker-client/websocket-driver';

import type { WorkerStartInputResolution } from './pump-contract.js';

export type CreatorWorkerRuntimeStorageMode = 'CREATE_FRESH' | 'OPEN_EXISTING';

export type CreatorWorkerRuntimeState =
  | 'IDLE'
  | 'STARTING'
  | 'READY'
  | 'BLOCKED'
  | 'STOPPING'
  | 'STOPPED';

export type CreatorWorkerRuntimeDiagnostic =
  | 'starting'
  | 'host_started'
  | 'scheduler_started'
  | 'broker_ready'
  | 'ready'
  | 'blocked'
  | 'stopping'
  | 'stopped';

export type CreatorWorkerRuntimeErrorCode =
  | 'RUNTIME_CONFIGURATION_INVALID'
  | 'RUNTIME_STORAGE_PATH_CONFLICT'
  | 'RUNTIME_START_FAILED'
  | 'RUNTIME_READY_TIMEOUT'
  | 'RUNTIME_BLOCKED'
  | 'RUNTIME_STOPPED'
  | 'RUNTIME_STOP_INCOMPLETE';

export class CreatorWorkerRuntimeError extends Error {
  public constructor(
    public readonly code: CreatorWorkerRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CreatorWorkerRuntimeError';
  }
}

export type CreatorWorkerBrokerOptions = Omit<
  WorkerBrokerWebSocketDriverOptions,
  'owner' | 'repository'
>;

export type CreatorWorkerRuntimeOptions<TEnvelope extends object> = Readonly<{
  storageMode: CreatorWorkerRuntimeStorageMode;
  journal: WorkerSqliteStoreOptions;
  transport: WorkerTransportStoreOptions;
  broker: CreatorWorkerBrokerOptions;
  host: CreatorHost;
  resolveStartInput: (inputRef: string, signal: AbortSignal) => Promise<WorkerStartInputResolution>;
  sealResult: (input: WorkerResultSealInput) => Promise<WorkerResultSealOutput<TEnvelope>>;
  tickIntervalMs?: number;
  readyTimeoutMs?: number;
  hostLifecycleTimeoutMs?: number;
  diagnosticSink?: (event: CreatorWorkerRuntimeDiagnostic) => void;
}>;

export type CreatorWorkerRuntimeStartResult = Readonly<{
  recoveredInvocations: number;
  preparedInvocations: number;
}>;

export interface CreatorWorkerRuntime {
  readonly status: CreatorWorkerRuntimeState;
  readonly failure: CreatorWorkerRuntimeError | null;
  start(): Promise<CreatorWorkerRuntimeStartResult>;
  stop(): Promise<void>;
}
