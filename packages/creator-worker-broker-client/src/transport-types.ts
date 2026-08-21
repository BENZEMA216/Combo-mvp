import type {
  BrokerTransportFrameMaterialization,
  BrokerTransportPayload,
} from '@cb/creator-agent-protocol/broker-transport';

declare const ownerBrand: unique symbol;
declare const cursorBrand: unique symbol;
declare const sendableBrand: unique symbol;

export type WorkerTransportRepositoryErrorCode =
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
  | 'LEASE_STALE'
  | 'LEASE_EXPIRED'
  | 'SEQUENCE_GAP'
  | 'SEQUENCE_CONFLICT'
  | 'MESSAGE_CONFLICT'
  | 'DELIVERY_UNKNOWN'
  | 'DELIVERY_STATE_INVALID';

export class WorkerTransportRepositoryError extends Error {
  public constructor(
    public readonly code: WorkerTransportRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkerTransportRepositoryError';
  }
}

export type WorkerTransportOwner = Readonly<{
  storeIdentity: string;
  epoch: number;
  readonly [ownerBrand]: never;
}>;

export type WorkerTransportConnectionCursor = Readonly<{
  connectionId: string;
  installationId: string;
  deploymentId: string;
  workerSessionId: string;
  leaseId: string;
  fence: number;
  readonly [cursorBrand]: never;
}>;

/** Process-local proof that the exact wire attempt is durable and its connection is still live. */
export type WorkerTransportSendable = Readonly<{
  messageId: string;
  connectionId: string;
  sequence: number;
  wireFingerprint: string;
  readonly [sendableBrand]: never;
}>;

export type WorkerTransportWireState = 'PENDING' | 'PREPARED' | 'WRITTEN' | 'ACKED' | 'ABANDONED';

export type WorkerTransportDelivery = Readonly<{
  deliveryMessageId: string;
  sourceId: string;
  sourceFingerprint: string;
  semanticFingerprint: string;
  bodyType: 'worker.message' | 'message.ack';
  state: 'PENDING' | 'ACKED';
  activeWire: Readonly<{
    connectionId: string;
    sequence: number;
    wireFingerprint: string;
    state: WorkerTransportWireState;
  }> | null;
}>;

export type WorkerTransportCommandReference = Readonly<{
  deliveryMessageId: string;
  sourceId: string;
  sourceFingerprint: string;
  commandType: string;
  state: 'PENDING' | 'APPLIED';
}>;

export type WorkerTransportInboundResult = Readonly<{
  disposition: 'APPLIED' | 'EXACT_REPLAY';
  command: WorkerTransportCommandReference | null;
  acknowledgement: WorkerTransportDelivery | null;
}>;

export type WorkerTransportRepositoryOptions = Readonly<{
  filename: string;
  storeIdentity: string;
  installationId: string;
  busyTimeoutMs?: number;
}>;

export type WorkerMessageEnqueueInput = Readonly<{
  deliveryMessageId: string;
  messageType: string;
  sourceId: string;
  sourceFingerprint: string;
  payload: BrokerTransportPayload;
}>;

export interface WorkerDurableTransportRepository {
  acquireOwner(options?: Readonly<{ leaseMs?: number }>): WorkerTransportOwner;
  renewOwner(owner: WorkerTransportOwner, leaseMs?: number): WorkerTransportOwner;
  activateLease(
    owner: WorkerTransportOwner,
    grant: BrokerTransportFrameMaterialization,
  ): WorkerTransportConnectionCursor;
  commitInbound(
    owner: WorkerTransportOwner,
    cursor: WorkerTransportConnectionCursor,
    incoming: BrokerTransportFrameMaterialization,
  ): WorkerTransportInboundResult;
  enqueueWorkerMessage(
    owner: WorkerTransportOwner,
    input: WorkerMessageEnqueueInput,
  ): WorkerTransportDelivery;
  prepareSendable(
    owner: WorkerTransportOwner,
    cursor: WorkerTransportConnectionCursor,
    limit?: number,
  ): readonly WorkerTransportSendable[];
  markWireWritten(
    owner: WorkerTransportOwner,
    cursor: WorkerTransportConnectionCursor,
    sendable: WorkerTransportSendable,
  ): WorkerTransportDelivery;
  readPendingCommands(owner: WorkerTransportOwner): readonly WorkerTransportCommandReference[];
  readCommandPayload(
    owner: WorkerTransportOwner,
    deliveryMessageId: string,
  ): BrokerTransportPayload;
  markCommandApplied(
    owner: WorkerTransportOwner,
    deliveryMessageId: string,
  ): WorkerTransportCommandReference;
  readDelivery(
    owner: WorkerTransportOwner,
    deliveryMessageId: string,
  ): WorkerTransportDelivery | null;
  releaseConnection(owner: WorkerTransportOwner, cursor: WorkerTransportConnectionCursor): void;
  close(owner?: WorkerTransportOwner): void;
}

export const workerTransportRepositoryTestHooks = Symbol('workerTransportRepositoryTestHooks');
export type WorkerTransportRepositoryTestHooks = Readonly<{
  now?: () => number;
  fault?: (point: 'BEFORE_COMMIT' | 'AFTER_COMMIT') => void;
}>;
export type WorkerTransportRepositoryInternalOptions = Readonly<{
  [workerTransportRepositoryTestHooks]?: WorkerTransportRepositoryTestHooks;
}>;
