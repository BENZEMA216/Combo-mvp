import { createHash } from 'node:crypto';

import type {
  WorkerDurableEffect,
  WorkerInvocationEvent,
  WorkerInvocationState,
} from './worker-invocation.js';

export type WorkerJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly WorkerJsonValue[]
  | WorkerJsonObject;
export type WorkerJsonObject = Readonly<{ [key: string]: WorkerJsonValue }>;

export type DurableWorkerInvocationState =
  | Readonly<{ phase: 'PREPARED' }>
  | Readonly<{
      phase: 'DISPATCHING';
      startAttemptId: string;
      pendingInterrupt: WorkerJsonObject | null;
    }>
  | Readonly<{
      phase: 'RUNNING';
      startAttemptId: string;
      binding: WorkerJsonObject;
      interrupt: WorkerJsonObject;
      pendingInterruptedTerminal: WorkerJsonObject | null;
    }>
  | Readonly<{ phase: 'TERMINAL_READY'; terminal: WorkerJsonObject }>;

export type DurableWorkerInvocationEvent = Readonly<
  WorkerJsonObject & { type: WorkerInvocationEvent['type'] }
>;
export type DurableWorkerEffect = Readonly<
  WorkerJsonObject & { type: WorkerDurableEffect['type'] }
>;

const CANONICAL_IMPLEMENTATION = 'combo-worker-rfc8785-jcs/1' as const;
const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9:._/-]{0,127}$/u;
const RUNTIME_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const START_FAILURE_REASONS = new Set(['RUNTIME_START_FAILED']);
const HOST_EVIDENCE_REASONS = new Set([
  'HOST_PROTOCOL_ERROR',
  'HOST_SESSION_LOST',
  'HOST_TERMINAL_MISSING',
]);
const UNCERTAIN_REASONS = new Set([
  'START_DISPATCH_UNKNOWN',
  'HOST_OUTCOME_EVIDENCE_LOST',
  'INTERRUPT_OUTCOME_UNKNOWN',
  'HOST_TERMINAL_OBSERVED_BUT_UNCOMMITTED',
  'PROCESS_RESTART_WITH_DISPATCH_INTENT',
  'PROCESS_RESTART_WITH_LIVE_TURN',
  'PROCESS_RESTART_WITH_INTERRUPT',
  'PROCESS_RESTART_AFTER_TERMINAL_OBSERVED',
]);

/** Serializes strict plain JSON using RFC 8785 property and number ordering rules. */
export function canonicalWorkerJson(value: unknown): string {
  return serializeJson(value, '$', new Set<object>());
}

/** Parses only an already-canonical encoding and returns a detached, deeply frozen JSON value. */
export function parseCanonicalWorkerJson(text: string): unknown {
  if (typeof text !== 'string') throw new TypeError('Canonical Worker JSON must be text.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('Canonical Worker JSON is invalid.');
  }
  if (canonicalWorkerJson(parsed) !== text) {
    throw new TypeError('Worker JSON input is not canonical.');
  }
  freezeJson(parsed);
  return parsed;
}

