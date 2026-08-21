import { createHash } from 'node:crypto';

import {
  canonicalWorkerJson,
  parseCanonicalWorkerJson,
  snapshotWorkerInvocationState,
  utf8ByteLength,
  validateDurableWorkerEffect,
  validateDurableWorkerInvocationEvent,
  validateDurableWorkerInvocationState,
  workerStorageFingerprint,
} from './durable-codec.js';
import {
  WorkerSqliteStoreError,
  type WorkerDurableInvocationView,
  type WorkerOutboxFactReference,
} from './sqlite-store-types.js';
import { MAX_DURABLE_SEALED_ENVELOPE_BYTES } from './sqlite-store-internal.js';
import {
  reduceWorkerInvocation,
  type WorkerDurableEffect,
  type WorkerInvocationEvent,
  type WorkerInvocationState,
  type WorkerTerminal,
} from './worker-invocation.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export const STATE_FINGERPRINT_DOMAIN = 'combo.worker-sqlite.invocation-state/1';
export const RECOVERY_FINGERPRINT_DOMAIN = 'combo.worker-sqlite.recovery/1';
export const EVENT_FINGERPRINT_DOMAIN = 'combo.worker-sqlite.event/1';
export const OUTBOX_FINGERPRINT_DOMAIN = 'combo.worker-sqlite.outbox/1';
export const ENVELOPE_FINGERPRINT_DOMAIN = 'combo.worker-sqlite.sealed-envelope/1';

export type WorkerSqliteInvocationRow = Readonly<{
  invocationId: string;
  revision: number;
  phase: WorkerInvocationState['phase'];
  stateJson: string;
  stateFingerprint: string;
  recoveryJson: string | null;
  recoveryFingerprint: string | null;
  sealedResultId: string | null;
}>;

export type WorkerSqliteStoredEventRow = Readonly<{
  invocationId: string;
  semanticFingerprint: string;
}>;

/** Captures every caller-owned event field once while retaining exact process-local capabilities. */
export function normalizeWorkerInvocationEvent(
  event: WorkerInvocationEvent,
): WorkerInvocationEvent {
  switch (event.type) {
    case 'DISPATCH_INTENT_RECORDED':
      return Object.freeze({ type: event.type, attemptId: event.attemptId });
    case 'CANCEL_PROVEN_NOT_DISPATCHED':
    case 'PROCESS_RECOVERY_WITHOUT_HANDLE':
      return Object.freeze({ type: event.type });
    case 'INTERRUPT_INTENT_RECORDED':
      return Object.freeze({
        type: event.type,
        attemptId: event.attemptId,
        attempt: event.attempt,
        reason: event.reason,
      });
    case 'HOST_START_DISPOSITION_RECORDED':
      return Object.freeze({ type: event.type, disposition: event.disposition });
    case 'HOST_INTERRUPT_DISPOSITION_RECORDED':
      return Object.freeze({ type: event.type, disposition: event.disposition });
    case 'HOST_TERMINAL_CONFIRMED':
      return Object.freeze({ type: event.type, terminal: event.terminal });
    case 'HOST_EVIDENCE_LOST':
      return Object.freeze({ type: event.type, hostReason: event.hostReason });
  }
}

export function recoverySnapshot(
  state: WorkerInvocationState,
  sourceRevision: number,
  sourceStateFingerprint: string,
): unknown | null {
  if (state.phase !== 'DISPATCHING' && state.phase !== 'RUNNING') return null;
  const recovery = reduceWorkerInvocation(state, { type: 'PROCESS_RECOVERY_WITHOUT_HANDLE' });
  return Object.freeze({
    sourceRevision,
    sourceStateFingerprint,
    next: snapshotWorkerInvocationState(recovery.next),
    durable: parseCanonicalWorkerJson(canonicalWorkerJson(recovery.durable[0])),
  });
}

