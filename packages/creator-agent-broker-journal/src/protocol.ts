export const BROKER_PROTOCOL = 'combo.creator-broker/1' as const;
export const MAX_FENCE = 9_223_372_036_854_775_807n;

const UUIDISH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FENCE_PATTERN = /^(0|[1-9][0-9]{0,18})$/;

export type BrokerMessageKind = 'command' | 'event' | 'ack';
export type BrokerAckLevel = 'RECEIVED' | 'PERSISTED' | 'CLOUD_COMMITTED';

export interface LeaseBinding {
  deploymentId: string;
  leaseId: string;
  fence: string;
}

export interface BrokerEnvelope<TBody = Readonly<Record<string, unknown>>> {
  protocol: typeof BROKER_PROTOCOL;
  schemaVersion: 1;
  kind: BrokerMessageKind;
  messageId: string;
  type: string;
  correlationId: string;
  connectionId: string;
  sequence: number;
  sentAt: string;
  expiresAt: string;
  lease: LeaseBinding;
  body: TBody;
}

export type BrokerProtocolErrorCode =
  | 'INVALID_ENVELOPE'
  | 'INVALID_PROTOCOL'
  | 'UNKNOWN_KEY'
  | 'INVALID_FENCE'
  | 'INVALID_SEQUENCE'
  | 'SEQUENCE_GAP'
  | 'SEQUENCE_CONFLICT'
  | 'STALE_CONNECTION'
  | 'MESSAGE_EXPIRED'
  | 'IDEMPOTENCY_CONFLICT';

export class BrokerProtocolError extends Error {
  constructor(readonly code: BrokerProtocolErrorCode) {
    super(code);
    this.name = 'BrokerProtocolError';
  }
}

const ENVELOPE_KEYS = new Set([
  'protocol',
  'schemaVersion',
  'kind',
  'messageId',
  'type',
  'correlationId',
  'connectionId',
  'sequence',
  'sentAt',
  'expiresAt',
  'lease',
  'body',
]);
const LEASE_KEYS = new Set(['deploymentId', 'leaseId', 'fence']);

export function parseFence(value: unknown): bigint {
  if (typeof value !== 'string' || !FENCE_PATTERN.test(value)) {
    throw new BrokerProtocolError('INVALID_FENCE');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_FENCE) throw new BrokerProtocolError('INVALID_FENCE');
  return parsed;
}

export function formatFence(value: bigint): string {
  if (value < 0n || value > MAX_FENCE) throw new BrokerProtocolError('INVALID_FENCE');
  return value.toString(10);
}

export function parseBrokerEnvelope(input: unknown): BrokerEnvelope {
  const value = requireObject(input);
  rejectUnknownKeys(value, ENVELOPE_KEYS);
  if (value.protocol !== BROKER_PROTOCOL || value.schemaVersion !== 1) {
    throw new BrokerProtocolError('INVALID_PROTOCOL');
  }
  if (value.kind !== 'command' && value.kind !== 'event' && value.kind !== 'ack') {
    throw new BrokerProtocolError('INVALID_ENVELOPE');
  }
  const messageId = requireIdentifier(value.messageId);
  const type = requireIdentifier(value.type);
  const correlationId = requireIdentifier(value.correlationId);
  const connectionId = requireIdentifier(value.connectionId);
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) {
    throw new BrokerProtocolError('INVALID_SEQUENCE');
  }
  const sequence = value.sequence as number;
  const sentAt = requireInstant(value.sentAt);
  const expiresAt = requireInstant(value.expiresAt);
  const leaseValue = requireObject(value.lease);
  rejectUnknownKeys(leaseValue, LEASE_KEYS);
  const lease: LeaseBinding = {
    deploymentId: requireIdentifier(leaseValue.deploymentId),
    leaseId: requireIdentifier(leaseValue.leaseId),
    fence: formatFence(parseFence(leaseValue.fence)),
  };
  const body = requireObject(value.body);
  return {
    protocol: BROKER_PROTOCOL,
    schemaVersion: 1,
    kind: value.kind,
    messageId,
    type,
    correlationId,
    connectionId,
    sequence,
    sentAt,
    expiresAt,
    lease,
    body,
  };
}

export interface SequenceCursor {
  readonly connectionId: string;
  readonly nextExpected: number;
  readonly accepted: ReadonlyMap<number, string>;
}

export interface BrokerAckRecord {
  readonly messageId: string;
  readonly canonicalDigest: string;
  readonly level: BrokerAckLevel;
}

const ACK_RANK: Readonly<Record<BrokerAckLevel, number>> = {
  RECEIVED: 0,
  PERSISTED: 1,
  CLOUD_COMMITTED: 2,
};

/**
 * Durable ACK reference reducer. A transport RECEIVED ACK never implies that
 * either Journal committed; higher ACKs may arrive after a lower ACK was lost.
 */
export class BrokerAckLedger {
  private readonly records = new Map<string, BrokerAckRecord>();

  acknowledge(input: BrokerAckRecord): BrokerAckRecord {
    const existing = this.records.get(input.messageId);
    if (existing) {
      if (existing.canonicalDigest !== input.canonicalDigest) {
        throw new BrokerProtocolError('IDEMPOTENCY_CONFLICT');
      }
      if (ACK_RANK[input.level] <= ACK_RANK[existing.level]) return { ...existing };
    }
    const accepted = { ...input };
    this.records.set(input.messageId, accepted);
    return accepted;
  }

  get(messageId: string): BrokerAckRecord | undefined {
    const record = this.records.get(messageId);
    return record ? { ...record } : undefined;
  }
}

