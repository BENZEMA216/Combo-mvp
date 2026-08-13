import {
  CREATOR_BROKER_PROTOCOL,
  parseBrokerFrame,
  type BrokerEnvelope as AuthoritativeBrokerEnvelope,
} from '@cb/creator-agent-protocol';

export const BROKER_PROTOCOL = CREATOR_BROKER_PROTOCOL;
export const MAX_FENCE = 9_223_372_036_854_775_807n;

const UUIDISH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FENCE_PATTERN = /^(0|[1-9][0-9]{0,18})$/;

export type BrokerAckLevel = 'RECEIVED' | 'PERSISTED' | 'CLOUD_COMMITTED';

export interface LeaseBinding {
  deploymentId: string;
  leaseId: string;
  fence: string;
}

export type BrokerEnvelope = AuthoritativeBrokerEnvelope;

export type BrokerProtocolErrorCode =
  | 'INVALID_ENVELOPE'
  | 'INVALID_PROTOCOL'
  | 'UNKNOWN_KEY'
  | 'INVALID_FENCE'
  | 'INVALID_SEQUENCE'
  | 'SEQUENCE_GAP'
  | 'SEQUENCE_CONFLICT'
  | 'CURSOR_EXPIRED'
  | 'STALE_CONNECTION'
  | 'MESSAGE_EXPIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_ACK_TRANSITION'
  | 'ACK_DURABLE_PROOF_REQUIRED'
  | 'ACK_LEDGER_CAPACITY';

export class BrokerProtocolError extends Error {
  constructor(readonly code: BrokerProtocolErrorCode) {
    super(code);
    this.name = 'BrokerProtocolError';
  }
}

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
  try {
    const frame = typeof input === 'string' ? input : JSON.stringify(input);
    if (frame === undefined) throw new BrokerProtocolError('INVALID_ENVELOPE');
    return parseBrokerFrame(frame);
  } catch {
    throw new BrokerProtocolError('INVALID_ENVELOPE');
  }
}

export interface SequenceCursor {
  readonly connectionId: string;
  readonly nextExpected: bigint;
  readonly lowestRetained: bigint;
  readonly maxRetained: number;
  readonly accepted: ReadonlyMap<string, string>;
}

export interface BrokerAckDurableProof {
  readonly journal: 'WORKER_SQLITE' | 'CLOUD_POSTGRESQL';
  readonly transactionId: string;
  readonly canonicalDigest: string;
}

export interface BrokerAckRecord {
  readonly messageId: string;
  readonly canonicalDigest: string;
  readonly level: BrokerAckLevel;
  readonly durableProof?: BrokerAckDurableProof;
}

const ACK_RANK: Readonly<Record<BrokerAckLevel, number>> = {
  RECEIVED: 0,
  PERSISTED: 1,
  CLOUD_COMMITTED: 2,
};

/**
 * ACK fact reducer. A transport RECEIVED ACK never implies that either Journal
 * committed. A higher durable fact may arrive after a lower ACK was lost, so
 * the reducer accepts monotonic jumps only when the responsible Journal proof
 * is exact; it never manufactures the missing lower fact.
 */
export class BrokerAckLedger {
  private readonly records = new Map<string, BrokerAckRecord>();

  constructor(private readonly maxRecords = 10_000) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
      throw new BrokerProtocolError('ACK_LEDGER_CAPACITY');
    }
  }

  acknowledge(input: BrokerAckRecord): BrokerAckRecord {
    const existing = this.records.get(input.messageId);
    if (existing && existing.canonicalDigest !== input.canonicalDigest) {
      throw new BrokerProtocolError('IDEMPOTENCY_CONFLICT');
    }
    validateAckProof(input);
    if (existing) {
      if (input.level === existing.level) {
        if (canonicalAckProof(input.durableProof) !== canonicalAckProof(existing.durableProof)) {
          throw new BrokerProtocolError('IDEMPOTENCY_CONFLICT');
        }
        return cloneAck(existing);
      }
      if (ACK_RANK[input.level] < ACK_RANK[existing.level]) return cloneAck(existing);
    } else {
      if (this.records.size >= this.maxRecords) {
        throw new BrokerProtocolError('ACK_LEDGER_CAPACITY');
      }
    }
    const accepted = cloneAck(input);
    this.records.set(input.messageId, accepted);
    return cloneAck(accepted);
  }

  get(messageId: string): BrokerAckRecord | undefined {
    const record = this.records.get(messageId);
    return record ? cloneAck(record) : undefined;
  }

  serialize(): string {
    return JSON.stringify({ schemaVersion: 1, records: [...this.records.values()] });
  }

  static restore(serialized: string, maxRecords = 10_000): BrokerAckLedger {
    const parsed = JSON.parse(serialized) as { schemaVersion: number; records: unknown[] };
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.records) ||
      parsed.records.length > maxRecords
    ) {
      throw new BrokerProtocolError('ACK_LEDGER_CAPACITY');
    }
    const ledger = new BrokerAckLedger(maxRecords);
    for (const input of parsed.records) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new BrokerProtocolError('INVALID_ACK_TRANSITION');
      }
      const record = input as BrokerAckRecord;
      requireIdentifier(record.messageId);
      requireBoundedText(record.canonicalDigest, 256);
      if (!Object.hasOwn(ACK_RANK, record.level)) {
        throw new BrokerProtocolError('INVALID_ACK_TRANSITION');
      }
      validateAckProof(record);
      if (ledger.records.has(record.messageId)) {
        throw new BrokerProtocolError('IDEMPOTENCY_CONFLICT');
      }
      ledger.records.set(record.messageId, cloneAck(record));
    }
    return ledger;
  }
}

