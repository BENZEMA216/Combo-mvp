import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  BrokerTransportBodySchema,
  brokerTransportSemanticFingerprint,
  canonicalizeBrokerTransportJson,
  createBrokerTransportFrame,
  parseBrokerTransportFrame,
  type BrokerTransportBody,
  type BrokerTransportCanonicalValue,
  type BrokerTransportFrameMaterialization,
} from '@cb/creator-agent-protocol/broker-transport';

import {
  WorkerTransportRepositoryError,
  type WorkerTransportCommandReference,
  type WorkerTransportConnectionCursor,
  type WorkerTransportDelivery,
  type WorkerTransportRepositoryErrorCode,
} from './transport-types.js';

type Row = Record<string, unknown>;
type Inbound = { row: Row; parsed: BrokerTransportFrameMaterialization };
type Logical = { row: Row; body: BrokerTransportBody };

export function trusted(
  input: BrokerTransportFrameMaterialization,
): BrokerTransportFrameMaterialization {
  const parsed = parseBrokerTransportFrame(input.canonicalText);
  if (parsed.wireFingerprint !== input.wireFingerprint)
    fail('Frame materialization is not exact.', 'MESSAGE_CONFLICT');
  return parsed;
}

export function bindFrame(
  frame: BrokerTransportFrameMaterialization['frame'],
  cursor: WorkerTransportConnectionCursor,
  installationId: string,
  direction: 'CLOUD_TO_WORKER',
): void {
  if (
    frame.direction !== direction ||
    frame.connectionId !== cursor.connectionId ||
    frame.installationId !== installationId ||
    frame.deploymentId !== cursor.deploymentId ||
    frame.workerSessionId !== cursor.workerSessionId ||
    frame.leaseId !== cursor.leaseId ||
    frame.fence !== cursor.fence
  )
    fail('Frame is not bound to the live connection.', 'CURSOR_STALE');
}

export function connectionRow(
  frame: BrokerTransportFrameMaterialization['frame'],
  epoch: number,
  leaseExpiresAt: number,
): Row {
  return {
    connection_id: frame.connectionId,
    installation_id: frame.installationId,
    deployment_id: frame.deploymentId,
    worker_session_id: frame.workerSessionId,
    lease_id: frame.leaseId,
    fence: frame.fence,
    next_outbound_sequence: 1,
    owner_epoch: epoch,
    lease_expires_at_ms: leaseExpiresAt,
    state: 'ACTIVE',
  };
}

export function assertFrameFitsAuthorityBudget(body: BrokerTransportBody): void {
  const id = 'x'.repeat(256);
  createBrokerTransportFrame({
    direction: 'WORKER_TO_CLOUD',
    connectionId: id,
    sequence: Number.MAX_SAFE_INTEGER,
    installationId: id,
    deploymentId: id,
    workerSessionId: id,
    leaseId: id,
    fence: Number.MAX_SAFE_INTEGER,
    messageId: id,
    body,
  });
}

export function nextAppendOrder(
  database: DatabaseSync,
  table: string,
  sequenceColumn: string,
  domain: string,
  identity: string,
): Readonly<{ sequence: number; fingerprint: string }> {
  const prior = database
    .prepare(
      `SELECT ${sequenceColumn},order_fingerprint FROM ${table} ORDER BY ${sequenceColumn} DESC LIMIT 1`,
    )
    .get();
  const sequence = prior === undefined ? 1 : integer(asRow(prior), sequenceColumn) + 1;
  const previous = prior === undefined ? null : text(asRow(prior), 'order_fingerprint');
  return Object.freeze({ sequence, fingerprint: digest(domain, { sequence, previous, identity }) });
}