/** Hashes a canonical envelope so the same value in another storage domain cannot collide. */
export function workerStorageFingerprint(domain: string, value: unknown): string {
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new TypeError('Worker storage fingerprint domain must be stable lowercase ASCII.');
  }
  const canonical = canonicalWorkerJson({
    domain,
    implementation: CANONICAL_IMPLEMENTATION,
    value,
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function utf8ByteLength(text: string): number {
  if (typeof text !== 'string' || containsLoneSurrogate(text)) {
    throw new TypeError('UTF-8 input must be well-formed text.');
  }
  return Buffer.byteLength(text, 'utf8');
}

/** Returns durable plain data, never a restored R2A Host/effect/seal authority. */
export function snapshotWorkerInvocationState(
  state: WorkerInvocationState,
): DurableWorkerInvocationState {
  return validateDurableWorkerInvocationState(state);
}

export function validateDurableWorkerInvocationState(value: unknown): DurableWorkerInvocationState {
  const snapshot = snapshotPlainJson(value);
  assertInvocationState(snapshot, '$');
  return snapshot as DurableWorkerInvocationState;
}

/** Event snapshots are history/audit data and cannot be replayed as trusted reducer input. */
export function snapshotWorkerInvocationEvent(
  event: WorkerInvocationEvent,
): DurableWorkerInvocationEvent {
  return validateDurableWorkerInvocationEvent(event);
}

export function validateDurableWorkerInvocationEvent(value: unknown): DurableWorkerInvocationEvent {
  const snapshot = snapshotPlainJson(value);
  assertInvocationEvent(snapshot, '$');
  return snapshot as DurableWorkerInvocationEvent;
}

export function snapshotWorkerDurableEffect(effect: WorkerDurableEffect): DurableWorkerEffect {
  return validateDurableWorkerEffect(effect);
}

export function validateDurableWorkerEffect(value: unknown): DurableWorkerEffect {
  const snapshot = snapshotPlainJson(value);
  const effect = record(snapshot, '$');
  const type = literalString(effect.type, '$.type');
  if (type === 'ENQUEUE_STARTED_FACT') {
    exactKeys(effect, ['type', 'binding'], '$');
    assertBinding(effect.binding, '$.binding');
  } else if (type === 'ENQUEUE_TERMINAL_FACT') {
    exactKeys(effect, ['type', 'terminal'], '$');
    assertTerminal(effect.terminal, '$.terminal');
  } else {
    fail('$.type', 'unknown durable effect');
  }
  return snapshot as DurableWorkerEffect;
}

function snapshotPlainJson(value: unknown): WorkerJsonValue {
  return parseCanonicalWorkerJson(canonicalWorkerJson(value)) as WorkerJsonValue;
}

function serializeJson(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (containsLoneSurrogate(value)) fail(path, 'contains a lone surrogate');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'contains a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') fail(path, 'is not a JSON value');
  if (ancestors.has(value)) fail(path, 'contains a cycle');

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, path, ancestors)
      : serializeObject(value, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(value: unknown[], path: string, ancestors: Set<object>): string {
  const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
  if (
    keys.length !== value.length ||
    keys.some((key, index) => typeof key !== 'string' || key !== String(index))
  ) {
    fail(path, 'must be a dense JSON array without extra properties');
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      fail(`${path}[${index}]`, 'must be an enumerable data property');
    }
    items.push(serializeJson(descriptor.value, `${path}[${index}]`, ancestors));
  }
  return `[${items.join(',')}]`;
}

function serializeObject(value: object, path: string, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, 'must be a plain JSON object');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) fail(path, 'contains a symbol key');
  const keys = ownKeys as string[];
  for (const key of keys) {
    if (containsLoneSurrogate(key)) fail(path, 'contains a malformed key');
  }
  keys.sort();
  const fields: string[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      fail(`${path}.${key}`, 'must be an enumerable data property');
    }
    fields.push(
      `${JSON.stringify(key)}:${serializeJson(descriptor.value, `${path}.${key}`, ancestors)}`,
    );
  }
  return `{${fields.join(',')}}`;
}

function freezeJson(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
  } else {
    for (const item of Object.values(value)) freezeJson(item);
  }
  Object.freeze(value);
}

function assertInvocationState(value: unknown, path: string): void {
  const state = record(value, path);
  const phase = literalString(state.phase, `${path}.phase`);
  if (phase === 'PREPARED') {
    exactKeys(state, ['phase'], path);
    return;
  }
  if (phase === 'DISPATCHING') {
    exactKeys(state, ['phase', 'startAttemptId', 'pendingInterrupt'], path);
    attemptId(state.startAttemptId, `${path}.startAttemptId`);
    if (state.pendingInterrupt !== null) {
      assertPendingInterrupt(state.pendingInterrupt, `${path}.pendingInterrupt`);
    }
    return;
  }
  if (phase === 'RUNNING') {
    exactKeys(
      state,
      ['phase', 'startAttemptId', 'binding', 'interrupt', 'pendingInterruptedTerminal'],
      path,
    );
    attemptId(state.startAttemptId, `${path}.startAttemptId`);
    assertBinding(state.binding, `${path}.binding`);
    assertInterrupt(state.interrupt, `${path}.interrupt`, false);
    if (state.pendingInterruptedTerminal !== null) {
      assertInterruptedTerminal(
        state.pendingInterruptedTerminal,
        `${path}.pendingInterruptedTerminal`,
      );
    }
    return;
  }
  if (phase === 'TERMINAL_READY') {
    exactKeys(state, ['phase', 'terminal'], path);
    assertTerminal(state.terminal, `${path}.terminal`);
    return;
  }
  fail(`${path}.phase`, 'unknown invocation phase');
}