export function parseRecovery(
  row: WorkerSqliteInvocationRow,
): Readonly<{ next: unknown; durable: unknown }> {
  if (row.recoveryJson === null || row.recoveryFingerprint === null) {
    throw corrupt('Active Invocation is missing recovery evidence.');
  }
  const value = parseCanonicalWorkerJson(row.recoveryJson);
  validateRecovery(value, row);
  assertFingerprint(
    row.recoveryFingerprint,
    workerStorageFingerprint(RECOVERY_FINGERPRINT_DOMAIN, value),
    'Invocation recovery',
  );
  const record = asRecord(value, 'Invocation recovery');
  return Object.freeze({ next: record.next, durable: record.durable });
}

export function validateRecovery(
  value: unknown,
  source?: Pick<WorkerSqliteInvocationRow, 'revision' | 'stateFingerprint'>,
): void {
  const record = asRecord(value, 'Invocation recovery');
  const keys = Object.keys(record).sort();
  const expectedKeys = ['durable', 'next', 'sourceRevision', 'sourceStateFingerprint'];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw corrupt('Invocation recovery fields are not exact.');
  }
  const sourceRevision = record.sourceRevision;
  if (!Number.isSafeInteger(sourceRevision) || (sourceRevision as number) < 0) {
    throw corrupt('Invocation recovery source revision is invalid.');
  }
  if (
    typeof record.sourceStateFingerprint !== 'string' ||
    !SHA256_PATTERN.test(record.sourceStateFingerprint)
  ) {
    throw corrupt('Invocation recovery source fingerprint is invalid.');
  }
  if (
    source !== undefined &&
    (sourceRevision !== source.revision ||
      record.sourceStateFingerprint !== source.stateFingerprint)
  ) {
    throw corrupt('Invocation recovery does not bind its source state.');
  }
  validateDurableWorkerInvocationState(record.next);
  if (recordString(record.next, 'phase') !== 'TERMINAL_READY') {
    throw corrupt('Recovery must end at TERMINAL_READY.');
  }
  validateDurableWorkerEffect(record.durable);
  if (durableFactType(record.durable) !== 'TERMINAL') {
    throw corrupt('Recovery must emit one terminal fact.');
  }
  const next = asRecord(record.next, 'Invocation recovery next state');
  const durable = asRecord(record.durable, 'Invocation recovery durable fact');
  if (canonicalWorkerJson(durable.terminal) !== canonicalWorkerJson(next.terminal)) {
    throw corrupt('Recovery terminal fact does not match its next state.');
  }
}

export function terminalSuccess(effects: readonly WorkerDurableEffect[]): Readonly<{
  type: 'ENQUEUE_TERMINAL_FACT';
  terminal: Extract<WorkerTerminal, { outcome: 'SUCCEEDED'; source: 'HOST' }>;
}> | null {
  for (const effect of effects) {
    if (
      effect.type === 'ENQUEUE_TERMINAL_FACT' &&
      effect.terminal.outcome === 'SUCCEEDED' &&
      effect.terminal.source === 'HOST'
    ) {
      return effect as Readonly<{
        type: 'ENQUEUE_TERMINAL_FACT';
        terminal: Extract<WorkerTerminal, { outcome: 'SUCCEEDED'; source: 'HOST' }>;
      }>;
    }
  }
  return null;
}

export function durableFactType(value: unknown): 'STARTED' | 'TERMINAL' {
  const type = recordString(value, 'type');
  if (type === 'ENQUEUE_STARTED_FACT') return 'STARTED';
  if (type === 'ENQUEUE_TERMINAL_FACT') return 'TERMINAL';
  throw corrupt('Unknown durable fact type.');
}

export function workerFactIdentifier(
  invocationId: string,
  factType: 'STARTED' | 'TERMINAL',
): string {
  return `fact.${createHash('sha256')
    .update(`combo.worker-sqlite.fact/1\0${invocationId}\0${factType}`)
    .digest('hex')}`;
}

type WorkerSqliteValidationDatabase = Readonly<{
  prepare(sql: string): Readonly<{ all(...parameters: unknown[]): readonly unknown[] }>;
}>;

