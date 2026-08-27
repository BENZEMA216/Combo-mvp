import { randomUUID } from 'node:crypto';

import {
  buildCreatorAgentPackageFromDraft,
  normalizeCreatorAgentPackageDraftContent,
} from '../authoring/agent-package-builder.js';
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
  createCreatorAgentPackageDraftFromCurrentProjectWithDependencies,
  type CreatorAgentPackageDraftAuthoringTask,
  type CreatorAgentPackageDraftCreationOptions,
} from './agent-package-creator.js';

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
  normalizeDraftContent: normalizeCreatorAgentPackageDraftContent,
  buildPackage: buildCreatorAgentPackageFromDraft,
  publishPackage: publishBuiltCreatorAgentPackage,
  loadPackage: loadCreatorAgentPackage,
  randomId: randomUUID,
});

export function createCreatorAgentPackageDraftFromCurrentProject(
  options: CreatorAgentPackageDraftCreationOptions,
): Promise<CreatorAgentPackageDraftAuthoringTask> {
  return createCreatorAgentPackageDraftFromCurrentProjectWithDependencies(
    options,
    productionDependencies,
  );
}