export type SequenceDecision =
  | { type: 'ACCEPT'; cursor: SequenceCursor }
  | { type: 'REPLAY'; cursor: SequenceCursor }
  | { type: 'REQUEST_REPLAY'; expected: string; received: string; cursor: SequenceCursor };

export function initialSequenceCursor(connectionId: string, maxRetained = 1_024): SequenceCursor {
  if (!Number.isSafeInteger(maxRetained) || maxRetained < 1 || maxRetained > 65_536) {
    throw new BrokerProtocolError('INVALID_SEQUENCE');
  }
  return {
    connectionId: requireIdentifier(connectionId),
    nextExpected: 0n,
    lowestRetained: 0n,
    maxRetained,
    accepted: new Map(),
  };
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
  const sequence = parseFence(envelope.sequence);
  if (sequence < cursor.lowestRetained) {
    throw new BrokerProtocolError('CURSOR_EXPIRED');
  }
  const sequenceKey = formatFence(sequence);
  const existing = cursor.accepted.get(sequenceKey);
  if (existing !== undefined) {
    if (existing !== canonicalDigest) throw new BrokerProtocolError('SEQUENCE_CONFLICT');
    return { type: 'REPLAY', cursor };
  }
  if (sequence < cursor.nextExpected) {
    throw new BrokerProtocolError('INVALID_SEQUENCE');
  }
  if (sequence > cursor.nextExpected) {
    return {
      type: 'REQUEST_REPLAY',
      expected: formatFence(cursor.nextExpected),
      received: sequenceKey,
      cursor,
    };
  }
  const accepted = new Map(cursor.accepted);
  accepted.set(sequenceKey, canonicalDigest);
  let lowestRetained = cursor.lowestRetained;
  while (accepted.size > cursor.maxRetained) {
    accepted.delete(formatFence(lowestRetained));
    lowestRetained += 1n;
  }
  return {
    type: 'ACCEPT',
    cursor: {
      connectionId: cursor.connectionId,
      nextExpected: cursor.nextExpected + 1n,
      lowestRetained,
      maxRetained: cursor.maxRetained,
      accepted,
    },
  };
}

export function serializeSequenceCursor(cursor: SequenceCursor): string {
  return JSON.stringify({
    schemaVersion: 1,
    connectionId: cursor.connectionId,
    nextExpected: cursor.nextExpected.toString(10),
    lowestRetained: cursor.lowestRetained.toString(10),
    maxRetained: cursor.maxRetained,
    accepted: [...cursor.accepted],
  });
}

