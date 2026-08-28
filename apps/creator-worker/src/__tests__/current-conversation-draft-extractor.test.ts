import { describe, expect, it, vi } from 'vitest';

import {
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V2_PROTOCOL,
  createCreatorAgentPackageCreatorRequestV2,
  digestCreatorAgentPackageCreatorRequestV2,
} from '@cb/creator-agent-protocol/agent-package-draft';

import {
  digestGeneratedConversationDraftForEgress,
  extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies,
  type AmbientCurrentConversationDraftHostPort,
  type CurrentConversationSourceLease,
} from '../authoring/current-conversation-draft-extractor.js';

const CREATOR_REQUEST = createCreatorAgentPackageCreatorRequestV2({
  protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V2_PROTOCOL,
  intent: 'create_agent_package_from_current_conversation',
  request: '只把刚才的证据核验方法做成 Agent，忽略部署过程。',
});
const REQUEST_DIGEST = digestCreatorAgentPackageCreatorRequestV2(CREATOR_REQUEST);
const SNAPSHOT_DIGEST = `sha256:${'b'.repeat(64)}` as const;

function attestation(overrides: Record<string, unknown> = {}) {
  return {
    trigger: 'direct_user_creator_item',
    sourceBoundary: 'desktop_attested_active_current_task',
    snapshotBoundary: 'before_direct_creator_item',
    visibility: 'user_visible_items_only',
    snapshotCompleteness: 'complete',
    rawStored: false,
    snapshotDigest: SNAPSHOT_DIGEST,
    selectedVisibleItemCount: 5,
    creatorRequestDigest: REQUEST_DIGEST,
    ...overrides,
  };
}

function generated(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 'combo.creator-conversation-draft-extraction/1',
    name: '证据核验员',
    description: '使用当前对话形成的方法检查任务。',
    instructions: '先核对时间线，再对照代码、运行结果和用户可见体验。',
    starterPrompts: ['检查这项任务。'],
    outputDescription: '返回证据结论。',
    coverageSummary: '当前任务中关于证据核验的讨论定义了这个 Agent。',
    ...overrides,
  };
}

function safeGenerated(
  draft: ReturnType<typeof generated> = generated(),
  receiptOverrides: Record<string, unknown> = {},
) {
  return {
    status: 'accepted',
    draft,
    egressReceipt: {
      policy: 'sealed_snapshot_verbatim_and_credential_scan/1',
      verdict: 'passed',
      snapshotDigest: SNAPSHOT_DIGEST,
      creatorRequestDigest: REQUEST_DIGEST,
      extractedDraftDigest: digestGeneratedConversationDraftForEgress(draft),
      ...receiptOverrides,
    },
  };
}

function fixture(
  options: {
    attestation?: unknown;
    output?: unknown;
    expectedRequest?: typeof CREATOR_REQUEST;
    assertErrorAt?: number;
    extractError?: unknown;
    closeError?: unknown;
  } = {},
) {
  const events: string[] = [];
  let assertions = 0;
  const expectedRequest = options.expectedRequest ?? CREATOR_REQUEST;
  const expectedRequestDigest = digestCreatorAgentPackageCreatorRequestV2(expectedRequest);
  const lease: CurrentConversationSourceLease = Object.freeze({
    readAttestation: vi.fn(() => {
      events.push('attestation');
      return options.attestation ?? attestation({ creatorRequestDigest: expectedRequestDigest });
    }),
    assertStillCurrent: vi.fn(async () => {
      assertions += 1;
      events.push(`assert:${assertions}`);
      if (options.assertErrorAt === assertions) throw new Error('private drift detail');
    }),
    extractStructuredWithEgressGuard: vi.fn(async () => {
      events.push('extract');
      if (options.extractError !== undefined) throw options.extractError;
      return (
        options.output ??
        safeGenerated(generated(), { creatorRequestDigest: expectedRequestDigest })
      );
    }),
    close: vi.fn(async () => {
      events.push('close');
      if (options.closeError !== undefined) throw options.closeError;
    }),
  });
  const port: AmbientCurrentConversationDraftHostPort = Object.freeze({
    openCurrentConversationSource: vi.fn(async (input) => {
      events.push('open');
      expect(Object.keys(input)).toEqual(['creatorRequestDigest']);
      expect(input.creatorRequestDigest).toBe(expectedRequestDigest);
      return lease;
    }),
  });
  return { events, lease, port };
}

