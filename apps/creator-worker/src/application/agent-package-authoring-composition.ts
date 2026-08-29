import { buildCreatorAgentPackage } from '../authoring/agent-package-builder.js';
import { materializeCreatorProjectSourceProjection } from '../authoring/creator-project-source-projection.js';
import { extractCreatorAgentProjectBehaviorWithDependencies } from '../authoring/project-behavior-extractor.js';
import {
  revalidateProjectContext,
  scanCreatorProjectSourceContext,
} from '../project-context-index.js';
import { createBundledCodexStructuredHost } from '../infrastructure/codex/index.js';
import { loadCreatorAgentPackage } from '../infrastructure/agent-package-loader.js';
import { publishBuiltCreatorAgentPackage } from '../infrastructure/agent-package-publisher.js';
import {
  createCreatorAgentPackageFromProjectWithDependencies,
  type CreatorAgentPackageAuthoringOptions,
  type CreatorAgentPackageAuthoringResult,
} from './agent-package-authoring.js';

const extractionDependencies = Object.freeze({
  scanProject: scanCreatorProjectSourceContext,
  revalidateProject: revalidateProjectContext,
  materializeHostProject: materializeCreatorProjectSourceProjection,
  createHost: createBundledCodexStructuredHost,
});

const productionDependencies = Object.freeze({
  extractProject: (
    options: Parameters<typeof extractCreatorAgentProjectBehaviorWithDependencies>[0],
  ) =>
    extractCreatorAgentProjectBehaviorWithDependencies(
      options,
      extractionDependencies,
      'AGENT_PACKAGE_AUTHORING',
    ),
  buildPackage: buildCreatorAgentPackage,
  publishPackage: publishBuiltCreatorAgentPackage,
  loadPackage: loadCreatorAgentPackage,
});

export function createCreatorAgentPackageFromProject(
  options: CreatorAgentPackageAuthoringOptions,
): Promise<CreatorAgentPackageAuthoringResult> {
  return createCreatorAgentPackageFromProjectWithDependencies(options, productionDependencies);
}