export function ensureLogical(
  database: DatabaseSync,
  id: string,
  sourceId: string,
  sourceFingerprint: string,
  body: BrokerTransportBody,
  localTerminal: boolean,
  now: number,
): Row {
  const bodyJson = canonical(body);
  const semantic = brokerTransportSemanticFingerprint(id, body);
  const found = database
    .prepare(`SELECT * FROM transport_logical_outbox WHERE delivery_message_id=? OR source_id=?`)
    .get(id, sourceId);
  if (found !== undefined) {
    const row = asRow(found);
    if (
      text(row, 'delivery_message_id') !== id ||
      text(row, 'source_id') !== sourceId ||
      text(row, 'source_fingerprint') !== sourceFingerprint ||
      text(row, 'body_json') !== bodyJson ||
      integer(row, 'local_terminal') !== (localTerminal ? 1 : 0)
    )
      fail('Logical delivery source changed.', 'MESSAGE_CONFLICT');
    return row;
  }
  const order = nextAppendOrder(
    database,
    'transport_logical_outbox',
    'logical_sequence',
    'logical-order',
    semantic,
  );
  database
    .prepare(
      `INSERT INTO transport_logical_outbox(logical_sequence,order_fingerprint,delivery_message_id,source_id,source_fingerprint,semantic_fingerprint,body_type,body_json,local_terminal,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,'PENDING',?,?)`,
    )
    .run(
      order.sequence,
      order.fingerprint,
      id,
      sourceId,
      sourceFingerprint,
      semantic,
      body.type,
      bodyJson,
      localTerminal ? 1 : 0,
      now,
      now,
    );
  return asRow(
    database.prepare(`SELECT * FROM transport_logical_outbox WHERE delivery_message_id=?`).get(id),
  );
}

export function cursorFrom(row: Row): WorkerTransportConnectionCursor {
  return Object.freeze({
    connectionId: text(row, 'connection_id'),
    installationId: text(row, 'installation_id'),
    deploymentId: text(row, 'deployment_id'),
    workerSessionId: text(row, 'worker_session_id'),
    leaseId: text(row, 'lease_id'),
    fence: integer(row, 'fence'),
  }) as WorkerTransportConnectionCursor;
}

export function exactActivation(row: Row, grant: BrokerTransportFrameMaterialization): boolean {
  return (
    text(row, 'activation_message_id') === grant.frame.messageId &&
    text(row, 'activation_semantic_fingerprint') === grant.frame.semanticFingerprint &&
    text(row, 'activation_wire_fingerprint') === grant.wireFingerprint &&
    text(row, 'activation_frame_json') === grant.canonicalText
  );
}

export function exactInbound(row: Row, incoming: BrokerTransportFrameMaterialization): boolean {
  return (
    text(row, 'message_id') === incoming.frame.messageId &&
    text(row, 'semantic_fingerprint') === incoming.frame.semanticFingerprint &&
    text(row, 'wire_fingerprint') === incoming.wireFingerprint &&
    text(row, 'frame_json') === incoming.canonicalText
  );
}

export function commandRef(row: Row): WorkerTransportCommandReference {
  return Object.freeze({
    deliveryMessageId: text(row, 'delivery_message_id'),
    sourceId: text(row, 'source_id'),
    sourceFingerprint: text(row, 'source_fingerprint'),
    commandType: text(row, 'command_type'),
    state: text(row, 'state') as 'PENDING' | 'APPLIED',
  });
}

export function wireView(row: Row): NonNullable<WorkerTransportDelivery['activeWire']> {
  return Object.freeze({
    connectionId: text(row, 'connection_id'),
    sequence: integer(row, 'sequence'),
    wireFingerprint: text(row, 'wire_fingerprint'),
    state: text(row, 'state') as NonNullable<WorkerTransportDelivery['activeWire']>['state'],
  });
}

