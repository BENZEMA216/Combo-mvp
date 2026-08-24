export {
  PROJECT_COMPILER_OUTPUT_SCHEMA,
  CreatorAgentProjectCompilerError,
  compileCreatorAgentProjectWithDependencies,
  type CreatorAgentProjectCompilationDiagnostic,
  type CreatorAgentProjectCompilationOptions,
  type CreatorAgentProjectCompilationReport,
  type CreatorAgentProjectCompilationResult,
  type CreatorAgentProjectCompilerDependencies,
  type CreatorAgentProjectCompilerErrorCode,
} from './project-context-compiler.js';
export {
  assertSameProjectContext,
  revalidateProjectContext,
  scanProjectContext,
  type ProjectContextIndexProgress,
  type ProjectContextScan,
} from '../project-context-index.js';
export type {
  StructuredAuthoringHostOptions,
  StructuredAuthoringHostPort,
  VersionExecutionPreflightPort,
} from './ports.js';