export function validateWorkerSqliteDatabaseRows(database: WorkerSqliteValidationDatabase): void {
  const invocations = new Map<
    string,
    Readonly<{ row: WorkerSqliteInvocationRow; state: Record<string, unknown> }>
  >();
  for (const raw of database
    .prepare('SELECT * FROM worker_invocations ORDER BY invocation_id')
    .all()) {
    const row = decodeInvocationRow(raw);
    const state = asRecord(parseCanonicalWorkerJson(row.stateJson), 'Invocation state');
    validateDurableWorkerInvocationState(state);
    if (recordString(state, 'phase') !== row.phase) {
      throw corrupt('Invocation phase does not match its snapshot.');
    }
    assertFingerprint(
      row.stateFingerprint,
      workerStorageFingerprint(STATE_FINGERPRINT_DOMAIN, state),
      'Invocation state',
    );
    if ((row.recoveryJson === null) !== (row.recoveryFingerprint === null)) {
      throw corrupt('Invocation recovery fields are incomplete.');
    }
    if (row.recoveryJson !== null && row.recoveryFingerprint !== null) {
      const recovery = parseCanonicalWorkerJson(row.recoveryJson);
      validateRecovery(recovery, row);
      assertFingerprint(
        row.recoveryFingerprint,
        workerStorageFingerprint(RECOVERY_FINGERPRINT_DOMAIN, recovery),
        'Invocation recovery',
      );
    }
    validateEventChain(database, row);
    invocations.set(row.invocationId, Object.freeze({ row, state }));
  }

  const seals = new Map<string, Record<string, unknown>>();
  for (const raw of database.prepare('SELECT * FROM worker_sealed_results').all()) {
    const row = requiredRow(raw, 'Sealed result row is invalid.');
    const sealedResultId = rowString(row, 'sealed_result_id');
    const json = rowString(row, 'envelope_json');
    const envelope = parseCanonicalWorkerJson(json);
    assertFingerprint(
      rowString(row, 'envelope_fingerprint'),
      workerStorageFingerprint(ENVELOPE_FINGERPRINT_DOMAIN, envelope),
      'Sealed envelope',
    );
    const envelopeBytes = rowInteger(row, 'envelope_bytes');
    if (envelopeBytes !== utf8ByteLength(json)) {
      throw corrupt('Sealed envelope byte length is inconsistent.');
    }
    if (envelopeBytes > MAX_DURABLE_SEALED_ENVELOPE_BYTES) {
      throw corrupt('Sealed envelope exceeds the durable byte limit.');
    }
    seals.set(sealedResultId, row);
  }

  const terminalInvocations = new Set<string>();
  const usedSeals = new Set<string>();
  for (const raw of database.prepare('SELECT * FROM worker_invocation_outbox').all()) {
    const row = requiredRow(raw, 'Outbox row is invalid.');
    const createdAtMs = rowInteger(row, 'created_at_ms');
    const transportEnqueuedAtMs = rowNullableInteger(row, 'transport_enqueued_at_ms');
    if (transportEnqueuedAtMs !== null && transportEnqueuedAtMs < createdAtMs) {
      throw corrupt('Outbox transport handoff predates fact creation.');
    }
    const invocationId = rowString(row, 'invocation_id');
    const invocation = invocations.get(invocationId);
    if (invocation === undefined) throw corrupt('Outbox Invocation is missing.');
    const payload = asRecord(
      parseCanonicalWorkerJson(rowString(row, 'payload_json')),
      'Outbox payload',
    );
    validateDurableWorkerEffect(payload);
    assertFingerprint(
      rowString(row, 'payload_fingerprint'),
      workerStorageFingerprint(OUTBOX_FINGERPRINT_DOMAIN, payload),
      'Outbox payload',
    );
    const factType = durableFactType(payload);
    if (
      rowString(row, 'fact_type') !== factType ||
      rowString(row, 'fact_id') !== workerFactIdentifier(invocationId, factType)
    ) {
      throw corrupt('Outbox identity does not match its payload.');
    }
    const operationId = rowString(row, 'operation_id');
    const sourceEvents = database
      .prepare(
        `SELECT event_type, event_json, to_revision, state_fingerprint
           FROM worker_invocation_events WHERE operation_id = ? AND invocation_id = ?`,
      )
      .all(operationId, invocationId) as Record<string, unknown>[];
    const source = sourceEvents[0];
    if (sourceEvents.length !== 1 || source === undefined) {
      throw corrupt('Outbox source event is not exact.');
    }
    const sealedResultId = rowNullableString(row, 'sealed_result_id');
    if (factType === 'STARTED') {
      const sourceEvent = asRecord(
        parseCanonicalWorkerJson(rowString(source, 'event_json')),
        'STARTED source event',
      );
      const disposition = asRecord(sourceEvent.disposition, 'STARTED source disposition');
      if (
        sealedResultId !== null ||
        rowString(source, 'event_type') !== 'HOST_START_DISPOSITION_RECORDED' ||
        disposition.disposition !== 'STARTED' ||
        canonicalWorkerJson(disposition.binding) !== canonicalWorkerJson(payload.binding)
      ) {
        throw corrupt('STARTED does not match its source event.');
      }
      continue;
    }
    if (terminalInvocations.has(invocationId))
      throw corrupt('Invocation has duplicate terminal facts.');
    terminalInvocations.add(invocationId);
    const terminal = asRecord(payload.terminal, 'Outbox terminal');
    if (
      invocation.row.phase !== 'TERMINAL_READY' ||
      rowInteger(source, 'to_revision') !== invocation.row.revision ||
      rowString(source, 'state_fingerprint') !== invocation.row.stateFingerprint ||
      canonicalWorkerJson(terminal) !== canonicalWorkerJson(invocation.state.terminal)
    ) {
      throw corrupt('Terminal outbox does not match its final Invocation event.');
    }
    const success = terminal.outcome === 'SUCCEEDED' && terminal.source === 'HOST';
    if (!success) {
      if (sealedResultId !== null || invocation.row.sealedResultId !== null) {
        throw corrupt('Non-success terminal cannot reference a sealed result.');
      }
      continue;
    }
    const host = asRecord(terminal.host, 'Successful Host terminal');
    const receipt = asRecord(host.sealedResult, 'Successful sealed result receipt');
    const expectedId = recordString(receipt, 'sealedResultId');
    const seal = seals.get(expectedId);
    if (
      sealedResultId !== expectedId ||
      invocation.row.sealedResultId !== expectedId ||
      host.resultFingerprint !== receipt.resultFingerprint ||
      seal === undefined ||
      rowString(seal, 'invocation_id') !== invocationId ||
      rowString(seal, 'operation_id') !== operationId ||
      rowString(seal, 'result_fingerprint') !== receipt.resultFingerprint ||
      rowString(seal, 'sealed_fingerprint') !== receipt.sealedFingerprint
    ) {
      throw corrupt('Successful terminal seal binding does not match.');
    }
    usedSeals.add(expectedId);
  }

  for (const { row } of invocations.values()) {
    if ((row.phase === 'TERMINAL_READY') !== terminalInvocations.has(row.invocationId)) {
      throw corrupt('Invocation terminal and outbox presence do not match.');
    }
  }
  if (usedSeals.size !== seals.size)
    throw corrupt('Sealed result is not bound to a success terminal.');
}

