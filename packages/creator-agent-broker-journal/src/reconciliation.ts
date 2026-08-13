import { isTerminalInvocationState, type InvocationState } from './invocation.js';
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
}

/**
 * Pure golden reducer for cross-journal reconciliation. It never returns a
 * second-inference action after dispatch is possible; UNKNOWN becomes UNCERTAIN.
 */
export function reconcileInvocation(evidence: ReconciliationEvidence): ReconciliationResult {
  if (!evidence.bindingDigestsMatch) {
    return decision('SECURITY_BLOCK', false, 'binding_digest_mismatch');
  }
  if (isTerminalInvocationState(evidence.cloudState)) {
    return decision('NOOP_TERMINAL', false, 'cloud_terminal_is_authoritative');
  }
  if (evidence.executionCapability === 'INVALID') {
    return decision('SECURITY_BLOCK', false, 'execution_capability_invalid');
  }

  if (evidence.localState === 'FINAL_READY' || evidence.localState === 'CLOUD_COMMITTED') {
    return decision('SUBMIT_EXISTING_FINAL', false, 'local_exact_final_is_durable');
  }
  if (evidence.localState === 'FAILED' || evidence.hostEvidence === 'FAILED_CONFIRMED') {
    return decision('MARK_FAILED', false, 'failure_is_confirmed');
  }
  if (evidence.localState === 'CANCELLED' || evidence.hostEvidence === 'INTERRUPTED_CONFIRMED') {
    return decision('MARK_CANCELLED', false, 'interrupt_is_confirmed');
  }
  if (evidence.localState === 'UNCERTAIN') {
    return decision('MARK_UNCERTAIN', false, 'worker_already_recorded_uncertain');
  }

  const beforePrepareCommit =
    evidence.localState === 'MISSING' || evidence.localState === 'RECEIVED';
  if (beforePrepareCommit) {
    if (evidence.leaseState !== 'CURRENT') {
      return decision('SECURITY_BLOCK', false, 'stale_worker_cannot_receive_or_start_work');
    }
    if (evidence.cloudState === 'QUEUED' || evidence.cloudState === 'DISPATCH_PENDING') {
      return decision('REPLAY_COMMAND', true, 'both_journals_prove_pre_dispatch');
    }
    return decision(
      'MARK_UNCERTAIN',
      false,
      'cloud_has_persisted_or_dispatch_evidence_but_local_journal_is_missing',
    );
  }

  if (evidence.localState === 'PREPARED') {
    if (evidence.leaseState !== 'CURRENT') {
      return decision('SECURITY_BLOCK', false, 'stale_worker_cannot_start_prepared_work');
    }
    if (
      evidence.cloudState === 'QUEUED' ||
      evidence.cloudState === 'DISPATCH_PENDING' ||
      evidence.cloudState === 'PERSISTED'
    ) {
      return decision('REPLAY_COMMAND', true, 'durable_prepare_proves_pre_dispatch');
    }
    return decision('MARK_UNCERTAIN', false, 'cloud_claims_post_dispatch_without_host_evidence');
  }

  if (evidence.hostEvidence === 'RUNNING_EXACT_TURN') {
    return decision('RESUME_OBSERVATION', false, 'exact_host_turn_is_queryable');
  }
  if (evidence.hostEvidence === 'COMPLETED_EXACT_FINAL') {
    return decision('SUBMIT_EXISTING_FINAL', false, 'host_completed_final_can_be_durably_imported');
  }
  if (evidence.hostEvidence === 'PROVEN_NOT_DISPATCHED') {
    if (evidence.leaseState !== 'CURRENT') {
      return decision('SECURITY_BLOCK', false, 'stale_worker_cannot_cross_dispatch_boundary');
    }
    return decision('REPLAY_COMMAND', true, 'independent_host_receipt_proves_no_dispatch');
  }
  return decision(
    'MARK_UNCERTAIN',
    false,
    'dispatch_may_have_happened_but_evidence_is_unavailable',
  );
}

function decision(
  value: ReconciliationDecision,
  automaticInferenceAllowed: boolean,
  reason: string,
): ReconciliationResult {
  return { decision: value, automaticInferenceAllowed, reason };
}