export function restoreSequenceCursor(serialized: string): SequenceCursor {
  const parsed = JSON.parse(serialized) as {
    schemaVersion: number;
    connectionId: string;
    nextExpected: string;
    lowestRetained: string;
    maxRetained: number;
    accepted: Array<[string, string]>;
  };
  if (
    parsed.schemaVersion !== 1 ||
    !Number.isSafeInteger(parsed.maxRetained) ||
    parsed.maxRetained < 1 ||
    parsed.maxRetained > 65_536 ||
    !Array.isArray(parsed.accepted) ||
    parsed.accepted.length > parsed.maxRetained
  ) {
    throw new BrokerProtocolError('INVALID_SEQUENCE');
  }
  const connectionId = requireIdentifier(parsed.connectionId);
  const nextExpected = parseCursorPosition(parsed.nextExpected);
  const lowestRetained = parseCursorPosition(parsed.lowestRetained);
  if (lowestRetained > nextExpected) throw new BrokerProtocolError('INVALID_SEQUENCE');
  const accepted = new Map<string, string>();
  for (const row of parsed.accepted) {
    if (!Array.isArray(row) || row.length !== 2) {
      throw new BrokerProtocolError('INVALID_SEQUENCE');
    }
    const sequence = formatFence(parseFence(row[0]));
    requireBoundedText(row[1], 256);
    if (
      accepted.has(sequence) ||
      BigInt(sequence) < lowestRetained ||
      BigInt(sequence) >= nextExpected
    ) {
      throw new BrokerProtocolError('INVALID_SEQUENCE');
    }
    accepted.set(sequence, row[1]);
  }
  if (BigInt(accepted.size) !== nextExpected - lowestRetained) {
    throw new BrokerProtocolError('INVALID_SEQUENCE');
  }
  return {
    connectionId,
    nextExpected,
    lowestRetained,
    maxRetained: parsed.maxRetained,
    accepted,
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

export type LeaseErrorCode =
  | 'ACTIVE_LEASE_EXISTS'
  | 'STALE_LEASE'
  | 'STALE_FENCE'
  | 'INVALID_LEASE'
  | 'LEASE_CAPACITY';

export class LeaseError extends Error {
  constructor(readonly code: LeaseErrorCode) {
    super(code);
    this.name = 'LeaseError';
  }
}

export class LeaseRegistry {
  private readonly leases = new Map<string, WorkerLease>();
  private readonly nextFences = new Map<string, bigint>();

  constructor(private readonly maxDeployments = 10_000) {
    if (!Number.isSafeInteger(maxDeployments) || maxDeployments < 1) {
      throw new LeaseError('LEASE_CAPACITY');
    }
  }

  acquire(input: {
    leaseId: string;
    deploymentId: string;
    workerId: string;
    connectionId: string;
    nowMs: number;
    ttlMs: number;
  }): WorkerLease {
    if (
      !Number.isSafeInteger(input.nowMs) ||
      !Number.isSafeInteger(input.ttlMs) ||
      input.ttlMs < 1
    ) {
      throw new LeaseError('INVALID_LEASE');
    }
    this.expire(input.nowMs);
    const current = this.leases.get(input.deploymentId);
    if (current && current.state === 'ACTIVE' && current.expiresAtMs > input.nowMs) {
      throw new LeaseError('ACTIVE_LEASE_EXISTS');
    }
    if (!current && this.leases.size >= this.maxDeployments) {
      throw new LeaseError('LEASE_CAPACITY');
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
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new LeaseError('INVALID_LEASE');
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

  assertWorkerCurrent(binding: LeaseBinding, workerId: string, nowMs: number): WorkerLease {
    const current = this.leases.get(binding.deploymentId);
    if (
      !current ||
      current.state !== 'ACTIVE' ||
      current.leaseId !== binding.leaseId ||
      current.workerId !== workerId ||
      current.expiresAtMs <= nowMs
    ) {
      throw new LeaseError('STALE_LEASE');
    }
    if (current.fence !== parseFence(binding.fence)) throw new LeaseError('STALE_FENCE');
    return { ...current };
  }

  release(binding: LeaseBinding, connectionId: string, nowMs: number): WorkerLease {
    const current = this.assertCurrent(binding, connectionId, nowMs);
    const released = { ...current, state: 'RELEASED' as const };
    this.leases.set(current.deploymentId, released);
    return released;
  }

  revoke(deploymentId: string): WorkerLease {
    const current = this.leases.get(deploymentId);
    if (!current || current.state !== 'ACTIVE') throw new LeaseError('STALE_LEASE');
    const revoked = { ...current, state: 'REVOKED' as const };
    this.leases.set(deploymentId, revoked);
    return { ...revoked };
  }

  expire(nowMs: number): readonly WorkerLease[] {
    const expired: WorkerLease[] = [];
    for (const [deploymentId, current] of this.leases) {
      if (current.state === 'ACTIVE' && current.expiresAtMs <= nowMs) {
        const next = { ...current, state: 'EXPIRED' as const };
        this.leases.set(deploymentId, next);
        expired.push({ ...next });
      }
    }
    return expired;
  }

  serialize(): string {
    return JSON.stringify({
      schemaVersion: 1,
      leases: [...this.leases.values()].map((lease) => ({
        ...lease,
        fence: formatFence(lease.fence),
      })),
      nextFences: [...this.nextFences].map(([deploymentId, fence]) => [
        deploymentId,
        fence.toString(10),
      ]),
    });
  }

  static restore(serialized: string, maxDeployments = 10_000): LeaseRegistry {
    const parsed = JSON.parse(serialized) as {
      schemaVersion: number;
      leases: Array<Omit<WorkerLease, 'fence'> & { fence: string }>;
      nextFences: Array<[string, string]>;
    };
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.leases) ||
      !Array.isArray(parsed.nextFences) ||
      parsed.leases.length > maxDeployments ||
      parsed.nextFences.length > maxDeployments
    ) {
      throw new LeaseError('INVALID_LEASE');
    }
    const registry = new LeaseRegistry(maxDeployments);
    const leaseIds = new Set<string>();
    for (const lease of parsed.leases) {
      requireIdentifier(lease.deploymentId);
      requireIdentifier(lease.leaseId);
      requireIdentifier(lease.workerId);
      requireIdentifier(lease.connectionId);
      if (
        registry.leases.has(lease.deploymentId) ||
        leaseIds.has(lease.leaseId) ||
        !Number.isSafeInteger(lease.expiresAtMs) ||
        !['ACTIVE', 'EXPIRED', 'RELEASED', 'REVOKED'].includes(lease.state)
      ) {
        throw new LeaseError('INVALID_LEASE');
      }
      leaseIds.add(lease.leaseId);
      registry.leases.set(lease.deploymentId, { ...lease, fence: parseFence(lease.fence) });
    }
    for (const [deploymentId, fence] of parsed.nextFences) {
      if (registry.nextFences.has(deploymentId)) throw new LeaseError('INVALID_LEASE');
      requireIdentifier(deploymentId);
      registry.nextFences.set(deploymentId, parseNextFence(fence));
    }
    for (const [deploymentId, lease] of registry.leases) {
      const nextFence = registry.nextFences.get(deploymentId);
      if (nextFence === undefined || nextFence <= lease.fence) {
        throw new LeaseError('INVALID_LEASE');
      }
    }
    return registry;
  }

  current(deploymentId: string): WorkerLease | undefined {
    const current = this.leases.get(deploymentId);
    return current ? { ...current } : undefined;
  }
}

export interface LeaseAuthorityPort {
  assertWorkerCurrent(
    binding: LeaseBinding,
    workerInstallationId: string,
    nowMs: number,
  ): WorkerLease;
}

function validateAckProof(input: BrokerAckRecord): void {
  requireIdentifier(input.messageId);
  requireBoundedText(input.canonicalDigest, 256);
  if (input.level === 'RECEIVED') {
    if (input.durableProof) throw new BrokerProtocolError('INVALID_ACK_TRANSITION');
    return;
  }
  const proof = input.durableProof;
  if (!proof || proof.canonicalDigest !== input.canonicalDigest) {
    throw new BrokerProtocolError('ACK_DURABLE_PROOF_REQUIRED');
  }
  const expectedJournal = input.level === 'PERSISTED' ? 'WORKER_SQLITE' : 'CLOUD_POSTGRESQL';
  if (proof.journal !== expectedJournal || !UUIDISH_PATTERN.test(proof.transactionId)) {
    throw new BrokerProtocolError('ACK_DURABLE_PROOF_REQUIRED');
  }
}

function canonicalAckProof(proof: BrokerAckDurableProof | undefined): string {
  return proof ? `${proof.journal}\0${proof.transactionId}\0${proof.canonicalDigest}` : '';
}

function cloneAck(record: BrokerAckRecord): BrokerAckRecord {
  return {
    ...record,
    ...(record.durableProof ? { durableProof: { ...record.durableProof } } : {}),
  };
}

function requireIdentifier(input: unknown): string {
  if (typeof input !== 'string' || !UUIDISH_PATTERN.test(input)) {
    throw new BrokerProtocolError('INVALID_ENVELOPE');
  }
  return input;
}

function requireBoundedText(input: unknown, maxBytes: number): string {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    Buffer.byteLength(input, 'utf8') > maxBytes
  ) {
    throw new BrokerProtocolError('INVALID_ACK_TRANSITION');
  }
  return input;
}

function parseNextFence(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/u.test(value)) {
    throw new LeaseError('INVALID_LEASE');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_FENCE + 1n) throw new LeaseError('INVALID_LEASE');
  return parsed;
}

function parseCursorPosition(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/u.test(value)) {
    throw new BrokerProtocolError('INVALID_SEQUENCE');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_FENCE + 1n) throw new BrokerProtocolError('INVALID_SEQUENCE');
  return parsed;
}
