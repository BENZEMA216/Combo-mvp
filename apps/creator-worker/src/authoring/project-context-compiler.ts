import {
  CREATOR_AGENT_DEFINITION_V2_PROTOCOL,
  CREATOR_AGENT_DEFINITION_V3_PROTOCOL,
  createCreatorAgentDefinitionV2,
  createCreatorAgentDefinitionV3,
  createCreatorAgentDraftHandoffV2,
  createCreatorAgentDraftHandoffV3,
  createCreatorAgentDraftSnapshotV2,
  createCreatorAgentDraftSnapshotV3,
  createCreatorAgentProjectSourceLedger,
  freezeCreatorAgentVersionV2,
  freezeCreatorAgentVersionV3,
  serializeCreatorAgentDraftHandoffAny,
  type CreatorAgentDraftHandoff,
  type CreatorAgentDraftSnapshot,
  type CreatorAgentVersion,
} from '@cb/creator-agent-protocol/agent';

import {
  CreatorAgentProjectCompilerError,
  extractCreatorAgentProjectBehaviorWithDependencies,
  type CreatorAgentProjectBehaviorDependencies,
  type CreatorAgentProjectBehaviorExtraction,
  type CreatorAgentProjectCompilationOptions,
  type CreatorAgentProjectCompilerErrorCode,
} from './project-behavior-extractor.js';

export {
  PROJECT_COMPILER_OUTPUT_SCHEMA,
  CreatorAgentProjectCompilerError,
  extractCreatorAgentProjectBehaviorWithDependencies,
} from './project-behavior-extractor.js';
export type {
  CreatorAgentProjectBehavior,
  CreatorAgentProjectBehaviorDependencies,
  CreatorAgentProjectBehaviorExtraction,
  CreatorAgentProjectBehaviorTarget,
  CreatorAgentProjectCompilationDiagnostic,
  CreatorAgentProjectCompilationOptions,
  CreatorAgentProjectCompilerErrorCode,
  CreatorAgentProjectGitSnapshot,
} from './project-behavior-extractor.js';

const AGENT_TURN_TIMEOUT_MS = 5 * 60_000;

export type VersionExecutionPreflightPort = Readonly<{
  supportedCodexVersion: string;
  assertRunnable(projectPath: string, version: CreatorAgentVersion): void;
}>;

export type CreatorAgentProjectCompilationReport = Readonly<{
  contextRootDigest: `sha256:${string}`;
  indexedEntryCount: number;
  indexedFileCount: number;
  indexedByteCount: number;
  uniqueIndexedByteCount: number;
  hardlinkAliasCount: number;
  runtimeContext: 'GIT_SNAPSHOT' | 'BEHAVIOR_ONLY';
  categories: CreatorAgentProjectBehaviorExtraction['categories'];
  citedSources: CreatorAgentProjectBehaviorExtraction['citedSources'];
  coverageSummary: string;
}>;

export type CreatorAgentProjectCompilationResult = Readonly<{
  draft: CreatorAgentDraftSnapshot;
  handoff: CreatorAgentDraftHandoff;
  handoffText: string;
  report: CreatorAgentProjectCompilationReport;
}>;

export type CreatorAgentProjectCompilerDependencies = CreatorAgentProjectBehaviorDependencies &
  Readonly<{
    runtimePreflight: VersionExecutionPreflightPort;
    randomId(): string;
  }>;

