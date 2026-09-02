import {
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V2_PROTOCOL,
  createCreatorAgentPackageCreatorRequestV2,
} from '@cb/creator-agent-protocol/agent-package-draft';
import { describe, expect, it } from 'vitest';

import { createCreatorAgentPackageDraftFromCurrentConversation } from '../application/agent-package-current-conversation-composition.js';

const request = createCreatorAgentPackageCreatorRequestV2({
  protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V2_PROTOCOL,
  intent: 'create_agent_package_from_current_conversation',
  request: '把我们刚才完成的工作做成一个 Agent。',
});

describe('current-conversation production composition', () => {
  it('fails closed with one fixed safe error while the Desktop Host capability is unavailable', async () => {
    await expect(
      createCreatorAgentPackageDraftFromCurrentConversation({ request }),
    ).rejects.toMatchObject({
      name: 'CreatorAgentPackageCurrentConversationDraftError',
      code: 'AGENT_PACKAGE_CONVERSATION_SOURCE_UNAVAILABLE',
      message: 'The active current-conversation source is unavailable.',
    });
  });

  it('rejects caller-selected Host, task, thread, transcript, or Project material before opening a source', async () => {
    for (const [field, value] of [
      ['ambientHost', {}],
      ['taskId', 'task-private'],
      ['threadId', 'thread-private'],
      ['sessionId', 'session-private'],
      ['rawTranscript', 'private transcript'],
      ['projectPath', '/Users/alice/private'],
    ] as const) {
      await expect(
        createCreatorAgentPackageDraftFromCurrentConversation({ request, [field]: value }),
      ).rejects.toMatchObject({
        code: 'AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID',
      });
    }
  });
});
