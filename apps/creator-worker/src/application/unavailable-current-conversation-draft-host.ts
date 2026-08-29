import type { AmbientCurrentConversationDraftHostPort } from '../authoring/current-conversation-draft-extractor.js';

/**
 * Production placeholder for builds that do not provide the first-party Desktop current-task
 * capability. It never accepts caller-supplied task identity or source material and cannot fall
 * back to Project, session, Hook, Bridge, CLI, or a second Codex thread.
 */
export const unavailableCurrentConversationDraftHost: AmbientCurrentConversationDraftHostPort =
  Object.freeze({
    async openCurrentConversationSource(): Promise<never> {
      throw new Error('Desktop current-conversation Host capability is unavailable.');
    },
  });