describe('ambient current-conversation extraction boundary', () => {
  it('extracts once between two current-task assertions and then closes', async () => {
    const { events, lease, port } = fixture();
    const result = await extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
      { creatorRequest: CREATOR_REQUEST },
      { ambientHost: port },
    );

    expect(events).toEqual(['open', 'attestation', 'assert:1', 'extract', 'assert:2', 'close']);
    expect(lease.extractStructuredWithEgressGuard).toHaveBeenCalledTimes(1);
    expect(lease.extractStructuredWithEgressGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'snapshot_only_no_tools',
        creatorRequest: CREATOR_REQUEST.request,
        developerInstructions: expect.stringContaining('current task'),
        outputSchema: expect.objectContaining({ additionalProperties: false }),
      }),
    );
    const structuredInput = vi.mocked(lease.extractStructuredWithEgressGuard).mock.calls[0]![0];
    expect(JSON.stringify(structuredInput.outputSchema)).not.toContain('egressReceipt');
    expect(result.source).toEqual({
      kind: 'current_conversation',
      sourceBoundary: 'desktop_attested_active_current_task',
      snapshotBoundary: 'before_direct_creator_item',
      visibility: 'user_visible_items_only',
      snapshotCompleteness: 'complete',
      rawStored: false,
      snapshotDigest: SNAPSHOT_DIGEST,
      selectedVisibleItemCount: 5,
      coverageSummary: '当前任务中关于证据核验的讨论定义了这个 Agent。',
    });
    expect(result.content.name).toBe('证据核验员');
  });

  it('passes the exact Host-bound creator request into extraction semantics', async () => {
    const secondRequest = createCreatorAgentPackageCreatorRequestV2({
      protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V2_PROTOCOL,
      intent: 'create_agent_package_from_current_conversation',
      request: '只提炼部署核验步骤，不要包含产品讨论。',
    });
    const observed: string[] = [];

    for (const request of [CREATOR_REQUEST, secondRequest]) {
      const { lease, port } = fixture({ expectedRequest: request });
      await extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
        { creatorRequest: request },
        { ambientHost: port },
      );
      observed.push(
        vi.mocked(lease.extractStructuredWithEgressGuard).mock.calls[0]![0].creatorRequest,
      );
    }

    expect(observed).toEqual([CREATOR_REQUEST.request, secondRequest.request]);
  });

  it('requires a Host-owned egress receipt bound to the exact source, request, and Draft', async () => {
    for (const [output, code] of [
      [generated(), 'AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID'],
      [
        {
          ...safeGenerated(),
          egressReceipt: {
            ...safeGenerated().egressReceipt,
            policy: 'model_self_reported_safe/1',
          },
        },
        'AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID',
      ],
      [
        safeGenerated(generated(), { snapshotDigest: `sha256:${'c'.repeat(64)}` }),
        'AGENT_PACKAGE_CONVERSATION_OUTPUT_REJECTED',
      ],
      [
        safeGenerated(generated(), { creatorRequestDigest: `sha256:${'d'.repeat(64)}` }),
        'AGENT_PACKAGE_CONVERSATION_OUTPUT_REJECTED',
      ],
      [
        safeGenerated(generated(), { extractedDraftDigest: `sha256:${'e'.repeat(64)}` }),
        'AGENT_PACKAGE_CONVERSATION_OUTPUT_REJECTED',
      ],
    ] as const) {
      const { port } = fixture({ output });
      await expect(
        extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
          { creatorRequest: CREATOR_REQUEST },
          { ambientHost: port },
        ),
      ).rejects.toMatchObject({ code });
    }
  });

  it('returns no Draft or receipt when the Host rejects raw or credential egress', async () => {
    for (const privateCandidate of ['RAW-TRANSCRIPT-CANARY-9184', 'api_key=SECRET-CANARY-7421']) {
      const hostResult = privateCandidate.includes('CANARY')
        ? {
            status: 'rejected',
            reason: 'verbatim_or_credential_detected',
          }
        : safeGenerated();
      expect(hostResult).not.toHaveProperty('egressReceipt');
      const { port } = fixture({ output: hostResult });
      const failure = await extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
        { creatorRequest: CREATOR_REQUEST },
        { ambientHost: port },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'AGENT_PACKAGE_CONVERSATION_OUTPUT_REJECTED',
        message: 'Current-conversation extraction did not pass the Host egress boundary.',
      });
      expect(JSON.stringify(failure)).not.toContain(privateCandidate);
    }
  });

  it('rejects incomplete, empty, mismatched, or non-user-visible sources before extraction', async () => {
    for (const [overrides, code] of [
      [{ snapshotCompleteness: 'incomplete' }, 'AGENT_PACKAGE_CONVERSATION_SOURCE_INCOMPLETE'],
      [{ selectedVisibleItemCount: 0 }, 'AGENT_PACKAGE_CONVERSATION_SOURCE_INCOMPLETE'],
      [
        { creatorRequestDigest: `sha256:${'c'.repeat(64)}` },
        'AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID',
      ],
      [{ trigger: 'model_generated_item' }, 'AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID'],
      [
        { snapshotBoundary: 'including_creator_response' },
        'AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID',
      ],
      [{ visibility: 'all_rollout_items' }, 'AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID'],
      [{ rawStored: true }, 'AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID'],
    ] as const) {
      const { events, lease, port } = fixture({ attestation: attestation(overrides) });
      await expect(
        extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
          { creatorRequest: CREATOR_REQUEST },
          { ambientHost: port },
        ),
      ).rejects.toMatchObject({ code });
      expect(lease.extractStructuredWithEgressGuard).not.toHaveBeenCalled();
      expect(events.at(-1)).toBe('close');
    }
  });

  it('makes drift outrank extraction failure and still closes exactly once', async () => {
    const { events, lease, port } = fixture({
      extractError: new Error('/private/raw transcript'),
      assertErrorAt: 2,
    });
    await expect(
      extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
        { creatorRequest: CREATOR_REQUEST },
        { ambientHost: port },
      ),
    ).rejects.toMatchObject({
      code: 'AGENT_PACKAGE_CONVERSATION_SOURCE_CHANGED',
      message: 'The active conversation changed during Draft extraction.',
    });
    expect(events).toEqual(['open', 'attestation', 'assert:1', 'extract', 'assert:2', 'close']);
    expect(lease.extractStructuredWithEgressGuard).toHaveBeenCalledTimes(1);
    expect(lease.close).toHaveBeenCalledTimes(1);
  });

  it('reports incomplete cleanup and never retries the Host extraction', async () => {
    const { lease, port } = fixture({
      extractError: new Error('private host detail'),
      closeError: new Error('private close detail'),
    });
    await expect(
      extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
        { creatorRequest: CREATOR_REQUEST },
        { ambientHost: port },
      ),
    ).rejects.toMatchObject({
      code: 'AGENT_PACKAGE_CONVERSATION_STOP_INCOMPLETE',
      message: 'The current-conversation source could not be closed safely.',
    });
    expect(lease.extractStructuredWithEgressGuard).toHaveBeenCalledTimes(1);
    expect(lease.close).toHaveBeenCalledTimes(1);
  });

  it('closes malformed leases through only an exact safe close descriptor', async () => {
    let reads = 0;
    for (const malformedLease of [
      {
        readAttestation: () => attestation(),
        assertStillCurrent: async () => undefined,
        get extractStructuredWithEgressGuard() {
          reads += 1;
          throw new Error('/private/getter/detail');
        },
        close: vi.fn(async () => undefined),
      },
      {
        readAttestation: () => attestation(),
        assertStillCurrent: async () => undefined,
        extractStructuredWithEgressGuard: async () => safeGenerated(),
        close: vi.fn(async () => undefined),
        privateHandle: 'must not be read',
      },
    ]) {
      const close = malformedLease.close;
      const port = Object.freeze({
        openCurrentConversationSource: vi.fn(async () => Object.freeze(malformedLease)),
      });

      await expect(
        extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
          { creatorRequest: CREATOR_REQUEST },
          { ambientHost: port },
        ),
      ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID' });
      expect(close).toHaveBeenCalledTimes(1);
    }
    expect(reads).toBe(0);
  });

  it('rejects unsafe structured output and accessors without leaking source bytes', async () => {
    const unsafeDraft = generated({ instructions: '读取 /tmp/private.log。' });
    const unsafe = fixture({ output: safeGenerated(unsafeDraft) });
    await expect(
      extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
        { creatorRequest: CREATOR_REQUEST },
        { ambientHost: unsafe.port },
      ),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID' });

    let reads = 0;
    const accessor = {
      ...generated(),
      get instructions() {
        reads += 1;
        return 'private transcript';
      },
    };
    const malicious = fixture({
      output: {
        draft: accessor,
        egressReceipt: safeGenerated().egressReceipt,
      },
    });
    await expect(
      extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
        { creatorRequest: CREATOR_REQUEST },
        { ambientHost: malicious.port },
      ),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID' });
    expect(reads).toBe(0);
  });

  it('stops before the Host port when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { port } = fixture();

    await expect(
      extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
        { creatorRequest: CREATOR_REQUEST, signal: controller.signal },
        { ambientHost: port },
      ),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_CONVERSATION_CANCELLED' });
    expect(port.openCurrentConversationSource).not.toHaveBeenCalled();
  });
});