function assertInvocationEvent(value: unknown, path: string): void {
  const event = record(value, path);
  const type = literalString(event.type, `${path}.type`);
  switch (type) {
    case 'DISPATCH_INTENT_RECORDED':
      exactKeys(event, ['type', 'attemptId'], path);
      attemptId(event.attemptId, `${path}.attemptId`);
      return;
    case 'CANCEL_PROVEN_NOT_DISPATCHED':
    case 'PROCESS_RECOVERY_WITHOUT_HANDLE':
      exactKeys(event, ['type'], path);
      return;
    case 'INTERRUPT_INTENT_RECORDED':
      exactKeys(event, ['type', 'attemptId', 'attempt', 'reason'], path);
      attemptId(event.attemptId, `${path}.attemptId`);
      positiveInteger(event.attempt, `${path}.attempt`);
      interruptReason(event.reason, `${path}.reason`);
      return;
    case 'HOST_START_DISPOSITION_RECORDED':
      exactKeys(event, ['type', 'disposition'], path);
      assertStartDisposition(event.disposition, `${path}.disposition`);
      return;
    case 'HOST_INTERRUPT_DISPOSITION_RECORDED':
      exactKeys(event, ['type', 'disposition'], path);
      assertInterruptDisposition(event.disposition, `${path}.disposition`);
      return;
    case 'HOST_TERMINAL_CONFIRMED':
      exactKeys(event, ['type', 'terminal'], path);
      assertHostTerminal(event.terminal, `${path}.terminal`);
      return;
    case 'HOST_EVIDENCE_LOST':
      exactKeys(event, ['type', 'hostReason'], path);
      oneOf(event.hostReason, HOST_EVIDENCE_REASONS, `${path}.hostReason`);
      return;
    default:
      fail(`${path}.type`, 'unknown invocation event');
  }
}

function assertPendingInterrupt(value: unknown, path: string): void {
  const item = record(value, path);
  exactKeys(item, ['attemptId', 'attempt', 'reason'], path);
  attemptId(item.attemptId, `${path}.attemptId`);
  positiveInteger(item.attempt, `${path}.attempt`);
  interruptReason(item.reason, `${path}.reason`);
}

function assertInterrupt(value: unknown, path: string, allowPendingStart: boolean): void {
  const item = record(value, path);
  const state = literalString(item.state, `${path}.state`);
  if (state === 'NONE') {
    exactKeys(item, ['state'], path);
  } else if (state === 'REQUESTED' || (allowPendingStart && state === 'PENDING_START')) {
    exactKeys(item, ['state', 'attemptId', 'attempt', 'reason'], path);
    attemptId(item.attemptId, `${path}.attemptId`);
    positiveInteger(item.attempt, `${path}.attempt`);
    interruptReason(item.reason, `${path}.reason`);
  } else if (state === 'SENT' || state === 'NOT_SENT') {
    exactKeys(item, ['state', 'attemptId', 'attempt', 'request'], path);
    attemptId(item.attemptId, `${path}.attemptId`);
    positiveInteger(item.attempt, `${path}.attempt`);
    assertInterruptRequest(item.request, `${path}.request`);
  } else if (state === 'TERMINAL_ALREADY_OBSERVED') {
    exactKeys(item, ['state', 'attemptId', 'attempt', 'reason'], path);
    attemptId(item.attemptId, `${path}.attemptId`);
    positiveInteger(item.attempt, `${path}.attempt`);
    interruptReason(item.reason, `${path}.reason`);
  } else {
    fail(`${path}.state`, 'unknown interrupt state');
  }
}

