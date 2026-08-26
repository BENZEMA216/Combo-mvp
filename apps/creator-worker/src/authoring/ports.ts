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