export function validateAll(database: DatabaseSync, installationId: string, now: number): void {
  try {
    validateAllRecords(database, installationId, now);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (
      error instanceof WorkerTransportRepositoryError ||
      (typeof code === 'string' && /^(?:ERR_)?SQLITE_/u.test(code))
    )
      throw error;
    throw new WorkerTransportRepositoryError(
      'STORE_CORRUPT',
      'Transport records are corrupt.',
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function validateAllRecords(database: DatabaseSync, installationId: string, now: number): void {
  const meta = asRow(database.prepare(`SELECT * FROM transport_meta WHERE singleton=1`).get());
  if (text(meta, 'installation_id') !== installationId)
    fail('Installation binding changed.', 'STORE_SCHEMA_MISMATCH');
  validateAppendSequence(
    database,
    'transport_inbound_deliveries',
    'delivery_sequence',
    'source_fingerprint',
    'command-order',
  );
  validateAppendSequence(
    database,
    'transport_logical_outbox',
    'logical_sequence',
    'semantic_fingerprint',
    'logical-order',
  );
  const ownerRaw = database.prepare(`SELECT * FROM transport_owner WHERE singleton=1`).get();
  if (
    ownerRaw !== undefined &&
    integer(asRow(ownerRaw), 'owner_epoch') > integer(meta, 'highest_owner_epoch')
  ) {
    fail('Owner epoch exceeds durable history.');
  }
  const connections = validateConnections(database, installationId, ownerRaw);
  const highestOwnerEpoch = integer(meta, 'highest_owner_epoch');
  const currentOwnerEpoch = ownerRaw === undefined ? null : integer(asRow(ownerRaw), 'owner_epoch');
  if (
    (currentOwnerEpoch !== null && currentOwnerEpoch !== highestOwnerEpoch) ||
    [...connections.values()].some((row) => integer(row, 'owner_epoch') > highestOwnerEpoch)
  )
    fail('Owner epoch history is corrupt.');
  const inbound = validateInbound(database, connections);
  const logical = validateLogical(database);
  const wires = validateWires(database, connections, logical);
  validateCommands(database, inbound);
  validateTerminals(connections, inbound, logical, wires, now);
  const inboundStats = new Map<string, SequenceStats>();
  const wireStats = new Map<string, SequenceStats>();
  for (const { parsed } of inbound.values())
    addSequence(inboundStats, parsed.frame.connectionId, parsed.frame.sequence);
  for (const wire of wires.values())
    addSequence(wireStats, text(wire, 'connection_id'), integer(wire, 'sequence'));
  for (const [connectionId, row] of connections) {
    const inboundCursor = inboundStats.get(connectionId) ?? EMPTY_SEQUENCE_STATS;
    const wireCursor = wireStats.get(connectionId) ?? EMPTY_SEQUENCE_STATS;
    if (
      inboundCursor.count !== inboundCursor.max ||
      wireCursor.count !== wireCursor.max ||
      integer(row, 'inbound_sequence') !== inboundCursor.max ||
      integer(row, 'next_outbound_sequence') !== wireCursor.max + 1
    )
      fail('Connection cursors are corrupt.');
  }
}

function validateConnections(
  database: DatabaseSync,
  installationId: string,
  ownerRaw: unknown,
): Map<string, Row> {
  const connections = new Map<string, Row>();
  for (const raw of database.prepare(`SELECT * FROM transport_connections`).all() as Row[]) {
    const row = asRow(raw);
    const grant = parseBrokerTransportFrame(text(row, 'activation_frame_json'));
    const frame = grant.frame;
    if (
      !exactActivation(row, grant) ||
      frame.body.type !== 'lease.grant' ||
      frame.direction !== 'CLOUD_TO_WORKER' ||
      frame.installationId !== installationId ||
      !sameConnection(frame, row) ||
      frame.body.leaseExpiresAtMs !== integer(row, 'lease_expires_at_ms')
    )
      fail('Connection activation is corrupt.');
    connections.set(frame.connectionId, row);
  }
  for (const raw of database.prepare(`SELECT * FROM transport_fences`).all() as Row[]) {
    const fence = asRow(raw);
    const candidates = [...connections.values()]
      .filter((row) => text(row, 'deployment_id') === text(fence, 'deployment_id'))
      .sort((left, right) => integer(right, 'fence') - integer(left, 'fence'));
    const latest = candidates[0];
    const active = candidates.find((row) => text(row, 'state') === 'ACTIVE');
    if (
      latest === undefined ||
      integer(latest, 'fence') !== integer(fence, 'highest_fence') ||
      text(latest, 'installation_id') !== text(fence, 'installation_id') ||
      text(latest, 'worker_session_id') !== text(fence, 'worker_session_id') ||
      text(latest, 'lease_id') !== text(fence, 'lease_id') ||
      integer(latest, 'lease_expires_at_ms') !== integer(fence, 'lease_expires_at_ms') ||
      (active !== undefined && active !== latest) ||
      (active !== undefined &&
        (ownerRaw === undefined ||
          integer(active, 'owner_epoch') !== integer(asRow(ownerRaw), 'owner_epoch')))
    )
      fail('Deployment fence is corrupt.');
  }
  return connections;
}

function validateInbound(
  database: DatabaseSync,
  connections: Map<string, Row>,
): Map<string, Inbound> {
  const inbound = new Map<string, Inbound>();
  const identities = new Map<string, string>();
  for (const raw of database.prepare(`SELECT * FROM transport_inbound_messages`).all() as Row[]) {
    const row = asRow(raw);
    const parsed = parseBrokerTransportFrame(text(row, 'frame_json'));
    const frame = parsed.frame;
    const connection = connections.get(frame.connectionId);
    if (
      connection === undefined ||
      !exactInbound(row, parsed) ||
      frame.direction !== 'CLOUD_TO_WORKER' ||
      frame.connectionId !== text(row, 'connection_id') ||
      frame.sequence !== integer(row, 'sequence') ||
      !sameConnection(frame, connection) ||
      frame.body.type !== text(row, 'body_type') ||
      frame.sequence > integer(connection, 'inbound_sequence')
    )
      fail('Inbound frame is corrupt.');
    const prior = identities.get(frame.messageId);
    if (prior !== undefined && prior !== frame.semanticFingerprint)
      fail('Inbound message identity changed.');
    identities.set(frame.messageId, frame.semanticFingerprint);
    inbound.set(`${frame.connectionId}:${frame.sequence}`, { row, parsed });
  }
  return inbound;
}

function validateLogical(database: DatabaseSync): Map<string, Logical> {
  const logical = new Map<string, Logical>();
  for (const raw of database.prepare(`SELECT * FROM transport_logical_outbox`).all() as Row[]) {
    const row = asRow(raw);
    const bodyJson = text(row, 'body_json');
    const parsed = BrokerTransportBodySchema.safeParse(parseCanonical(bodyJson));
    if (!parsed.success || canonical(parsed.data) !== bodyJson)
      fail('Logical body schema is corrupt.');
    const body = parsed.data;
    const id = text(row, 'delivery_message_id');
    if (
      brokerTransportSemanticFingerprint(id, body) !== text(row, 'semantic_fingerprint') ||
      body.type !== text(row, 'body_type')
    )
      fail('Logical delivery is corrupt.');
    if (
      body.type === 'worker.message' &&
      (integer(row, 'local_terminal') !== 0 ||
        body.sourceId !== text(row, 'source_id') ||
        body.sourceFingerprint !== text(row, 'source_fingerprint'))
    )
      fail('Logical source binding is corrupt.');
    if (
      body.type === 'message.ack' &&
      (integer(row, 'local_terminal') !== 1 ||
        body.level !== 'PERSISTED' ||
        id !== `ack.${createHash('sha256').update(canonical(body)).digest('hex')}` ||
        text(row, 'source_id') !== id ||
        text(row, 'source_fingerprint') !== digest('ack-source', body))
    )
      fail('Local ACK binding is corrupt.');
    logical.set(id, { row, body });
  }
  return logical;
}

function validateWires(
  database: DatabaseSync,
  connections: Map<string, Row>,
  logical: Map<string, Logical>,
): Map<string, Row> {
  const wires = new Map<string, Row>();
  for (const raw of database.prepare(`SELECT * FROM transport_wire_outbox`).all() as Row[]) {
    const row = asRow(raw);
    const parsed = parseBrokerTransportFrame(text(row, 'frame_json'));
    const frame = parsed.frame;
    const connection = connections.get(frame.connectionId);
    const item = logical.get(frame.messageId);
    const state = text(row, 'state');
    const written = row.written_at_ms;
    const terminal = row.terminal_at_ms;
    const hasWritten = Number.isSafeInteger(written) && (written as number) >= 0;
    const hasTerminal = Number.isSafeInteger(terminal) && (terminal as number) >= 0;
    const timestampsExact =
      ((state === 'PENDING' || state === 'PREPARED') && written === null && terminal === null) ||
      (state === 'WRITTEN' && hasWritten && terminal === null) ||
      (state === 'ACKED' && hasWritten && hasTerminal) ||
      (state === 'ABANDONED' && (written === null || hasWritten) && hasTerminal);
    if (
      connection === undefined ||
      item === undefined ||
      parsed.wireFingerprint !== text(row, 'wire_fingerprint') ||
      frame.direction !== 'WORKER_TO_CLOUD' ||
      frame.connectionId !== text(row, 'connection_id') ||
      frame.messageId !== text(row, 'delivery_message_id') ||
      frame.semanticFingerprint !== text(row, 'semantic_fingerprint') ||
      frame.semanticFingerprint !== text(item.row, 'semantic_fingerprint') ||
      frame.sequence !== integer(row, 'sequence') ||
      !sameConnection(frame, connection) ||
      canonical(frame.body) !== text(item.row, 'body_json') ||
      !timestampsExact
    )
      fail('Wire delivery is corrupt.');
    wires.set(parsed.wireFingerprint, row);
  }
  return wires;
}

function validateCommands(database: DatabaseSync, inbound: Map<string, Inbound>): void {
  for (const raw of database.prepare(`SELECT * FROM transport_inbound_deliveries`).all() as Row[]) {
    const row = asRow(raw);
    const source = inbound.get(`${text(row, 'connection_id')}:${integer(row, 'sequence')}`);
    if (source === undefined) fail('Command source is missing.');
    const frame = source.parsed.frame;
    const body = frame.body;
    const payload = parseCanonical(text(row, 'payload_json'));
    const state = text(row, 'state');
    const applied = row.applied_at_ms;
    if (
      body.type !== 'command' ||
      frame.messageId !== text(row, 'source_id') ||
      frame.semanticFingerprint !== text(row, 'source_fingerprint') ||
      text(row, 'source_id') !== text(row, 'delivery_message_id') ||
      body.commandType !== text(row, 'command_type') ||
      canonical(body.payload) !== text(row, 'payload_json') ||
      digest('payload', payload as BrokerTransportCanonicalValue) !==
        text(row, 'payload_fingerprint') ||
      (state === 'PENDING'
        ? applied !== null
        : !Number.isSafeInteger(applied) || (applied as number) < 0)
    )
      fail('Command delivery is corrupt.');
  }
  for (const { parsed } of inbound.values()) {
    if (
      parsed.frame.body.type === 'command' &&
      database
        .prepare(`SELECT 1 FROM transport_inbound_deliveries WHERE source_id=?`)
        .get(parsed.frame.messageId) === undefined
    )
      fail('Command delivery is missing.');
  }
}

function validateTerminals(
  connections: Map<string, Row>,
  inbound: Map<string, Inbound>,
  logical: Map<string, Logical>,
  wires: Map<string, Row>,
  now: number,
): void {
  const attemptsByDelivery = new Map<string, Row[]>();
  for (const wire of wires.values()) {
    const id = text(wire, 'delivery_message_id');
    const attempts = attemptsByDelivery.get(id);
    if (attempts === undefined) attemptsByDelivery.set(id, [wire]);
    else attempts.push(wire);
  }
  const commandProofs = new Set<string>();
  const cloudProofs = new Set<string>();
  for (const { parsed } of inbound.values()) {
    const frame = parsed.frame;
    const body = frame.body;
    if (body.type === 'command') {
      commandProofs.add(
        proofKey(frame.messageId, frame.semanticFingerprint, parsed.wireFingerprint),
      );
      continue;
    }
    if (body.type !== 'message.ack' || body.level !== 'CLOUD_COMMITTED') continue;
    cloudProofs.add(
      proofKey(
        body.acknowledgedMessageId,
        body.acknowledgedSemanticFingerprint,
        body.acknowledgedWireFingerprint,
      ),
    );
    const item = logical.get(body.acknowledgedMessageId);
    const wire = wires.get(body.acknowledgedWireFingerprint);
    if (
      item === undefined ||
      wire === undefined ||
      item.body.type !== 'worker.message' ||
      text(item.row, 'state') !== 'ACKED' ||
      text(item.row, 'semantic_fingerprint') !== body.acknowledgedSemanticFingerprint ||
      text(wire, 'delivery_message_id') !== body.acknowledgedMessageId ||
      text(wire, 'state') !== 'ACKED' ||
      wire.written_at_ms === null ||
      wire.written_at_ms === undefined
    )
      fail('Cloud ACK proof is corrupt.');
  }
  const active = [...connections.values()].find((row) => text(row, 'state') === 'ACTIVE');
  const activeExpired = active !== undefined && integer(active, 'lease_expires_at_ms') <= now;
  for (const [id, item] of logical) {
    const attempts = attemptsByDelivery.get(id) ?? [];
    const live = attempts.filter((row) =>
      ['PENDING', 'PREPARED', 'WRITTEN'].includes(text(row, 'state')),
    );
    const committed = attempts.filter((row) => text(row, 'state') === 'ACKED');
    const semantic = text(item.row, 'semantic_fingerprint');
    if (
      item.body.type === 'worker.message' &&
      committed.some(
        (wire) => !cloudProofs.has(proofKey(id, semantic, text(wire, 'wire_fingerprint'))),
      )
    )
      fail('Worker delivery terminal proof is missing.');
    const persistedAck =
      item.body.type === 'message.ack' && item.body.level === 'PERSISTED' ? item.body : null;
    if (
      persistedAck !== null &&
      !commandProofs.has(
        proofKey(
          persistedAck.acknowledgedMessageId,
          persistedAck.acknowledgedSemanticFingerprint,
          persistedAck.acknowledgedWireFingerprint,
        ),
      )
    )
      fail('Persisted ACK source proof is missing.');
    if (text(item.row, 'state') === 'PENDING') {
      if (
        (item.body.type === 'worker.message' && committed.length !== 0) ||
        (active === undefined && live.length !== 0) ||
        (active !== undefined &&
          (live.length > 1 ||
            (!activeExpired && live.length !== 1) ||
            (live.length === 1 &&
              text(live[0]!, 'connection_id') !== text(active, 'connection_id'))))
      )
        fail('Pending logical wire is corrupt.');
      continue;
    }
    if (live.length !== 0) fail('Terminal logical has a live wire.');
    const proved =
      item.body.type === 'message.ack'
        ? committed.some((row) => row.written_at_ms !== null)
        : committed.length !== 0;
    if (!proved) fail('Logical terminal proof is missing.');
  }
}

function proofKey(messageId: string, semanticFingerprint: string, wireFingerprint: string): string {
  return `${messageId}\0${semanticFingerprint}\0${wireFingerprint}`;
}

function sameConnection(frame: BrokerTransportFrameMaterialization['frame'], row: Row): boolean {
  return (
    frame.connectionId === text(row, 'connection_id') &&
    frame.installationId === text(row, 'installation_id') &&
    frame.deploymentId === text(row, 'deployment_id') &&
    frame.workerSessionId === text(row, 'worker_session_id') &&
    frame.leaseId === text(row, 'lease_id') &&
    frame.fence === integer(row, 'fence')
  );
}

export const canonical = canonicalizeBrokerTransportJson;

export function parseCanonical(source: string): unknown {
  const value = JSON.parse(source) as unknown;
  if (canonical(value as BrokerTransportCanonicalValue) !== source)
    fail('Stored JSON is not canonical.');
  return value;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function digest(domain: string, value: BrokerTransportCanonicalValue): string {
  return `sha256:${createHash('sha256')
    .update(`${domain}\0${canonical(value)}`)
    .digest('hex')}`;
}

export function asRow(value: unknown): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('SQLite row is missing or invalid.');
  return value as Row;
}
export function text(row: Row, key: string): string {
  if (typeof row[key] !== 'string') fail(`SQLite ${key} is invalid.`);
  return row[key] as string;
}
export function integer(row: Row, key: string): number {
  if (!Number.isSafeInteger(row[key])) fail(`SQLite ${key} is invalid.`);
  return row[key] as number;
}
type SequenceStats = { count: number; max: number };
const EMPTY_SEQUENCE_STATS: SequenceStats = Object.freeze({ count: 0, max: 0 });
function addSequence(target: Map<string, SequenceStats>, key: string, value: number): void {
  const prior = target.get(key) ?? EMPTY_SEQUENCE_STATS;
  target.set(key, { count: prior.count + 1, max: Math.max(prior.max, value) });
}
function validateAppendSequence(
  database: DatabaseSync,
  table: string,
  column: string,
  identityColumn: string,
  domain: string,
): void {
  let expected = 1;
  let previous: string | null = null;
  for (const raw of database
    .prepare(
      `SELECT ${column},order_fingerprint,${identityColumn} FROM ${table} ORDER BY ${column}`,
    )
    .all() as Row[]) {
    const row = asRow(raw);
    const fingerprint = text(row, 'order_fingerprint');
    if (
      integer(row, column) !== expected ||
      fingerprint !==
        digest(domain, { sequence: expected, previous, identity: text(row, identityColumn) })
    )
      fail(`${table} append order is corrupt.`);
    previous = fingerprint;
    expected += 1;
  }
  const sequence = database.prepare(`SELECT seq FROM sqlite_sequence WHERE name=?`).get(table);
  const durableMax = sequence === undefined ? 0 : integer(asRow(sequence), 'seq');
  if (durableMax !== expected - 1) fail(`${table} append sequence is corrupt.`);
}
function fail(message: string, code: WorkerTransportRepositoryErrorCode = 'STORE_CORRUPT'): never {
  throw new WorkerTransportRepositoryError(code, message);
}