function assertTerminal(value: unknown, path: string): void {
  const terminal = record(value, path);
  const outcome = literalString(terminal.outcome, `${path}.outcome`);
  const source = literalString(terminal.source, `${path}.source`);
  if (source === 'HOST' && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(outcome)) {
    exactKeys(terminal, ['outcome', 'source', 'startAttemptId', 'interrupt', 'host'], path);
    attemptId(terminal.startAttemptId, `${path}.startAttemptId`);
    assertInterrupt(terminal.interrupt, `${path}.interrupt`, false);
    assertHostTerminal(terminal.host, `${path}.host`);
    if (record(terminal.host, `${path}.host`).outcome !== outcome) {
      fail(`${path}.host.outcome`, 'does not match terminal outcome');
    }
  } else if (source === 'START_REJECTED' && outcome === 'FAILED') {
    exactKeys(terminal, ['outcome', 'source', 'reason', 'startAttemptId'], path);
    oneOf(terminal.reason, START_FAILURE_REASONS, `${path}.reason`);
    attemptId(terminal.startAttemptId, `${path}.startAttemptId`);
  } else if (source === 'PROVED_NOT_DISPATCHED' && outcome === 'CANCELLED') {
    exactKeys(terminal, ['outcome', 'source', 'proof', 'startAttemptId'], path);
    oneOf(
      terminal.proof,
      new Set(['NO_DISPATCH_INTENT', 'HOST_START_PROVED_NOT_SENT']),
      `${path}.proof`,
    );
    if (terminal.startAttemptId !== null)
      attemptId(terminal.startAttemptId, `${path}.startAttemptId`);
    if (terminal.proof === 'HOST_START_PROVED_NOT_SENT' && terminal.startAttemptId === null) {
      fail(`${path}.startAttemptId`, 'is required for Host start proof');
    }
  } else if (source === 'EVIDENCE_LOST' && outcome === 'UNCERTAIN') {
    exactKeys(terminal, ['outcome', 'source', 'reason', 'hostReason', 'context'], path);
    oneOf(terminal.reason, UNCERTAIN_REASONS, `${path}.reason`);
    if (terminal.hostReason !== null) {
      oneOf(terminal.hostReason, HOST_EVIDENCE_REASONS, `${path}.hostReason`);
    }
    assertUncertainContext(terminal.context, `${path}.context`);
  } else {
    fail(path, 'contains an invalid Worker terminal');
  }
}

function assertUncertainContext(value: unknown, path: string): void {
  const context = record(value, path);
  exactKeys(
    context,
    ['startAttemptId', 'binding', 'interrupt', 'observedInterruptedTerminal'],
    path,
  );
  attemptId(context.startAttemptId, `${path}.startAttemptId`);
  if (context.binding !== null) assertBinding(context.binding, `${path}.binding`);
  assertInterrupt(context.interrupt, `${path}.interrupt`, true);
  if (context.observedInterruptedTerminal !== null) {
    assertInterruptedTerminal(
      context.observedInterruptedTerminal,
      `${path}.observedInterruptedTerminal`,
    );
  }
}

function assertStartDisposition(value: unknown, path: string): void {
  const disposition = record(value, path);
  const kind = literalString(disposition.disposition, `${path}.disposition`);
  if (kind === 'STARTED') {
    exactKeys(disposition, ['disposition', 'attemptId', 'binding'], path);
    assertBinding(disposition.binding, `${path}.binding`);
  } else if (kind === 'NOT_STARTED') {
    exactKeys(disposition, ['disposition', 'attemptId', 'reason'], path);
    oneOf(disposition.reason, START_FAILURE_REASONS, `${path}.reason`);
  } else if (kind === 'EVIDENCE_LOST') {
    exactKeys(disposition, ['disposition', 'attemptId', 'hostReason'], path);
    oneOf(disposition.hostReason, HOST_EVIDENCE_REASONS, `${path}.hostReason`);
  } else {
    fail(`${path}.disposition`, 'unknown Host start disposition');
  }
  attemptId(disposition.attemptId, `${path}.attemptId`);
}

function assertInterruptDisposition(value: unknown, path: string): void {
  const disposition = record(value, path);
  const kind = literalString(disposition.disposition, `${path}.disposition`);
  if (kind === 'SENT' || kind === 'NOT_SENT') {
    exactKeys(disposition, ['disposition', 'attemptId', 'attempt', 'request'], path);
    assertInterruptRequest(disposition.request, `${path}.request`);
  } else if (kind === 'TERMINAL_ALREADY_OBSERVED') {
    exactKeys(disposition, ['disposition', 'attemptId', 'attempt', 'binding'], path);
    assertBinding(disposition.binding, `${path}.binding`);
  } else {
    fail(`${path}.disposition`, 'unknown Host interrupt disposition');
  }
  attemptId(disposition.attemptId, `${path}.attemptId`);
  positiveInteger(disposition.attempt, `${path}.attempt`);
}

function assertInterruptedTerminal(value: unknown, path: string): void {
  const terminal = record(value, path);
  assertHostTerminal(terminal, path);
  if (
    terminal.outcome !== 'CANCELLED' &&
    !(terminal.outcome === 'FAILED' && terminal.errorCode === 'TURN_TIMEOUT')
  ) {
    fail(`${path}.outcome`, 'must be an interrupted terminal');
  }
}

