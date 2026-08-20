import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// This fixture oracle is intentionally standalone. It does not import the
// production reducer or any list from src/reconciliation.ts.
const CLOUD_STATES = [
  'ACCEPTED',
  'QUEUED',
  'DISPATCH_PENDING',
  'PERSISTED',
  'STARTING',
  'RUNNING',
  'CANCEL_REQUESTED',
  'RECONCILING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'UNCERTAIN',
  'EXPIRED',
];
const LOCAL_STATES = [
  'MISSING',
  'RECEIVED',
  'PREPARED',
  'STARTING',
  'RUNNING',
  'FINAL_READY',
  'CLOUD_COMMITTED',
  'FAILED',
  'CANCELLED',
  'UNCERTAIN',
];
const HOST_EVIDENCE = [
  'PROVEN_NOT_DISPATCHED',
  'RUNNING_EXACT_TURN',
  'COMPLETED_EXACT_FINAL',
  'FAILED_CONFIRMED',
  'INTERRUPTED_CONFIRMED',
  'UNAVAILABLE',
];
const LEASE_STATES = ['CURRENT', 'STALE', 'REVOKED'];
const EXECUTION_CAPABILITY_STATES = ['VALID_FOR_INVOCATION', 'INVALID'];
const BINDING_DIGEST_STATES = [true, false];

const rows = [];
for (const cloudState of CLOUD_STATES) {
  for (const localState of LOCAL_STATES) {
    for (const hostEvidence of HOST_EVIDENCE) {
      for (const leaseState of LEASE_STATES) {
        for (const executionCapability of EXECUTION_CAPABILITY_STATES) {
          for (const bindingDigestsMatch of BINDING_DIGEST_STATES) {
            const evidence = {
              cloudState,
              localState,
              hostEvidence,
              leaseState,
              executionCapability,
              bindingDigestsMatch,
            };
            rows.push({
              id: `cloud=${cloudState}|local=${localState}|host=${hostEvidence}|lease=${leaseState}|capability=${executionCapability}|digests=${bindingDigestsMatch}`,
              ...evidence,
              ...independentDecision(evidence),
            });
          }
        }
      }
    }
  }
}

const output = `[\n${rows.map((row) => JSON.stringify(row)).join(',\n')}\n]\n`;
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../test-fixtures/reconciliation-golden.json');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) {
    throw new Error('reconciliation golden fixture does not match the independent oracle');
  }
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output, 'utf8');
}
process.stdout.write(
  `${rows.length} rows sha256=${createHash('sha256').update(output).digest('hex')}\n`,
);

function independentDecision(evidence) {
  if (!evidence.bindingDigestsMatch || evidence.executionCapability === 'INVALID') return block();
  if (isTerminalCloud(evidence.cloudState)) {
    return terminalContradicts(evidence) ? block() : outcome('NOOP_TERMINAL');
  }

  if (evidence.hostEvidence === 'RUNNING_EXACT_TURN') {
    return inSet(evidence.cloudState, ['STARTING', 'RUNNING', 'CANCEL_REQUESTED', 'RECONCILING']) &&
      inSet(evidence.localState, ['MISSING', 'STARTING', 'RUNNING'])
      ? outcome('RESUME_OBSERVATION')
      : block();
  }
  if (evidence.hostEvidence === 'COMPLETED_EXACT_FINAL') {
    return inSet(evidence.cloudState, ['STARTING', 'RUNNING', 'CANCEL_REQUESTED', 'RECONCILING']) &&
      inSet(evidence.localState, ['MISSING', 'STARTING', 'RUNNING', 'FINAL_READY'])
      ? outcome('SUBMIT_EXISTING_FINAL')
      : block();
  }
  if (evidence.hostEvidence === 'FAILED_CONFIRMED') {
    return inSet(evidence.cloudState, ['STARTING', 'RUNNING', 'CANCEL_REQUESTED', 'RECONCILING']) &&
      inSet(evidence.localState, ['MISSING', 'STARTING', 'RUNNING', 'FAILED'])
      ? outcome('MARK_FAILED')
      : block();
  }
  if (evidence.hostEvidence === 'INTERRUPTED_CONFIRMED') {
    return inSet(evidence.cloudState, ['CANCEL_REQUESTED', 'RECONCILING']) &&
      inSet(evidence.localState, ['MISSING', 'STARTING', 'RUNNING', 'CANCELLED'])
      ? outcome('MARK_CANCELLED')
      : block();
  }

  if (evidence.localState === 'FINAL_READY') {
    return inSet(evidence.cloudState, ['STARTING', 'RUNNING', 'CANCEL_REQUESTED', 'RECONCILING']) &&
      evidence.hostEvidence === 'UNAVAILABLE'
      ? outcome('SUBMIT_EXISTING_FINAL')
      : block();
  }
  if (evidence.localState === 'CLOUD_COMMITTED') return block();
  if (evidence.localState === 'FAILED') {
    return inSet(evidence.cloudState, [
      'PERSISTED',
      'STARTING',
      'RUNNING',
      'CANCEL_REQUESTED',
      'RECONCILING',
    ]) && inSet(evidence.hostEvidence, ['UNAVAILABLE', 'PROVEN_NOT_DISPATCHED'])
      ? outcome('MARK_FAILED')
      : block();
  }
  if (evidence.localState === 'CANCELLED') {
    return inSet(evidence.cloudState, ['CANCEL_REQUESTED', 'RECONCILING']) &&
      inSet(evidence.hostEvidence, ['UNAVAILABLE', 'PROVEN_NOT_DISPATCHED'])
      ? outcome('MARK_CANCELLED')
      : block();
  }
  if (evidence.localState === 'UNCERTAIN') {
    return inSet(evidence.cloudState, [
      'PERSISTED',
      'STARTING',
      'RUNNING',
      'CANCEL_REQUESTED',
      'RECONCILING',
    ]) && evidence.hostEvidence === 'UNAVAILABLE'
      ? outcome('MARK_UNCERTAIN')
      : block();
  }

  const prepareReplay =
    inSet(evidence.localState, ['MISSING', 'RECEIVED', 'PREPARED']) &&
    inSet(evidence.cloudState, ['QUEUED', 'DISPATCH_PENDING']) &&
    inSet(evidence.hostEvidence, ['UNAVAILABLE', 'PROVEN_NOT_DISPATCHED']);
  if (prepareReplay) {
    return evidence.leaseState === 'CURRENT' ? replay('invocation.prepare') : block();
  }

  if (evidence.hostEvidence === 'PROVEN_NOT_DISPATCHED') {
    const exactStart = evidence.cloudState === 'STARTING' && evidence.localState === 'STARTING';
    return exactStart && evidence.leaseState === 'CURRENT' ? replay('invocation.start') : block();
  }

  if (
    evidence.hostEvidence === 'UNAVAILABLE' &&
    evidence.localState === 'MISSING' &&
    inSet(evidence.cloudState, [
      'PERSISTED',
      'STARTING',
      'RUNNING',
      'CANCEL_REQUESTED',
      'RECONCILING',
    ])
  ) {
    return outcome('MARK_UNCERTAIN');
  }
  if (
    evidence.hostEvidence === 'UNAVAILABLE' &&
    inSet(evidence.localState, ['STARTING', 'RUNNING']) &&
    inSet(evidence.cloudState, ['STARTING', 'RUNNING', 'CANCEL_REQUESTED', 'RECONCILING'])
  ) {
    return outcome('MARK_UNCERTAIN');
  }
  return block();
}

