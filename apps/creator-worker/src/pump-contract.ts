import type { CreatorHost } from '@cb/creator-agent-protocol/host';
import type {
  WorkerResultSealInput,
  WorkerResultSealOutput,
} from '@cb/creator-agent-broker-journal/host-executor';
import type {
  WorkerInvocationCursor,
  WorkerSqliteOwner,
  WorkerSqliteStore,
} from '@cb/creator-agent-broker-journal/sqlite-store';
import type {
  WorkerDurableTransportRepository,
  WorkerTransportOwner,
} from '@cb/creator-worker-broker-client/sqlite-repository';
import type { WorkerBrokerWebSocketDriver } from '@cb/creator-worker-broker-client/websocket-driver';
import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/u);
const fingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const WorkerPrepareCommandPayloadSchema = z
  .object({ invocationId: identifier })
  .strict()
  .readonly();
export type WorkerPrepareCommandPayload = z.infer<typeof WorkerPrepareCommandPayloadSchema>;

export const WorkerStartCommandPayloadSchema = z
  .object({
    invocationId: identifier,
    attemptId: identifier,
    inputRef: identifier,
    inputFingerprint: fingerprint,
  })
  .strict()
  .readonly();
export type WorkerStartCommandPayload = z.infer<typeof WorkerStartCommandPayloadSchema>;

export const WorkerCancelCommandPayloadSchema = z
  .object({
    invocationId: identifier,
    attemptId: identifier,
    attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reason: z.enum(['USER_CANCEL', 'TIMEOUT']),
  })
  .strict()
  .readonly();
export type WorkerCancelCommandPayload = z.infer<typeof WorkerCancelCommandPayloadSchema>;

export type WorkerSerialPumpCommandType =
  | 'invocation.prepare'
  | 'invocation.start'
  | 'invocation.cancel';

export type WorkerStartInputResolution = Readonly<{
  input: unknown;
  inputFingerprint: string;
}>;

export type WorkerSerialPumpState = 'IDLE' | 'TICKING' | 'BLOCKED' | 'STOPPING' | 'STOPPED';

export type WorkerSerialPumpTickResult = Readonly<{
  commandsApplied: number;
  factsEnqueued: number;
  workMayRemain: boolean;
  flush: 'FLUSHED' | 'DEFERRED';
}>;

export type WorkerSerialPumpDiagnostic =
  | 'command_applied'
  | 'fact_enqueued'
  | 'host_start_launched'
  | 'host_interrupt_launched'
  | 'host_outcome_observation_launched'
  | 'host_event_committed'
  | 'blocked'
  | 'stopped';

export type WorkerSerialPumpErrorCode =
  | 'PUMP_BLOCKED'
  | 'PUMP_STOPPED'
  | 'COMMAND_UNSUPPORTED'
  | 'COMMAND_INVALID'
  | 'INVOCATION_NOT_LIVE'
  | 'INVOCATION_PHASE_INVALID'
  | 'START_INPUT_MISMATCH'
  | 'START_INPUT_INVALID'
  | 'START_INPUT_TIMEOUT'
  | 'HOST_EFFECT_INVALID'
  | 'STOP_INCOMPLETE';

export class WorkerSerialPumpError extends Error {
  public constructor(
    public readonly code: WorkerSerialPumpErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkerSerialPumpError';
  }
}

export type WorkerSerialPumpOptions<TEnvelope extends object> = Readonly<{
  journal: WorkerSqliteStore;
  journalOwner: WorkerSqliteOwner;
  preparedInvocations?: readonly WorkerInvocationCursor[];
  transport: WorkerDurableTransportRepository;
  transportOwner: WorkerTransportOwner;
  host: CreatorHost;
  driver: Pick<WorkerBrokerWebSocketDriver, 'flush' | 'status'>;
  resolveStartInput: (inputRef: string, signal: AbortSignal) => Promise<WorkerStartInputResolution>;
  sealResult: (input: WorkerResultSealInput) => Promise<WorkerResultSealOutput<TEnvelope>>;
  startInputTimeoutMs?: number;
  commandBatchLimit?: number;
  factBatchLimit?: number;
  diagnosticSink?: (event: WorkerSerialPumpDiagnostic) => void;
}>;

export interface WorkerSerialPump {
  readonly status: WorkerSerialPumpState;
  tick(): Promise<WorkerSerialPumpTickResult>;
  stop(): Promise<void>;
}