function assertHostTerminal(value: unknown, path: string): void {
  const terminal = record(value, path);
  const outcome = literalString(terminal.outcome, `${path}.outcome`);
  if (outcome === 'SUCCEEDED') {
    exactKeys(
      terminal,
      [
        'outcome',
        'binding',
        'terminalFingerprint',
        'resultFingerprint',
        'sealedResult',
        'interruptRequest',
      ],
      path,
    );
    fingerprint(terminal.resultFingerprint, `${path}.resultFingerprint`);
    assertSealedResult(terminal.sealedResult, `${path}.sealedResult`);
    if (terminal.interruptRequest !== null) fail(`${path}.interruptRequest`, 'must be null');
  } else if (outcome === 'FAILED') {
    exactKeys(
      terminal,
      ['outcome', 'binding', 'terminalFingerprint', 'errorCode', 'interruptRequest'],
      path,
    );
    if (terminal.errorCode === 'TURN_FAILED') {
      if (terminal.interruptRequest !== null) fail(`${path}.interruptRequest`, 'must be null');
    } else if (terminal.errorCode === 'TURN_TIMEOUT') {
      assertInterruptRequest(terminal.interruptRequest, `${path}.interruptRequest`, 'TIMEOUT');
    } else {
      fail(`${path}.errorCode`, 'unknown Host failure');
    }
  } else if (outcome === 'CANCELLED') {
    exactKeys(terminal, ['outcome', 'binding', 'terminalFingerprint', 'interruptRequest'], path);
    assertInterruptRequest(terminal.interruptRequest, `${path}.interruptRequest`, 'USER_CANCEL');
  } else {
    fail(`${path}.outcome`, 'unknown Host terminal');
  }
  assertBinding(terminal.binding, `${path}.binding`);
  fingerprint(terminal.terminalFingerprint, `${path}.terminalFingerprint`);
}

function assertSealedResult(value: unknown, path: string): void {
  const receipt = record(value, path);
  exactKeys(receipt, ['sealedResultId', 'resultFingerprint', 'sealedFingerprint'], path);
  runtimeId(receipt.sealedResultId, `${path}.sealedResultId`);
  fingerprint(receipt.resultFingerprint, `${path}.resultFingerprint`);
  fingerprint(receipt.sealedFingerprint, `${path}.sealedFingerprint`);
}

function assertInterruptRequest(value: unknown, path: string, reason?: string): void {
  const request = record(value, path);
  exactKeys(request, ['requestId', 'reason', 'binding'], path);
  runtimeId(request.requestId, `${path}.requestId`);
  interruptReason(request.reason, `${path}.reason`);
  if (reason !== undefined && request.reason !== reason)
    fail(`${path}.reason`, `must be ${reason}`);
  assertBinding(request.binding, `${path}.binding`);
}

function assertBinding(value: unknown, path: string): void {
  const binding = record(value, path);
  exactKeys(binding, ['thread', 'turnId'], path);
  runtimeId(binding.turnId, `${path}.turnId`);
  const thread = record(binding.thread, `${path}.thread`);
  exactKeys(thread, ['id', 'generation', 'workspaceRootsAcknowledged'], `${path}.thread`);
  runtimeId(thread.id, `${path}.thread.id`);
  nonnegativeInteger(thread.generation, `${path}.thread.generation`);
  if (thread.workspaceRootsAcknowledged !== true) {
    fail(`${path}.thread.workspaceRootsAcknowledged`, 'must be true');
  }
}

function record(value: unknown, path: string): Record<string, WorkerJsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  return value as Record<string, WorkerJsonValue>;
}

function exactKeys(
  value: Record<string, WorkerJsonValue>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(path, `must contain exactly: ${wanted.join(', ')}`);
  }
}

function literalString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  return value;
}

function runtimeId(value: unknown, path: string): void {
  if (typeof value !== 'string' || !RUNTIME_ID_PATTERN.test(value)) fail(path, 'is invalid');
}

function attemptId(value: unknown, path: string): void {
  runtimeId(value, path);
}

function fingerprint(value: unknown, path: string): void {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(path, 'is not sha256');
}

function interruptReason(value: unknown, path: string): void {
  oneOf(value, new Set(['USER_CANCEL', 'TIMEOUT']), path);
}

function oneOf(value: unknown, allowed: ReadonlySet<string>, path: string): void {
  if (typeof value !== 'string' || !allowed.has(value)) fail(path, 'has an unknown value');
}

function positiveInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(path, 'must be positive integer');
}

function nonnegativeInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(path, 'must be nonnegative integer');
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}.`);
}
