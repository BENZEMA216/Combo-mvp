import type { CreatorAgentVersion } from '@cb/creator-agent-protocol/agent';

type CreatorAgentLocalDiagnostic =
  | 'broker_listening'
  | 'runtime_starting'
  | 'runtime_ready'
  | 'thread_ready'
  | 'turn_submitted'
  | 'terminal_committed'
  | 'stopping'
  | 'stopped';

export type CreatorAgentLocalErrorCode =
  | 'CREATOR_AGENT_VERSION_INVALID'
  | 'CREATOR_AGENT_PROJECT_MISMATCH'
  | 'CREATOR_AGENT_RUNTIME_UNSUPPORTED';

export class CreatorAgentLocalError extends Error {
  public constructor(
    public readonly code: CreatorAgentLocalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CreatorAgentLocalError';
  }
}

export type CreatorAgentLocalTurnOptions = Readonly<{
  version: CreatorAgentVersion;
  /** Required for Git-backed V1/V2; must be absent for behavior-only V3. */
  projectPath?: string;
  prompt: string;
  stateDirectory: string;
  allowUnisolatedRead: true;
  allowLoopbackProxy?: boolean;
  signal?: AbortSignal;
  diagnosticSink?: (event: CreatorAgentLocalDiagnostic) => void;
}>;

export type CreatorAgentLocalTurnResult = Readonly<{
  agentId: string;
  versionId: string;
  versionFingerprint: string;
  invocationId: string;
  text: string;
}>;
