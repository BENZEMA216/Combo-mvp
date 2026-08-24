import { randomUUID } from 'node:crypto';

import type { CreatorAgentVersion } from '@cb/creator-agent-protocol/agent';

import {
  startCreatorAgentPackageSessionWithDependencies,
  type CreatorAgentPackageSession,
  type CreatorAgentPackageSessionOptions,
} from './agent-package-session.js';
import {
  compileCreatorAgentProjectWithDependencies,
  revalidateProjectContext,
  scanProjectContext,
  type CreatorAgentProjectCompilationOptions,
  type CreatorAgentProjectCompilationResult,
} from '../authoring/index.js';
import {
  assertCreatorAgentVersionRunnableForRuntime,
  compileCreatorAgentDeveloperInstructionsForRuntime,
  executeCreatorAgentLocalTurn,
  type AgentExecutionDependencies,
} from '../execution/index.js';
import type {
  CreatorAgentLocalTurnOptions,
  CreatorAgentLocalTurnResult,
} from '../agent-local-contract.js';
import { createLocalAlphaBroker } from '../local-alpha-broker.js';
import { loadCreatorAgentPackage } from '../infrastructure/agent-package-loader.js';
import {
  runCreatorWorkerLocalAlphaWithDependencies,
  type LocalAlphaDependencies,
} from '../local-alpha-runner.js';
import {
  createBundledCodexHost,
  createBundledCodexAgentPackageHost,
  createBundledCodexStructuredHost,
  SUPPORTED_BUNDLED_CODEX_VERSION,
} from '../infrastructure/codex/index.js';

const productionInvocationDependencies: LocalAlphaDependencies = Object.freeze({
  createHost: createBundledCodexHost,
  createBroker: createLocalAlphaBroker,
});

const productionAgentPackageDependencies = Object.freeze({
  loadPackage: loadCreatorAgentPackage,
  createHost: createBundledCodexAgentPackageHost,
  randomId: randomUUID,
});

const runtimePreflight = Object.freeze({
  supportedCodexVersion: SUPPORTED_BUNDLED_CODEX_VERSION,
  assertRunnable(projectPath: string, version: CreatorAgentVersion): void {
    assertCreatorAgentVersionRunnableForRuntime(
      projectPath,
      version,
      SUPPORTED_BUNDLED_CODEX_VERSION,
    );
  },
});

const productionCompilerDependencies = Object.freeze({
  scanProject: scanProjectContext,
  revalidateProject: revalidateProjectContext,
  createHost: createBundledCodexStructuredHost,
  runtimePreflight,
  randomId: randomUUID,
});

export function compileCreatorAgentProject(
  options: CreatorAgentProjectCompilationOptions,
): Promise<CreatorAgentProjectCompilationResult> {
  return compileCreatorAgentProjectWithDependencies(options, productionCompilerDependencies);
}

export function runCreatorAgentLocalTurn(
  options: CreatorAgentLocalTurnOptions,
): Promise<CreatorAgentLocalTurnResult> {
  return executeCreatorAgentLocalTurn(
    options,
    executionDependencies(productionInvocationDependencies),
  );
}

export function startCreatorAgentPackageSession(
  options: CreatorAgentPackageSessionOptions,
): Promise<CreatorAgentPackageSession> {
  return startCreatorAgentPackageSessionWithDependencies(
    options,
    productionAgentPackageDependencies,
  );
}

/** Internal integration seam; intentionally absent from the package root export. */
export function runCreatorAgentLocalTurnWithDependencies(
  options: CreatorAgentLocalTurnOptions,
  dependencies: LocalAlphaDependencies,
): Promise<CreatorAgentLocalTurnResult> {
  return executeCreatorAgentLocalTurn(options, executionDependencies(dependencies));
}

export function compileCreatorAgentDeveloperInstructions(input: unknown): string {
  return compileCreatorAgentDeveloperInstructionsForRuntime(input, SUPPORTED_BUNDLED_CODEX_VERSION);
}

/** Internal authoring adapter; intentionally absent from the package root export. */
export function assertCreatorAgentVersionRunnable(projectPath: string, input: unknown): void {
  assertCreatorAgentVersionRunnableForRuntime(projectPath, input, SUPPORTED_BUNDLED_CODEX_VERSION);
}

function executionDependencies(dependencies: LocalAlphaDependencies): AgentExecutionDependencies {
  return Object.freeze({
    supportedCodexVersion: SUPPORTED_BUNDLED_CODEX_VERSION,
    runInvocation: (input, profile) =>
      runCreatorWorkerLocalAlphaWithDependencies(input, dependencies, profile),
  });
}
