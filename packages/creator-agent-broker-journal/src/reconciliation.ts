import { isTerminalInvocationState, type InvocationState } from './invocation.js';
import type { CloudInvocation, CloudUncertaintyReason } from './cloud-journal.js';
import type { LocalInvocationState } from './worker-journal.js';

export const RECONCILIATION_DECISIONS = [
  'REPLAY_COMMAND',
  'RESUME_OBSERVATION',
  'SUBMIT_EXISTING_FINAL',
  'MARK_FAILED',
  'MARK_CANCELLED',
  'MARK_UNCERTAIN',
  'SECURITY_BLOCK',
  'NOOP_TERMINAL',
] as const;

export type ReconciliationDecision = (typeof RECONCILIATION_DECISIONS)[number];

export type LocalEvidenceState = LocalInvocationState | 'MISSING';
export type HostEvidence =
  | 'PROVEN_NOT_DISPATCHED'
  | 'RUNNING_EXACT_TURN'
  | 'COMPLETED_EXACT_FINAL'
  | 'FAILED_CONFIRMED'
  | 'INTERRUPTED_CONFIRMED'
  | 'UNAVAILABLE';

export interface ReconciliationEvidence {
  readonly cloudState: InvocationState;
  readonly localState: LocalEvidenceState;
  readonly hostEvidence: HostEvidence;
  readonly leaseState: 'CURRENT' | 'STALE' | 'REVOKED';
  readonly executionCapability: 'VALID_FOR_INVOCATION' | 'INVALID';
  readonly bindingDigestsMatch: boolean;
}

export interface ReconciliationResult {
  readonly decision: ReconciliationDecision;
  readonly automaticInferenceAllowed: boolean;
  readonly reason: string;
  readonly replayCommand?: 'invocation.prepare' | 'invocation.start';
}

export interface ReconciliationMutationPort {
  markUncertain(input: {
    invocationId: string;
    sourceEventId: string;
    reason: CloudUncertaintyReason;
  }): CloudInvocation;
}

export interface AppliedReconciliationResult {
  readonly result: ReconciliationResult;
  readonly cloudState: InvocationState;
  readonly mutationApplied: boolean;
}

/**
 * Applies only authoritative journal mutations. Replay/observation/submission
 * remain explicit caller actions; MARK_UNCERTAIN is durably reduced through
 * the Cloud Journal and the shared Invocation transition state machine.
 */
export function applyReconciliationDecision(
  journal: ReconciliationMutationPort,
  input: {
    readonly invocationId: string;
    readonly sourceEventId: string;
    readonly uncertaintyReason: CloudUncertaintyReason;
    readonly evidence: ReconciliationEvidence;
  },
): AppliedReconciliationResult {
  const result = reconcileInvocation(input.evidence);
  if (result.decision !== 'MARK_UNCERTAIN') {
    return { result, cloudState: input.evidence.cloudState, mutationApplied: false };
  }
  const invocation = journal.markUncertain({
    invocationId: input.invocationId,
    sourceEventId: input.sourceEventId,
    reason: input.uncertaintyReason,
  });
  return { result, cloudState: invocation.state, mutationApplied: true };
}

/**
 * Pure golden reducer for cross-journal reconciliation. It never returns a
 * second-inference action after dispatch is possible; UNKNOWN becomes UNCERTAIN.
 */
