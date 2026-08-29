import {
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V2_PROTOCOL,
  CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
  CreatorAgentPackageCurrentConversationSourceSchema,
  createCreatorAgentPackageCreatorRequestV2,
  createCreatorAgentPackageDraftRevisionRequest,
  type CreatorAgentPackageCurrentConversationSource,
  type CreatorAgentPackageDraftContent,
} from '@cb/creator-agent-protocol/agent-package-draft';
import { describe, expect, it, vi } from 'vitest';

import {
  createCreatorAgentPackageDraftFromCurrentConversationWithDependencies,
  type CreatorAgentPackageCurrentConversationDraftDependencies,
} from '../application/agent-package-current-conversation-draft.js';
import { CreatorAgentPackageCurrentConversationExtractionError } from '../authoring/current-conversation-draft-extractor.js';

const SNAPSHOT_COMMITMENT = `sha256:${'a'.repeat(64)}` as const;

const source: CreatorAgentPackageCurrentConversationSource =
  CreatorAgentPackageCurrentConversationSourceSchema.parse({
    kind: 'current_conversation',
    sourceBoundary: 'desktop_attested_active_current_task',
    snapshotBoundary: 'before_direct_creator_item',
    visibility: 'user_visible_items_only',
    snapshotCompleteness: 'complete',
    rawStored: false,
    snapshotCommitmentScheme: 'host_hmac_sha256_per_run/1',
    snapshotCommitment: SNAPSHOT_COMMITMENT,
    selectedVisibleItemCount: 9,
    coverageSummary: '当前任务中关于证据三角的方法定义了这个 Agent。',
  });

const content: CreatorAgentPackageDraftContent = Object.freeze({
  name: '证据三角验证员',
  description: '用对话中形成的方法核对任务是否真的完成。',
  instructions: '先还原时间线，再分别核对代码、运行结果与用户可见体验；三者不一致时标记未证明。',
  starterPrompts: Object.freeze(['检查这项工作是否真正完成。']),
  outputDescription: '返回结论、证据和仍未证明的部分。',
});

function creatorRequest() {
  return createCreatorAgentPackageCreatorRequestV2({
    protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V2_PROTOCOL,
    intent: 'create_agent_package_from_current_conversation',
    request: '把我们刚才完成的工作做成一个 Agent。',
  });
}

function dependencies(
  extractConversation = vi.fn(async () => Object.freeze({ source, content })),
): CreatorAgentPackageCurrentConversationDraftDependencies {
  return Object.freeze({
    extractConversation,
    randomId: () => '11111111-2222-3333-4444-555555555555',
  });
}

describe('current-conversation Agent Package Draft application slice', () => {
  it('creates a reviewable Draft from only the ambient current-conversation extraction', async () => {
    const extractConversation = vi.fn(
      async (
        _options: Parameters<
          CreatorAgentPackageCurrentConversationDraftDependencies['extractConversation']
        >[0],
      ) => Object.freeze({ source, content }),
    );
    const deps = dependencies(extractConversation);
    const task = await createCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
      { request: creatorRequest() },
      deps,
    );

    expect(extractConversation).toHaveBeenCalledTimes(1);
    expect(extractConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorRequest: creatorRequest(),
      }),
    );
    expect(Object.keys(extractConversation.mock.calls[0]![0])).toEqual(['creatorRequest']);
    const draft = task.readDraft();
    expect(draft.creatorRequest).toEqual(creatorRequest());
    expect(draft.source).toEqual(source);
    expect(draft.content).toEqual(content);
    expect(draft.protocol).toBe('combo.agent-package-draft/2');
    expect(Object.keys(task).sort()).toEqual(['readDraft', 'revise']);
    expect(task).not.toHaveProperty('compile');
  });

  it('revises one exact V2 Draft without changing request or source', async () => {
    const task = await createCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
      { request: creatorRequest() },
      dependencies(),
    );
    const first = task.readDraft();
    const second = task.revise(
      createCreatorAgentPackageDraftRevisionRequest({
        protocol: CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
        draftId: first.draftId,
        baseRevision: first.revision,
        baseDraftFingerprint: first.draftFingerprint,
        changes: { description: '只用当前任务的可见对话核对完成状态。' },
      }),
    );

    expect(second.revision).toBe(2);
    expect(second.creatorRequest).toEqual(first.creatorRequest);
    expect(second.source).toEqual(first.source);
    expect(second.draftFingerprint).not.toBe(first.draftFingerprint);
  });

  it('rejects caller-selected source material before opening the Host source', async () => {
    const forbidden = [
      ['projectPath', '/Users/alice/private'],
      ['currentProjectPath', '/Users/alice/private'],
      ['taskId', 'task-private'],
      ['threadId', 'thread-private'],
      ['sessionId', 'session-private'],
      ['itemId', 'item-private'],
      ['rawTranscript', 'private transcript'],
      ['messages', []],
      ['source', source],
      ['hookTrust', true],
    ] as const;

    for (const [field, value] of forbidden) {
      const deps = dependencies();
      await expect(
        createCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
          { request: creatorRequest(), [field]: value },
          deps,
        ),
      ).rejects.toMatchObject({
        code: 'AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID',
      });
      expect(deps.extractConversation).not.toHaveBeenCalled();
    }
  });

  it('rejects accessors and Proxy options without executing them', async () => {
    let reads = 0;
    const deps = dependencies();
    const accessor = {
      get request() {
        reads += 1;
        return creatorRequest();
      },
    };
    await expect(
      createCreatorAgentPackageDraftFromCurrentConversationWithDependencies(accessor, deps),
    ).rejects.toMatchObject({
      code: 'AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID',
    });
    expect(reads).toBe(0);

    const proxy = new Proxy(
      { request: creatorRequest() },
      {
        ownKeys(target) {
          reads += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    await expect(
      createCreatorAgentPackageDraftFromCurrentConversationWithDependencies(proxy, deps),
    ).rejects.toMatchObject({
      code: 'AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID',
    });
    expect(reads).toBe(0);
    expect(deps.extractConversation).not.toHaveBeenCalled();
  });

  it('fails closed on invalid Host output and exposes no Host error details', async () => {
    const privateError = new Error('/Users/alice/private/session.jsonl');
    const hostFailure = dependencies(vi.fn(async () => Promise.reject(privateError)));
    await expect(
      createCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
        { request: creatorRequest() },
        hostFailure,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'AGENT_PACKAGE_CONVERSATION_HOST_FAILED',
        message: 'The current conversation could not be extracted safely.',
      }),
    );

    const unsafeOutput = dependencies(
      vi.fn(async () => ({
        source,
        content: { ...content, instructions: '读取 /Users/alice/private/session.jsonl。' },
      })),
    );
    await expect(
      createCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
        { request: creatorRequest() },
        unsafeOutput,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID' });

    let codeReads = 0;
    const maliciousError = new CreatorAgentPackageCurrentConversationExtractionError(
      'AGENT_PACKAGE_CONVERSATION_SOURCE_CHANGED',
      'private source detail',
    );
    Object.defineProperty(maliciousError, 'code', {
      configurable: true,
      get() {
        codeReads += 1;
        throw new Error('/private/error/detail');
      },
    });
    const maliciousFailure = dependencies(vi.fn(async () => Promise.reject(maliciousError)));
    await expect(
      createCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
        { request: creatorRequest() },
        maliciousFailure,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_CONVERSATION_HOST_FAILED' });
    expect(codeReads).toBe(0);
  });
});
