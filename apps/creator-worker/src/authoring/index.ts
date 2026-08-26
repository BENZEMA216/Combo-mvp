export {
  PROJECT_COMPILER_OUTPUT_SCHEMA,
  CreatorAgentProjectCompilerError,
  compileCreatorAgentProjectWithDependencies,
  extractCreatorAgentProjectBehaviorWithDependencies,
  type CreatorAgentProjectBehavior,
  type CreatorAgentProjectBehaviorDependencies,
  type CreatorAgentProjectBehaviorExtraction,
  type CreatorAgentProjectBehaviorTarget,
  type CreatorAgentProjectCompilationDiagnostic,
  type CreatorAgentProjectCompilationOptions,
  type CreatorAgentProjectCompilationReport,
  type CreatorAgentProjectCompilationResult,
  type CreatorAgentProjectCompilerDependencies,
  type CreatorAgentProjectCompilerErrorCode,
  type VersionExecutionPreflightPort,
} from './project-context-compiler.js';
export {
  assertSameProjectContext,
  revalidateProjectContext,
  scanProjectContext,
  type ProjectContextIndexProgress,
  type ProjectContextScan,
} from '../project-context-index.js';
export type { StructuredAuthoringHostOptions, StructuredAuthoringHostPort } from './ports.js';
