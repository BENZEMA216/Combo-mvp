import {
  extractCreatorAgentProjectBehaviorWithDependencies,
  revalidateProjectContext,
  scanProjectContext,
} from '../authoring/index.js';
import { buildCreatorAgentPackage } from '../authoring/agent-package-builder.js';
import { createBundledCodexStructuredHost } from '../infrastructure/codex/index.js';
import { loadCreatorAgentPackage } from '../infrastructure/agent-package-loader.js';
import { publishBuiltCreatorAgentPackage } from '../infrastructure/agent-package-publisher.js';
import {
  createCreatorAgentPackageFromProjectWithDependencies,
  type CreatorAgentPackageAuthoringOptions,
  type CreatorAgentPackageAuthoringResult,
} from './agent-package-authoring.js';

const extractionDependencies = Object.freeze({
  scanProject: scanProjectContext,
  revalidateProject: revalidateProjectContext,
  createHost: createBundledCodexStructuredHost,
});

const productionDependencies = Object.freeze({
  extractProject: (
    options: Parameters<typeof extractCreatorAgentProjectBehaviorWithDependencies>[0],
  ) =>
    extractCreatorAgentProjectBehaviorWithDependencies(
      options,
      extractionDependencies,
      'AGENT_PACKAGE_CONSUMER_PROJECT',
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
