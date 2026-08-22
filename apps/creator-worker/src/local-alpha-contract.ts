import { createHash } from 'node:crypto';

import { canonicalizeBrokerTransportJson } from '@cb/creator-agent-protocol/broker-transport';

export const LOCAL_ALPHA_RESULT_PROTOCOL = 'combo.creator-worker.local-result/1' as const;

export type LocalAlphaResultEnvelope = Readonly<{
  protocol: typeof LOCAL_ALPHA_RESULT_PROTOCOL;
  sealedResultId: string;
  resultFingerprint: string;
}>;

export type CreatorWorkerLocalAlphaDiagnostic =
  | 'broker_listening'
  | 'runtime_starting'
  | 'runtime_ready'
  | 'thread_ready'
  | 'turn_submitted'
  | 'terminal_committed'
  | 'stopping'
  | 'stopped';

export type CreatorWorkerLocalAlphaErrorCode =
  | 'LOCAL_ALPHA_CONFIGURATION_INVALID'
  | 'LOCAL_ALPHA_STATE_INCOMPLETE'
  | 'LOCAL_ALPHA_STATE_REUSE_UNSUPPORTED'
  | 'LOCAL_ALPHA_BROKER_FAILED'
  | 'LOCAL_ALPHA_COMMAND_ACK_TIMEOUT'
  | 'LOCAL_ALPHA_TURN_TIMEOUT'
  | 'LOCAL_ALPHA_TURN_FAILED'
  | 'LOCAL_ALPHA_TURN_CANCELLED'
  | 'LOCAL_ALPHA_TURN_UNCERTAIN'
  | 'LOCAL_ALPHA_STOP_INCOMPLETE';

export class CreatorWorkerLocalAlphaError extends Error {
  public constructor(
    public readonly code: CreatorWorkerLocalAlphaErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CreatorWorkerLocalAlphaError';
  }
}

export type CreatorWorkerLocalAlphaOptions = Readonly<{
  projectPath: string;
  prompt: string;
  stateDirectory: string;
  allowUnisolatedRead: true;
  allowLoopbackProxy?: boolean;
  turnTimeoutMs?: number;
  signal?: AbortSignal;
  diagnosticSink?: (event: CreatorWorkerLocalAlphaDiagnostic) => void;
}>;

export type CreatorWorkerLocalAlphaResult = Readonly<{
  invocationId: string;
  text: string;
}>;

export function localAlphaResultEnvelopeFingerprint(input: LocalAlphaResultEnvelope): string {
  return `sha256:${createHash('sha256')
    .update('combo.creator-worker.local-result-envelope/1')
    .update('\0')
    .update(canonicalizeBrokerTransportJson(input))
    .digest('hex')}`;
}
