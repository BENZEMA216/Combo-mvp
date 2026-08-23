import type { CreatorAgentVersionV1 } from '@cb/creator-agent-protocol/agent';

import type { CreatorWorkerLocalAlphaDiagnostic } from './local-alpha-contract.js';

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
  version: CreatorAgentVersionV1;
  projectPath: string;
  prompt: string;
  stateDirectory: string;
  allowUnisolatedRead: true;
  allowLoopbackProxy?: boolean;
  signal?: AbortSignal;
  diagnosticSink?: (event: CreatorWorkerLocalAlphaDiagnostic) => void;
}>;

export type CreatorAgentLocalTurnResult = Readonly<{
  agentId: string;
  versionId: string;
  versionFingerprint: string;
  invocationId: string;
  text: string;
}>;
