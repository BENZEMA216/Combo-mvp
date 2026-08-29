import { randomUUID } from 'node:crypto';

import { extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies } from '../authoring/current-conversation-draft-extractor.js';
import {
  CreatorAgentPackageCurrentConversationDraftError,
  createCreatorAgentPackageDraftFromCurrentConversationWithDependencies,
  type CreatorAgentPackageCurrentConversationDraftCreationOptions,
  type CreatorAgentPackageCurrentConversationDraftErrorCode,
  type CreatorAgentPackageCurrentConversationDraftTask,
} from './agent-package-current-conversation-draft.js';
import { unavailableCurrentConversationDraftHost } from './unavailable-current-conversation-draft-host.js';

const extractionDependencies = Object.freeze({
  ambientHost: unavailableCurrentConversationDraftHost,
});

const productionDependencies = Object.freeze({
  extractConversation: (
    options: Parameters<
      typeof extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies
    >[0],
  ) =>
    extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
      options,
      extractionDependencies,
    ),
  randomId: randomUUID,
});

/**
 * The stable business facade for conversation-first Draft creation. Until Codex Desktop provides
 * the trusted ambient current-task Host port, this function fails closed with SOURCE_UNAVAILABLE.
 */
export function createCreatorAgentPackageDraftFromCurrentConversation(
  options: CreatorAgentPackageCurrentConversationDraftCreationOptions,
): Promise<CreatorAgentPackageCurrentConversationDraftTask> {
  return createCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
    options,
    productionDependencies,
  );
}

export {
  CreatorAgentPackageCurrentConversationDraftError,
  type CreatorAgentPackageCurrentConversationDraftCreationOptions,
  type CreatorAgentPackageCurrentConversationDraftErrorCode,
  type CreatorAgentPackageCurrentConversationDraftTask,
};