function terminalContradicts(evidence) {
  if (evidence.cloudState === 'SUCCEEDED') {
    return (
      inSet(evidence.localState, ['FAILED', 'CANCELLED', 'UNCERTAIN']) ||
      inSet(evidence.hostEvidence, [
        'FAILED_CONFIRMED',
        'INTERRUPTED_CONFIRMED',
        'PROVEN_NOT_DISPATCHED',
      ])
    );
  }
  if (evidence.cloudState === 'FAILED') {
    return (
      inSet(evidence.localState, ['FINAL_READY', 'CLOUD_COMMITTED', 'CANCELLED']) ||
      inSet(evidence.hostEvidence, ['COMPLETED_EXACT_FINAL', 'INTERRUPTED_CONFIRMED'])
    );
  }
  if (evidence.cloudState === 'CANCELLED') {
    return (
      inSet(evidence.localState, ['FINAL_READY', 'CLOUD_COMMITTED', 'FAILED']) ||
      inSet(evidence.hostEvidence, ['COMPLETED_EXACT_FINAL', 'FAILED_CONFIRMED'])
    );
  }
  if (evidence.cloudState === 'UNCERTAIN') {
    return (
      inSet(evidence.localState, ['FINAL_READY', 'CLOUD_COMMITTED', 'FAILED', 'CANCELLED']) ||
      inSet(evidence.hostEvidence, [
        'RUNNING_EXACT_TURN',
        'COMPLETED_EXACT_FINAL',
        'FAILED_CONFIRMED',
        'INTERRUPTED_CONFIRMED',
      ])
    );
  }
  if (evidence.cloudState === 'EXPIRED') {
    return (
      inSet(evidence.localState, [
        'PREPARED',
        'STARTING',
        'RUNNING',
        'FINAL_READY',
        'CLOUD_COMMITTED',
        'FAILED',
        'CANCELLED',
        'UNCERTAIN',
      ]) ||
      inSet(evidence.hostEvidence, [
        'RUNNING_EXACT_TURN',
        'COMPLETED_EXACT_FINAL',
        'FAILED_CONFIRMED',
        'INTERRUPTED_CONFIRMED',
      ])
    );
  }
  return false;
}

function isTerminalCloud(state) {
  return inSet(state, ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED']);
}

function inSet(value, values) {
  return values.includes(value);
}

function outcome(decision) {
  return { decision, automaticInferenceAllowed: false };
}

function replay(replayCommand) {
  return { decision: 'REPLAY_COMMAND', automaticInferenceAllowed: true, replayCommand };
}

function block() {
  return outcome('SECURITY_BLOCK');
}