function validateEventChain(
  database: WorkerSqliteValidationDatabase,
  invocation: WorkerSqliteInvocationRow,
): void {
  const events = database
    .prepare(
      `SELECT event_type, event_json, semantic_fingerprint, from_revision, to_revision,
              state_fingerprint
         FROM worker_invocation_events WHERE invocation_id = ? ORDER BY to_revision`,
    )
    .all(invocation.invocationId) as Record<string, unknown>[];
  if (events.length !== invocation.revision + 1) {
    throw corrupt('Invocation event chain length is inconsistent.');
  }
  let expectedFrom = -1;
  for (const event of events) {
    if (
      rowInteger(event, 'from_revision') !== expectedFrom ||
      rowInteger(event, 'to_revision') !== expectedFrom + 1
    ) {
      throw corrupt('Invocation event revisions are not contiguous.');
    }
    const value = parseCanonicalWorkerJson(rowString(event, 'event_json'));
    const storedType = rowString(event, 'event_type');
    if (storedType !== recordString(value, 'type')) {
      throw corrupt('Invocation event type does not match its payload.');
    }
    if (storedType === 'PREPARE_CREATED') {
      if (canonicalWorkerJson(value) !== '{"type":"PREPARE_CREATED"}') {
        throw corrupt('Prepare event payload is not exact.');
      }
    } else {
      validateDurableWorkerInvocationEvent(value);
    }
    assertFingerprint(
      rowString(event, 'semantic_fingerprint'),
      workerStorageFingerprint(EVENT_FINGERPRINT_DOMAIN, value),
      'Invocation event',
    );
    expectedFrom += 1;
  }
  const last = events.at(-1);
  if (last === undefined || rowString(last, 'state_fingerprint') !== invocation.stateFingerprint) {
    throw corrupt('Last event does not bind the current state.');
  }
}