export function reconcileInvocation(evidence: ReconciliationEvidence): ReconciliationResult {
  if (!evidence.bindingDigestsMatch) {
    return decision('SECURITY_BLOCK', false, 'binding_digest_mismatch');
  }
  if (evidence.executionCapability === 'INVALID') {
    return decision('SECURITY_BLOCK', false, 'execution_capability_invalid');
  }

  if (isTerminalInvocationState(evidence.cloudState)) {
    if (terminalEvidenceContradicts(evidence)) {
      return decision('SECURITY_BLOCK', false, 'cloud_terminal_conflicts_with_other_evidence');
    }
    return decision('NOOP_TERMINAL', false, 'cloud_terminal_is_authoritative');
  }

  if (evidence.hostEvidence === 'RUNNING_EXACT_TURN') {
    if (
      includesCloud(evidence.cloudState, [
        'STARTING',
        'RUNNING',
        'CANCEL_REQUESTED',
        'RECONCILING',
      ]) &&
      includesLocal(evidence.localState, ['MISSING', 'STARTING', 'RUNNING'])
    ) {
      return decision('RESUME_OBSERVATION', false, 'exact_host_turn_is_queryable');
    }
    return decision('SECURITY_BLOCK', false, 'host_running_conflicts_with_journals');
  }
  if (evidence.hostEvidence === 'COMPLETED_EXACT_FINAL') {
    if (
      includesCloud(evidence.cloudState, [
        'STARTING',
        'RUNNING',
        'CANCEL_REQUESTED',
        'RECONCILING',
      ]) &&
      includesLocal(evidence.localState, ['MISSING', 'STARTING', 'RUNNING', 'FINAL_READY'])
    ) {
      return decision(
        'SUBMIT_EXISTING_FINAL',
        false,
        'host_completed_final_can_be_durably_imported',
      );
    }
    return decision('SECURITY_BLOCK', false, 'host_final_conflicts_with_journals');
  }
  if (evidence.hostEvidence === 'FAILED_CONFIRMED') {
    if (
      includesCloud(evidence.cloudState, [
        'STARTING',
        'RUNNING',
        'CANCEL_REQUESTED',
        'RECONCILING',
      ]) &&
      includesLocal(evidence.localState, ['MISSING', 'STARTING', 'RUNNING', 'FAILED'])
    ) {
      return decision('MARK_FAILED', false, 'failure_is_confirmed');
    }
    return decision('SECURITY_BLOCK', false, 'host_failure_conflicts_with_journals');
  }
  if (evidence.hostEvidence === 'INTERRUPTED_CONFIRMED') {
    if (
      includesCloud(evidence.cloudState, ['CANCEL_REQUESTED', 'RECONCILING']) &&
      includesLocal(evidence.localState, ['MISSING', 'STARTING', 'RUNNING', 'CANCELLED'])
    ) {
      return decision('MARK_CANCELLED', false, 'interrupt_is_confirmed');
    }
    return decision('SECURITY_BLOCK', false, 'host_interrupt_conflicts_with_journals');
  }

  if (evidence.localState === 'FINAL_READY') {
    if (
      includesCloud(evidence.cloudState, [
        'STARTING',
        'RUNNING',
        'CANCEL_REQUESTED',
        'RECONCILING',
      ]) &&
      evidence.hostEvidence === 'UNAVAILABLE'
    ) {
      return decision('SUBMIT_EXISTING_FINAL', false, 'local_exact_final_is_durable');
    }
    return decision('SECURITY_BLOCK', false, 'local_final_conflicts_with_cloud_or_host');
  }
  if (evidence.localState === 'CLOUD_COMMITTED') {
    return decision('SECURITY_BLOCK', false, 'local_cloud_commit_conflicts_with_nonterminal_cloud');
  }
  if (evidence.localState === 'FAILED') {
    if (
      includesCloud(evidence.cloudState, [
        'PERSISTED',
        'STARTING',
        'RUNNING',
        'CANCEL_REQUESTED',
        'RECONCILING',
      ]) &&
      (evidence.hostEvidence === 'UNAVAILABLE' || evidence.hostEvidence === 'PROVEN_NOT_DISPATCHED')
    ) {
      return decision('MARK_FAILED', false, 'failure_is_confirmed');
    }
    return decision('SECURITY_BLOCK', false, 'local_failure_conflicts_with_cloud_or_host');
  }
  if (evidence.localState === 'CANCELLED') {
    if (
      includesCloud(evidence.cloudState, ['CANCEL_REQUESTED', 'RECONCILING']) &&
      (evidence.hostEvidence === 'UNAVAILABLE' || evidence.hostEvidence === 'PROVEN_NOT_DISPATCHED')
    ) {
      return decision('MARK_CANCELLED', false, 'interrupt_is_confirmed');
    }
    return decision('SECURITY_BLOCK', false, 'local_cancel_conflicts_with_cloud_or_host');
  }
  if (evidence.localState === 'UNCERTAIN') {
    if (
      includesCloud(evidence.cloudState, [
        'PERSISTED',
        'STARTING',
        'RUNNING',
        'CANCEL_REQUESTED',
        'RECONCILING',
      ]) &&
      evidence.hostEvidence === 'UNAVAILABLE'
    ) {
      return decision('MARK_UNCERTAIN', false, 'worker_already_recorded_uncertain');
    }
    return decision('SECURITY_BLOCK', false, 'local_uncertain_conflicts_with_cloud_or_host');
  }

  const replayablePrepareLocal = includesLocal(evidence.localState, [
    'MISSING',
    'RECEIVED',
    'PREPARED',
  ]);
  if (
    replayablePrepareLocal &&
    includesCloud(evidence.cloudState, ['QUEUED', 'DISPATCH_PENDING']) &&
    (evidence.hostEvidence === 'UNAVAILABLE' || evidence.hostEvidence === 'PROVEN_NOT_DISPATCHED')
  ) {
    if (evidence.leaseState !== 'CURRENT') {
      return decision('SECURITY_BLOCK', false, 'stale_worker_cannot_receive_prepare_replay');
    }
    return replay('invocation.prepare', 'both_journals_prove_prepare_is_replayable');
  }

  if (evidence.hostEvidence === 'PROVEN_NOT_DISPATCHED') {
    const exactStartReplay =
      evidence.cloudState === 'STARTING' && evidence.localState === 'STARTING';
    if (!exactStartReplay) {
      return decision('SECURITY_BLOCK', false, 'host_no_dispatch_conflicts_with_journals');
    }
    if (evidence.leaseState !== 'CURRENT') {
      return decision('SECURITY_BLOCK', false, 'stale_worker_cannot_cross_dispatch_boundary');
    }
    return replay('invocation.start', 'independent_host_receipt_proves_start_not_dispatched');
  }

  if (
    evidence.hostEvidence === 'UNAVAILABLE' &&
    evidence.localState === 'MISSING' &&
    includesCloud(evidence.cloudState, [
      'PERSISTED',
      'STARTING',
      'RUNNING',
      'CANCEL_REQUESTED',
      'RECONCILING',
    ])
  ) {
    return decision(
      'MARK_UNCERTAIN',
      false,
      'cloud_dispatch_evidence_survived_but_local_journal_is_missing',
    );
  }
  if (
    evidence.hostEvidence === 'UNAVAILABLE' &&
    includesLocal(evidence.localState, ['STARTING', 'RUNNING']) &&
    includesCloud(evidence.cloudState, ['STARTING', 'RUNNING', 'CANCEL_REQUESTED', 'RECONCILING'])
  ) {
    return decision(
      'MARK_UNCERTAIN',
      false,
      'dispatch_may_have_happened_but_evidence_is_unavailable',
    );
  }
  return decision('SECURITY_BLOCK', false, 'journal_host_state_combination_is_impossible');
}

