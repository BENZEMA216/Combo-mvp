import type { CreatorAgentVersion } from '@cb/creator-agent-protocol/agent';
import type { CreatorHost } from '@cb/creator-agent-protocol/host';

export type StructuredAuthoringHostOptions = Readonly<{
  projectPath: string;
  developerInstructions: string;
  allowUnisolatedRead: true;
  allowLoopbackProxy?: boolean;
  rpcTimeoutMs?: number;
  processTerminationGraceMs?: number;
}>;

export type StructuredAuthoringHostPort = (
  options: StructuredAuthoringHostOptions,
  outputSchema: unknown,
) => CreatorHost;

export type VersionExecutionPreflightPort = Readonly<{
  supportedCodexVersion: string;
  assertRunnable(projectPath: string, version: CreatorAgentVersion): void;
}>;