export function decodeInvocationRow(raw: unknown): WorkerSqliteInvocationRow {
  const row = requiredRow(raw, 'Invocation row is missing.');
  const phase = rowString(row, 'phase');
  if (!['PREPARED', 'DISPATCHING', 'RUNNING', 'TERMINAL_READY'].includes(phase)) {
    throw corrupt('Invocation phase is invalid.');
  }
  return Object.freeze({
    invocationId: rowString(row, 'invocation_id'),
    revision: rowInteger(row, 'revision'),
    phase: phase as WorkerInvocationState['phase'],
    stateJson: rowString(row, 'state_json'),
    stateFingerprint: rowString(row, 'state_fingerprint'),
    recoveryJson: rowNullableString(row, 'recovery_json'),
    recoveryFingerprint: rowNullableString(row, 'recovery_fingerprint'),
    sealedResultId: rowNullableString(row, 'sealed_result_id'),
  });
}

export function durableView(row: WorkerSqliteInvocationRow): WorkerDurableInvocationView {
  return Object.freeze({
    invocationId: row.invocationId,
    revision: row.revision,
    phase: row.phase,
    stateFingerprint: row.stateFingerprint,
    state: parseCanonicalWorkerJson(row.stateJson),
    sealedResultId: row.sealedResultId,
  });
}

export function decodeStoredEvent(raw: unknown): WorkerSqliteStoredEventRow {
  const row = requiredRow(raw, 'Stored event row is missing.');
  return Object.freeze({
    invocationId: rowString(row, 'invocation_id'),
    semanticFingerprint: rowString(row, 'semantic_fingerprint'),
  });
}

export function decodeOutboxReference(row: Record<string, unknown>): WorkerOutboxFactReference {
  const factType = rowString(row, 'fact_type');
  if (factType !== 'STARTED' && factType !== 'TERMINAL') {
    throw corrupt('Outbox fact type is invalid.');
  }
  return Object.freeze({
    factId: rowString(row, 'fact_id'),
    invocationId: rowString(row, 'invocation_id'),
    operationId: rowString(row, 'operation_id'),
    factType,
    payloadFingerprint: rowString(row, 'payload_fingerprint'),
    sealedResultId: rowNullableString(row, 'sealed_result_id'),
  });
}

export function requiredRow(input: unknown, message: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw corrupt(message);
  return input as Record<string, unknown>;
}

export function asRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw corrupt(`${label} is not an object.`);
  }
  return input as Record<string, unknown>;
}

export function recordString(input: unknown, key: string): string {
  return rowString(asRecord(input, key), key);
}

export function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw corrupt(`${key} is not text.`);
  return value;
}

export function rowNullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw corrupt(`${key} is not nullable text.`);
  return value;
}

export function rowInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw corrupt(`${key} is not a safe integer.`);
  }
  return value;
}

export function rowNullableInteger(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw corrupt(`${key} is not a nullable non-negative safe integer.`);
  }
  return value;
}

export function assertFingerprint(actual: string, expected: string, label: string): void {
  if (!SHA256_PATTERN.test(actual) || actual !== expected) {
    throw corrupt(`${label} fingerprint does not match.`);
  }
}

function corrupt(message: string): WorkerSqliteStoreError {
  return new WorkerSqliteStoreError('STORE_CORRUPT', message);
}
