import { randomUUID } from 'node:crypto';

import {
  startCreatorAgentPackageSessionWithDependencies,
  type CreatorAgentPackageSession,
  type CreatorAgentPackageSessionOptions,
} from './agent-package-session.js';
import { loadCreatorAgentPackage } from '../infrastructure/agent-package-loader.js';
import { createBundledCodexAgentPackageHost } from '../infrastructure/codex/index.js';

const productionAgentPackageDependencies = Object.freeze({
  loadPackage: loadCreatorAgentPackage,
  createHost: createBundledCodexAgentPackageHost,
  randomId: randomUUID,
});

export function startCreatorAgentPackageSession(
  options: CreatorAgentPackageSessionOptions,
): Promise<CreatorAgentPackageSession> {
  return startCreatorAgentPackageSessionWithDependencies(
    options,
    productionAgentPackageDependencies,
  );
}