function includesCloud(state: InvocationState, states: readonly InvocationState[]): boolean {
  return states.includes(state);
}

function includesLocal(state: LocalEvidenceState, states: readonly LocalEvidenceState[]): boolean {
  return states.includes(state);
}

function decision(
  value: ReconciliationDecision,
  automaticInferenceAllowed: boolean,
  reason: string,
): ReconciliationResult {
  return { decision: value, automaticInferenceAllowed, reason };
}

function replay(
  replayCommand: 'invocation.prepare' | 'invocation.start',
  reason: string,
): ReconciliationResult {
  return {
    decision: 'REPLAY_COMMAND',
    automaticInferenceAllowed: true,
    replayCommand,
    reason,
  };
}

function terminalEvidenceContradicts(evidence: ReconciliationEvidence): boolean {
  if (
    evidence.cloudState === 'SUCCEEDED' &&
    (evidence.localState === 'FAILED' ||
      evidence.localState === 'CANCELLED' ||
      evidence.localState === 'UNCERTAIN' ||
      evidence.hostEvidence === 'FAILED_CONFIRMED' ||
      evidence.hostEvidence === 'INTERRUPTED_CONFIRMED' ||
      evidence.hostEvidence === 'PROVEN_NOT_DISPATCHED')
  ) {
    return true;
  }
  if (
    evidence.cloudState === 'FAILED' &&
    (evidence.localState === 'FINAL_READY' ||
      evidence.localState === 'CLOUD_COMMITTED' ||
      evidence.localState === 'CANCELLED' ||
      evidence.hostEvidence === 'COMPLETED_EXACT_FINAL' ||
      evidence.hostEvidence === 'INTERRUPTED_CONFIRMED')
  ) {
    return true;
  }
  if (
    evidence.cloudState === 'CANCELLED' &&
    (evidence.localState === 'FINAL_READY' ||
      evidence.localState === 'CLOUD_COMMITTED' ||
      evidence.localState === 'FAILED' ||
      evidence.hostEvidence === 'COMPLETED_EXACT_FINAL' ||
      evidence.hostEvidence === 'FAILED_CONFIRMED')
  ) {
    return true;
  }
  if (
    evidence.cloudState === 'UNCERTAIN' &&
    (evidence.localState === 'FINAL_READY' ||
      evidence.localState === 'CLOUD_COMMITTED' ||
      evidence.localState === 'FAILED' ||
      evidence.localState === 'CANCELLED' ||
      evidence.hostEvidence === 'RUNNING_EXACT_TURN' ||
      evidence.hostEvidence === 'COMPLETED_EXACT_FINAL' ||
      evidence.hostEvidence === 'FAILED_CONFIRMED' ||
      evidence.hostEvidence === 'INTERRUPTED_CONFIRMED')
  ) {
    return true;
  }
  if (
    evidence.cloudState === 'EXPIRED' &&
    (includesLocal(evidence.localState, [
      'PREPARED',
      'STARTING',
      'RUNNING',
      'FINAL_READY',
      'CLOUD_COMMITTED',
      'FAILED',
      'CANCELLED',
      'UNCERTAIN',
    ]) ||
      evidence.hostEvidence === 'RUNNING_EXACT_TURN' ||
      evidence.hostEvidence === 'COMPLETED_EXACT_FINAL' ||
      evidence.hostEvidence === 'FAILED_CONFIRMED' ||
      evidence.hostEvidence === 'INTERRUPTED_CONFIRMED')
  ) {
    return true;
  }
  return false;
}