export type SequenceDecision =
  | { type: 'ACCEPT'; cursor: SequenceCursor }
  | { type: 'REPLAY'; cursor: SequenceCursor }
  | { type: 'REQUEST_REPLAY'; expected: number; received: number; cursor: SequenceCursor };

export function initialSequenceCursor(connectionId: string): SequenceCursor {
  return { connectionId: requireIdentifier(connectionId), nextExpected: 0, accepted: new Map() };
}

export function consumeSequence(
  cursor: SequenceCursor,
  envelope: BrokerEnvelope,
  canonicalDigest: string,
  nowMs: number,
): SequenceDecision {
  if (envelope.connectionId !== cursor.connectionId) {
    throw new BrokerProtocolError('STALE_CONNECTION');
  }
  if (Date.parse(envelope.expiresAt) <= nowMs) {
    throw new BrokerProtocolError('MESSAGE_EXPIRED');
  }
  const existing = cursor.accepted.get(envelope.sequence);
  if (existing !== undefined) {
    if (existing !== canonicalDigest) throw new BrokerProtocolError('SEQUENCE_CONFLICT');
    return { type: 'REPLAY', cursor };
  }
  if (envelope.sequence < cursor.nextExpected) {
    throw new BrokerProtocolError('INVALID_SEQUENCE');
  }
  if (envelope.sequence > cursor.nextExpected) {
    return {
      type: 'REQUEST_REPLAY',
      expected: cursor.nextExpected,
      received: envelope.sequence,
      cursor,
    };
  }
  const accepted = new Map(cursor.accepted);
  accepted.set(envelope.sequence, canonicalDigest);
  return {
    type: 'ACCEPT',
    cursor: {
      connectionId: cursor.connectionId,
      nextExpected: cursor.nextExpected + 1,
      accepted,
    },
  };
}

export interface WorkerLease {
  readonly leaseId: string;
  readonly deploymentId: string;
  readonly workerId: string;
  readonly connectionId: string;
  readonly fence: bigint;
  readonly expiresAtMs: number;
  readonly state: 'ACTIVE' | 'EXPIRED' | 'RELEASED' | 'REVOKED';
}

export type LeaseErrorCode = 'ACTIVE_LEASE_EXISTS' | 'STALE_LEASE' | 'STALE_FENCE';

export class LeaseError extends Error {
  constructor(readonly code: LeaseErrorCode) {
    super(code);
    this.name = 'LeaseError';
  }
}

export class LeaseRegistry {
  private readonly leases = new Map<string, WorkerLease>();
  private readonly nextFences = new Map<string, bigint>();

  acquire(input: {
    leaseId: string;
    deploymentId: string;
    workerId: string;
    connectionId: string;
    nowMs: number;
    ttlMs: number;
  }): WorkerLease {
    const current = this.leases.get(input.deploymentId);
    if (current && current.state === 'ACTIVE' && current.expiresAtMs > input.nowMs) {
      throw new LeaseError('ACTIVE_LEASE_EXISTS');
    }
    if (current?.state === 'ACTIVE') {
      this.leases.set(input.deploymentId, { ...current, state: 'EXPIRED' });
    }
    const fence = this.nextFences.get(input.deploymentId) ?? 0n;
    if (fence > MAX_FENCE) throw new LeaseError('STALE_FENCE');
    const lease: WorkerLease = {
      leaseId: requireIdentifier(input.leaseId),
      deploymentId: requireIdentifier(input.deploymentId),
      workerId: requireIdentifier(input.workerId),
      connectionId: requireIdentifier(input.connectionId),
      fence,
      expiresAtMs: input.nowMs + input.ttlMs,
      state: 'ACTIVE',
    };
    this.nextFences.set(input.deploymentId, fence + 1n);
    this.leases.set(input.deploymentId, lease);
    return lease;
  }

  renew(binding: LeaseBinding, connectionId: string, nowMs: number, ttlMs: number): WorkerLease {
    const current = this.assertCurrent(binding, connectionId, nowMs);
    const renewed = { ...current, expiresAtMs: nowMs + ttlMs };
    this.leases.set(current.deploymentId, renewed);
    return renewed;
  }

  assertCurrent(binding: LeaseBinding, connectionId: string, nowMs: number): WorkerLease {
    const current = this.leases.get(binding.deploymentId);
    if (
      !current ||
      current.state !== 'ACTIVE' ||
      current.leaseId !== binding.leaseId ||
      current.connectionId !== connectionId ||
      current.expiresAtMs <= nowMs
    ) {
      throw new LeaseError('STALE_LEASE');
    }
    if (current.fence !== parseFence(binding.fence)) throw new LeaseError('STALE_FENCE');
    return current;
  }

  release(binding: LeaseBinding, connectionId: string, nowMs: number): WorkerLease {
    const current = this.assertCurrent(binding, connectionId, nowMs);
    const released = { ...current, state: 'RELEASED' as const };
    this.leases.set(current.deploymentId, released);
    return released;
  }

  current(deploymentId: string): WorkerLease | undefined {
    return this.leases.get(deploymentId);
  }
}

function requireObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BrokerProtocolError('INVALID_ENVELOPE');
  }
  return input as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new BrokerProtocolError('UNKNOWN_KEY');
  }
}

function requireIdentifier(input: unknown): string {
  if (typeof input !== 'string' || !UUIDISH_PATTERN.test(input)) {
    throw new BrokerProtocolError('INVALID_ENVELOPE');
  }
  return input;
}

function requireInstant(input: unknown): string {
  if (typeof input !== 'string' || !Number.isFinite(Date.parse(input))) {
    throw new BrokerProtocolError('INVALID_ENVELOPE');
  }
  return input;
}