/** Legacy Draft/AgentVersion adapter retained for compatibility outside Agent Package authoring. */
export async function compileCreatorAgentProjectWithDependencies(
  rawOptions: CreatorAgentProjectCompilationOptions,
  dependencies: CreatorAgentProjectCompilerDependencies,
): Promise<CreatorAgentProjectCompilationResult> {
  const extraction = await extractCreatorAgentProjectBehaviorWithDependencies(
    rawOptions,
    dependencies,
    'LEGACY_SOURCE_RUNTIME',
  );
  const generated = extraction.behavior;
  const projectSnapshot = extraction.projectSnapshot;
  const behaviorOnly = projectSnapshot === undefined;
  const citedSources = extraction.citedSources;

  let draft: CreatorAgentDraftSnapshot;
  let preflightVersion: CreatorAgentVersion;
  let handoff: CreatorAgentDraftHandoff;
  try {
    const sourceLedger = createCreatorAgentProjectSourceLedger({
      contextRootDigest: extraction.contextRootDigest,
      coverage: extraction.coverage,
      citedSources,
    });
    const commonDefinition = {
      name: generated.name,
      description: generated.description,
      behavior: {
        instructions: generated.instructions,
        starterPrompts: generated.starterPrompts,
      },
      requirements: {
        codexVersion: dependencies.runtimePreflight.supportedCodexVersion,
        commands: [],
        plugins: [],
        environmentVariableNames: [],
      },
      authoringSource: { kind: 'project_context_compiler' as const, sourceLedger },
    };
    const id = dependencies.randomId().replaceAll('-', '').toLowerCase();
    if (!/^[0-9a-f]{32}$/u.test(id)) {
      throw compilerError('PROJECT_COMPILER_CONFIGURATION_INVALID');
    }
    const identity = {
      agentId: `agent.local.${id}`,
      draftId: `draft.local.${id}.1`,
      draftRevision: 1,
      baseVersionId: null,
    };
    if (behaviorOnly) {
      const definition = createCreatorAgentDefinitionV3({
        protocol: CREATOR_AGENT_DEFINITION_V3_PROTOCOL,
        ...commonDefinition,
        projectBinding: { kind: 'none' },
        runtime: {
          contextProfile: 'BEHAVIOR_ONLY_V1',
          permissionProfile: 'LOCAL_UNISOLATED_READ_ONLY_V1',
          skills: [],
          dynamicTools: [],
          toolNetworkAccess: false,
          output: { kind: 'text', description: generated.outputDescription },
          turnTimeoutMs: AGENT_TURN_TIMEOUT_MS,
        },
      });
      draft = createCreatorAgentDraftSnapshotV3({ ...identity, definition });
      preflightVersion = freezeCreatorAgentVersionV3({
        versionId: 'version.local.preflight',
        versionNumber: 1,
        createdAtMs: 0,
        draft,
      });
      handoff = createCreatorAgentDraftHandoffV3({ draft });
    } else {
      const definition = createCreatorAgentDefinitionV2({
        protocol: CREATOR_AGENT_DEFINITION_V2_PROTOCOL,
        ...commonDefinition,
        projectSnapshot,
        runtime: {
          contextProfile: 'PROJECT_TREE_READ_ONLY_V1',
          permissionProfile: 'LOCAL_UNISOLATED_READ_ONLY_V1',
          skills: [],
          dynamicTools: [],
          toolNetworkAccess: false,
          output: { kind: 'text', description: generated.outputDescription },
          turnTimeoutMs: AGENT_TURN_TIMEOUT_MS,
        },
      });
      draft = createCreatorAgentDraftSnapshotV2({ ...identity, definition });
      preflightVersion = freezeCreatorAgentVersionV2({
        versionId: 'version.local.preflight',
        versionNumber: 1,
        createdAtMs: 0,
        draft,
      });
      handoff = createCreatorAgentDraftHandoffV2({ draft });
    }
  } catch (error) {
    throw normalizeCompilerError(error, 'PROJECT_COMPILER_OUTPUT_INVALID');
  }
  try {
    dependencies.runtimePreflight.assertRunnable(extraction.sourceProjectPath, preflightVersion);
  } catch (error) {
    throw normalizeCompilerError(error, 'PROJECT_COMPILER_RUNTIME_UNSUPPORTED');
  }
  const runtimeContext: CreatorAgentProjectCompilationReport['runtimeContext'] = behaviorOnly
    ? 'BEHAVIOR_ONLY'
    : 'GIT_SNAPSHOT';
  const report = deepFreeze({
    contextRootDigest: extraction.contextRootDigest,
    indexedEntryCount: extraction.indexedEntryCount,
    indexedFileCount: extraction.indexedFileCount,
    indexedByteCount: extraction.indexedByteCount,
    uniqueIndexedByteCount: extraction.uniqueIndexedByteCount,
    hardlinkAliasCount: extraction.hardlinkAliasCount,
    runtimeContext,
    categories: extraction.categories,
    citedSources,
    coverageSummary: generated.coverageSummary,
  });
  return Object.freeze({
    draft,
    handoff,
    handoffText: serializeCreatorAgentDraftHandoffAny(handoff),
    report,
  });
}

function normalizeCompilerError(
  error: unknown,
  fallback: CreatorAgentProjectCompilerErrorCode,
): CreatorAgentProjectCompilerError {
  if (error instanceof CreatorAgentProjectCompilerError) return error;
  return new CreatorAgentProjectCompilerError(fallback, 'Project context compilation failed.', {
    cause: error,
  });
}

function compilerError(
  code: CreatorAgentProjectCompilerErrorCode,
): CreatorAgentProjectCompilerError {
  return new CreatorAgentProjectCompilerError(code, 'Project context compilation failed.');
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
