import type { WorkerCommittedAfterCommitEffect } from './effect-authority.js';
import type { WorkerResultSealAuthority } from './result-seal.js';
import type { WorkerInvocationEvent, WorkerInvocationState } from './worker-invocation.js';

declare const workerSqliteOwnerBrand: unique symbol;
declare const workerSqliteCursorBrand: unique symbol;

export type WorkerSqliteStoreErrorCode =
  | 'STORE_PATH_INVALID'
  | 'STORE_EXISTS'
  | 'STORE_MISSING'
  | 'STORE_FILE_UNSAFE'
  | 'STORE_SCHEMA_MISMATCH'
  | 'STORE_CORRUPT'
  | 'STORE_BUSY'
  | 'STORE_IO'
  | 'STORE_CLOSED'
  | 'STORE_COMMIT_UNKNOWN'
  | 'OWNER_BUSY'
  | 'OWNER_STALE'
  | 'OWNER_EXPIRED'
  | 'CURSOR_STALE'
  | 'OPERATION_CONFLICT'
  | 'INVOCATION_CONFLICT'
  | 'SEALED_RESULT_REQUIRED'
  | 'SEALED_RESULT_INVALID';

export class WorkerSqliteStoreError extends Error {
  public constructor(
    public readonly code: WorkerSqliteStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkerSqliteStoreError';
  }
}

export type WorkerSqliteOwner = Readonly<{
  storeIdentity: string;
  epoch: number;
  readonly [workerSqliteOwnerBrand]: never;
}>;

export type WorkerInvocationCursor = Readonly<{
  invocationId: string;
  revision: number;
  phase: WorkerInvocationState['phase'];
  readonly [workerSqliteCursorBrand]: never;
}>;

export type WorkerDurableInvocationView = Readonly<{
  invocationId: string;
  revision: number;
  phase: WorkerInvocationState['phase'];
  stateFingerprint: string;
  state: unknown;
  sealedResultId: string | null;
}>;

export type WorkerOutboxFactReference = Readonly<{
  factId: string;
  invocationId: string;
  operationId: string;
  factType: 'STARTED' | 'TERMINAL';
  payloadFingerprint: string;
  sealedResultId: string | null;
}>;

export type WorkerSqliteRecoveryRecord = Readonly<{
  invocationId: string;
  fromPhase: 'DISPATCHING' | 'RUNNING';
  toRevision: number;
  terminalFact: WorkerOutboxFactReference;
}>;

export type WorkerSqliteAcquireResult = Readonly<{
  owner: WorkerSqliteOwner;
  recovered: readonly WorkerSqliteRecoveryRecord[];
  prepared: readonly WorkerInvocationCursor[];
}>;

export type WorkerSqliteCommitResult = Readonly<{
  disposition: 'APPLIED' | 'EXACT_REPLAY';
  invocation: WorkerDurableInvocationView;
  cursor: WorkerInvocationCursor | null;
  outboxFacts: readonly WorkerOutboxFactReference[];
  afterCommit: readonly WorkerCommittedAfterCommitEffect[];
}>;

export type WorkerSqliteStoreOptions = Readonly<{
  filename: string;
  storeIdentity: string;
  busyTimeoutMs?: number;
}>;

export interface WorkerSqliteStore {
  acquireOwner(options?: Readonly<{ leaseMs?: number }>): WorkerSqliteAcquireResult;
  renewOwner(owner: WorkerSqliteOwner, leaseMs?: number): WorkerSqliteOwner;
  prepareInvocation(
    owner: WorkerSqliteOwner,
    input: Readonly<{ invocationId: string; operationId: string }>,
  ): WorkerSqliteCommitResult;
  commitInvocationEvent<TEnvelope extends object>(
    owner: WorkerSqliteOwner,
    cursor: WorkerInvocationCursor,
    input: Readonly<{
      operationId: string;
      event: WorkerInvocationEvent;
      resultSealAuthority?: WorkerResultSealAuthority<TEnvelope>;
    }>,
  ): WorkerSqliteCommitResult;
  replayInvocationEvent(
    owner: WorkerSqliteOwner,
    input: Readonly<{
      invocationId: string;
      operationId: string;
      event: WorkerInvocationEvent;
    }>,
  ): WorkerSqliteCommitResult | null;
  readInvocation(
    owner: WorkerSqliteOwner,
    invocationId: string,
  ): WorkerDurableInvocationView | null;
  readPendingFacts(owner: WorkerSqliteOwner): readonly WorkerOutboxFactReference[];
  readSealedEnvelope<TEnvelope extends object>(
    owner: WorkerSqliteOwner,
    sealedResultId: string,
  ): Readonly<TEnvelope>;
  close(owner?: WorkerSqliteOwner): void;
}
