import type { CreatorAgentLocalTurnOptions } from '../agent-local-contract.js';

export type AgentInvocationInput = Readonly<{
  projectPath: string;
  prompt: string;
  stateDirectory: string;
  allowUnisolatedRead: true;
  allowLoopbackProxy?: boolean;
  turnTimeoutMs: number;
  signal?: AbortSignal;
  diagnosticSink?: CreatorAgentLocalTurnOptions['diagnosticSink'];
}>;

export type AgentInvocationProfile = Readonly<{
  developerInstructions: string;
  executionBinding: string;
}>;

export type AgentInvocationResult = Readonly<{
  invocationId: string;
  text: string;
}>;

export type AgentExecutionDependencies = Readonly<{
  supportedCodexVersion: string;
  runInvocation(
    input: AgentInvocationInput,
    profile: AgentInvocationProfile,
  ): Promise<AgentInvocationResult>;
}>;
