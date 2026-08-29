import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import {
  commitCreatorAgentPackageProjectHistoryCandidate,
  createCreatorAgentPackageDraftSnapshotV3,
} from '@cb/creator-agent-protocol/agent-package-draft';
import {
  PROJECT_HISTORY_AGENT_DRAFT_SUMMARY,
  PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_LABEL,
  PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_MESSAGE,
} from '../modules/project-history-agent/contracts.js';
import { PROJECT_HISTORY_AGENT_DRAFT_APP_HTML } from '../modules/project-history-agent/draft-app.js';

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

class FakeElement {
  readonly children: FakeElement[] = [];
  textContent = '';
  hidden = false;
  disabled = false;
  private readonly listeners = new Map<string, () => unknown>();

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }

  addEventListener(type: string, listener: () => unknown): void {
    this.listeners.set(type, listener);
  }

  async dispatch(type: string): Promise<void> {
    await this.listeners.get(type)?.();
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const confirmationToken = `cfrm_${'S'.repeat(43)}`;
const creatorRequest = {
  protocol: 'combo.agent-package-creator-request/3' as const,
  intent: 'create_agent_package_from_project_task_history' as const,
  request: '把这个 Project 里以前完成过的方法做成一个 Agent。',
};
const content = {
  name: '证据核验员',
  description: '核验证据。',
  instructions: '先核对，再验证。',
  outputDescription: '结论与边界。',
  starterPrompts: ['检查发布。'],
};
const sourceEvidence = {
  kind: 'host_project_scoped_reduced_history' as const,
  selection: 'user_selected_saved_project' as const,
  assurance: 'best_effort' as const,
  completeness: 'not_proven' as const,
  hostAttestation: 'not_proven' as const,
  sourceProjectionEnforced: 'not_proven' as const,
  rawStored: false as const,
  projectCount: 1 as const,
  discoveredThreadCount: 4,
  readThreadCount: 4,
  omittedThreadCount: 1,
  completedTurnCount: 8,
  userVisibleMessageCount: 18,
  omittedItemCount: 2,
  limitationReasons: [
    'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
    'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
    'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
  ] as const,
};
const draft = createCreatorAgentPackageDraftSnapshotV3({
  protocol: 'combo.agent-package-draft/3',
  draftId: `draft.agent-package.${'1'.repeat(32)}`,
  revision: 1,
  parentDraftFingerprint: null,
  creatorRequest,
  source: {
    ...sourceEvidence,
    candidateCommitment: commitCreatorAgentPackageProjectHistoryCandidate({
      creatorRequest,
      candidate: content,
      sourceEvidence,
    }),
  },
  content,
});
const payload = {
  schemaVersion: 'combo.agent-package-draft-card/1',
  draft,
  cardSnapshot: {
    stage: 'draft',
    title: '证据核验员',
    summary: PROJECT_HISTORY_AGENT_DRAFT_SUMMARY,
    content,
    sourceDisclosure: sourceEvidence,
    shareDisclosure: {
      access: 'public_by_link',
      revocation: 'not_supported',
      expiry: 'none',
      marketplacePublication: false,
    },
  },
  confirmation: {
    scheme: 'combo.agent-package-share-confirmation/1',
    confirmationToken,
    expiresAt: '2026-08-29T00:05:00.000Z',
  },
  actions: [
    {
      id: 'confirm_create_agent_package_share',
      label: PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_LABEL,
      message: PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_MESSAGE,
      emphasis: 'primary',
    },
  ],
};

function browserCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(browserCanonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('invalid canonical value');
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${browserCanonical(Reflect.get(value, key))}`)
    .join(',')}}`;
}

function browserFingerprint(domain: string, value: unknown): string {
  const wire = browserCanonical({ domain, implementation: 'combo-rfc8785-jcs/1', value });
  return `sha256:${createHash('sha256').update(wire, 'utf8').digest('hex')}`;
}

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;
type MutablePayload = Mutable<typeof payload>;
type ForgedPayloadInput = {
  creatorRequest: MutablePayload['draft']['creatorRequest'];
  content: MutablePayload['draft']['content'];
};

function forgeInternallyConsistentPayload(
  mutate: (value: ForgedPayloadInput) => void,
): typeof payload {
  const forged = JSON.parse(JSON.stringify(payload)) as MutablePayload;
  mutate({
    creatorRequest: forged.draft.creatorRequest,
    content: forged.draft.content,
  });
  forged.cardSnapshot.content = JSON.parse(JSON.stringify(forged.draft.content)) as Mutable<
    typeof content
  >;
  const { candidateCommitment: _candidateCommitment, ...evidence } = forged.draft.source;
  forged.draft.source.candidateCommitment = browserFingerprint(
    'combo.agent-package-draft/3:candidate-commitment',
    {
      creatorRequest: forged.draft.creatorRequest,
      candidate: forged.draft.content,
      sourceEvidence: evidence,
    },
  ) as unknown as typeof forged.draft.source.candidateCommitment;
  forged.draft.draftFingerprint = browserFingerprint('combo.agent-package-draft/3:fingerprint', {
    protocol: forged.draft.protocol,
    draftId: forged.draft.draftId,
    revision: forged.draft.revision,
    parentDraftFingerprint: forged.draft.parentDraftFingerprint,
    creatorRequest: forged.draft.creatorRequest,
    source: forged.draft.source,
    content: forged.draft.content,
  }) as unknown as typeof forged.draft.draftFingerprint;
  return forged as unknown as typeof payload;
}

function forgeRevisionTwoPayload(): typeof payload {
  const forged = JSON.parse(JSON.stringify(payload)) as MutablePayload;
  const revisionFields = forged.draft as unknown as {
    revision: number;
    parentDraftFingerprint: string | null;
    draftFingerprint: string;
  };
  revisionFields.revision = 2;
  revisionFields.parentDraftFingerprint = payload.draft.draftFingerprint;
  revisionFields.draftFingerprint = browserFingerprint('combo.agent-package-draft/3:fingerprint', {
    protocol: forged.draft.protocol,
    draftId: forged.draft.draftId,
    revision: revisionFields.revision,
    parentDraftFingerprint: revisionFields.parentDraftFingerprint,
    creatorRequest: forged.draft.creatorRequest,
    source: forged.draft.source,
    content: forged.draft.content,
  });
  return forged as unknown as typeof payload;
}

async function startApp(
  options: {
    actionResponse?: 'success' | 'reject' | 'timeout';
    deferActionResponse?: boolean;
    deferInitialize?: boolean;
    initializeFailure?: boolean;
    initializeTimeout?: boolean;
    legacyCompatibility?: boolean;
    manualRequestTimeouts?: boolean;
    structuredContent?: unknown;
    onDigest?: () => void;
  } = {},
) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(PROJECT_HISTORY_AGENT_DRAFT_APP_HTML)?.[1];
  if (!script) throw new Error('Draft App script is missing.');
  const ids = [
    'title',
    'summary',
    'content',
    'starters',
    'source',
    'limitations',
    'confirm',
    'status',
    'error',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const outbound: JsonRpcMessage[] = [];
  const compatibilityMessage = vi.fn(async () => undefined);
  let onMessage: ((event: { source: unknown; data: JsonRpcMessage }) => void) | undefined;
  let nextTimeoutId = 1;
  const manualTimeouts = new Map<number, () => void>();
  let initializeRequestId: number | undefined;
  let actionRequestId: number | undefined;
  function appSetTimeout(callback: () => void, delay?: number) {
    if (options.manualRequestTimeouts && delay === 8000) {
      const id = nextTimeoutId++;
      manualTimeouts.set(id, callback);
      return id;
    }
    return setTimeout(callback, delay);
  }
  function appClearTimeout(handle: ReturnType<typeof setTimeout> | number) {
    if (typeof handle === 'number' && manualTimeouts.delete(handle)) return;
    clearTimeout(handle);
  }
  const parent = {
    postMessage(message: JsonRpcMessage) {
      outbound.push(message);
      if (message.method === 'ui/initialize' && message.id !== undefined) {
        initializeRequestId = message.id;
        if (options.deferInitialize) return;
        if (options.initializeTimeout) return;
        const id = message.id;
        queueMicrotask(() =>
          onMessage?.({
            source: parent,
            data: options.initializeFailure
              ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }
              : { jsonrpc: '2.0', id, result: { protocolVersion: '2026-01-26' } },
          }),
        );
      }
      if (message.method === 'ui/notifications/initialized') {
        queueMicrotask(() =>
          onMessage?.({
            source: parent,
            data: {
              jsonrpc: '2.0',
              method: 'ui/notifications/tool-result',
              params: { structuredContent: options.structuredContent ?? payload },
            },
          }),
        );
      }
      if (message.method === 'ui/message' && message.id !== undefined) {
        actionRequestId = message.id;
        if (options.deferActionResponse) return;
        if (options.actionResponse === 'timeout') return;
        const id = message.id;
        queueMicrotask(() =>
          onMessage?.({
            source: parent,
            data:
              options.actionResponse === 'reject'
                ? { jsonrpc: '2.0', id, error: { code: -32600, message: 'Rejected' } }
                : { jsonrpc: '2.0', id, result: {} },
          }),
        );
      }
    },
  };
  const windowObject = {
    parent,
    setTimeout: appSetTimeout,
    clearTimeout: appClearTimeout,
    openai: options.legacyCompatibility
      ? {
          toolOutput: options.structuredContent ?? payload,
          sendFollowUpMessage: compatibilityMessage,
        }
      : undefined,
    crypto: options.onDigest
      ? {
          subtle: {
            digest(...args: Parameters<typeof webcrypto.subtle.digest>) {
              options.onDigest?.();
              return webcrypto.subtle.digest(...args);
            },
          },
        }
      : webcrypto,
    TextEncoder,
    addEventListener(
      type: string,
      listener: (event: { source: unknown; data: JsonRpcMessage }) => void,
    ) {
      if (type === 'message') onMessage = listener;
    },
  };
  const documentObject = {
    getElementById(id: string) {
      return elements.get(id);
    },
    createElement() {
      return new FakeElement();
    },
  };
  runInNewContext(script, {
    window: windowObject,
    document: documentObject,
    Map,
    Promise,
    Error,
    String,
    Object,
    Array,
    Reflect,
    WeakSet,
    Set,
    Number,
  });
  for (let index = 0; index < 8; index += 1) await tick();
  return {
    elements,
    outbound,
    compatibilityMessage,
    deliver(message: JsonRpcMessage) {
      onMessage?.({ source: parent, data: message });
    },
    settleInitialize(outcome: 'success' | 'reject') {
      if (initializeRequestId === undefined) throw new Error('Initialize request is missing.');
      onMessage?.({
        source: parent,
        data:
          outcome === 'success'
            ? {
                jsonrpc: '2.0',
                id: initializeRequestId,
                result: { protocolVersion: '2026-01-26' },
              }
            : {
                jsonrpc: '2.0',
                id: initializeRequestId,
                error: { code: -32601, message: 'Method not found' },
              },
      });
    },
    settleAction(outcome: 'success' | 'reject') {
      if (actionRequestId === undefined) throw new Error('Action request is missing.');
      onMessage?.({
        source: parent,
        data:
          outcome === 'success'
            ? { jsonrpc: '2.0', id: actionRequestId, result: {} }
            : {
                jsonrpc: '2.0',
                id: actionRequestId,
                error: { code: -32600, message: 'Rejected' },
              },
      });
    },
    pendingRequestTimeoutCount() {
      return manualTimeouts.size;
    },
    expireRequestTimeouts() {
      for (const [id, callback] of [...manualTimeouts]) {
        manualTimeouts.delete(id);
        callback();
      }
    },
  };
}

function descendantText(element: FakeElement | undefined): string {
  if (!element) return '';
  return [element.textContent, ...element.children.map(descendantText)].join('\n');
}

describe('Project-history Agent Draft App Host lifecycle', () => {
  it('renders every source boundary and never renders the one-time confirmation token', async () => {
    const app = await startApp();
    expect(app.outbound[0]).toMatchObject({
      method: 'ui/initialize',
      params: {
        appInfo: { name: 'combo-project-history-agent-draft', version: '0.8.4' },
        protocolVersion: '2026-01-26',
      },
    });
    expect(app.outbound[1]).toEqual({
      jsonrpc: '2.0',
      method: 'ui/notifications/initialized',
      params: {},
    });
    const sourceText = descendantText(app.elements.get('source'));
    for (const value of [
      'host_project_scoped_reduced_history',
      'user_selected_saved_project',
      'best_effort',
      'not_proven',
      'false',
      '4',
      '1',
      '8',
      '18',
      '2',
    ]) {
      expect(sourceText).toContain(value);
    }
    expect(app.elements.get('limitations')?.children.map((item) => item.textContent)).toEqual(
      payload.cardSnapshot.sourceDisclosure.limitationReasons,
    );
    expect([...app.elements.values()].map(descendantText).join('\n')).not.toContain(
      confirmationToken,
    );
    expect(PROJECT_HISTORY_AGENT_DRAFT_APP_HTML).not.toContain(confirmationToken);
  });

  it.each([
    {
      name: 'schema version',
      value: { ...payload, schemaVersion: 'combo.agent-package-draft-card/999' },
    },
    { name: 'top-level extra', value: { ...payload, rawTranscript: confirmationToken } },
    {
      name: 'confirmation envelope extra',
      value: { ...payload, confirmation: { ...payload.confirmation, projectId: 'private' } },
    },
    {
      name: 'confirmation envelope shape',
      value: { ...payload, confirmation: { ...payload.confirmation, confirmationToken: 'opaque' } },
    },
    {
      name: 'Draft/card content mismatch',
      value: {
        ...payload,
        cardSnapshot: {
          ...payload.cardSnapshot,
          content: { ...payload.cardSnapshot.content, instructions: 'tampered card only' },
        },
      },
    },
    {
      name: 'stale Draft fingerprint after coherent content tamper',
      value: {
        ...payload,
        draft: {
          ...payload.draft,
          content: { ...payload.draft.content, instructions: 'tampered' },
        },
        cardSnapshot: {
          ...payload.cardSnapshot,
          content: { ...payload.cardSnapshot.content, instructions: 'tampered' },
        },
      },
    },
    {
      name: 'candidate commitment',
      value: {
        ...payload,
        draft: {
          ...payload.draft,
          source: { ...payload.draft.source, candidateCommitment: `sha256:${'f'.repeat(64)}` },
        },
      },
    },
    { name: 'unsupported V3 revision', value: forgeRevisionTwoPayload() },
    {
      name: 'source count relationship',
      value: {
        ...payload,
        cardSnapshot: {
          ...payload.cardSnapshot,
          sourceDisclosure: { ...payload.cardSnapshot.sourceDisclosure, readThreadCount: 3 },
        },
      },
    },
    {
      name: 'source extra key',
      value: {
        ...payload,
        cardSnapshot: {
          ...payload.cardSnapshot,
          sourceDisclosure: { ...payload.cardSnapshot.sourceDisclosure, projectId: 'private' },
        },
      },
    },
    {
      name: 'share disclosure',
      value: {
        ...payload,
        cardSnapshot: {
          ...payload.cardSnapshot,
          shareDisclosure: { ...payload.cardSnapshot.shareDisclosure, revocation: 'supported' },
        },
      },
    },
    {
      name: 'fixed action message',
      value: {
        ...payload,
        actions: [{ ...payload.actions[0], message: '创建分享' }],
      },
    },
    {
      name: 'action extra key',
      value: {
        ...payload,
        actions: [{ ...payload.actions[0], confirmationToken }],
      },
    },
  ])(
    'fails closed for malformed $name with zero standard or compatibility send',
    async ({ value }) => {
      const app = await startApp({ structuredContent: value, legacyCompatibility: true });
      await app.elements.get('confirm')?.dispatch('click');

      expect(app.elements.get('confirm')?.hidden).toBe(true);
      expect(app.elements.get('confirm')?.disabled).toBe(true);
      expect(app.elements.get('status')?.textContent).toBe(
        '草稿数据未通过完整性校验。为避免误创建，当前卡片已停用。',
      );
      expect(app.elements.get('status')?.textContent).not.toContain(confirmationToken);
      expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(0);
      expect(app.compatibilityMessage).not.toHaveBeenCalled();
    },
  );

  it('rejects accessor payloads without invoking their getter', async () => {
    const accessorPayload = { ...payload } as Record<string, unknown>;
    let getterReads = 0;
    Object.defineProperty(accessorPayload, 'cardSnapshot', {
      enumerable: true,
      configurable: true,
      get() {
        getterReads += 1;
        return payload.cardSnapshot;
      },
    });

    const app = await startApp({ structuredContent: accessorPayload });

    expect(getterReads).toBe(0);
    expect(app.elements.get('confirm')?.hidden).toBe(true);
    expect(app.elements.get('status')?.textContent).toContain('完整性校验');
  });

  it('rejects symbol, hidden, dangerous, sparse, over-depth, and over-size snapshot shapes', async () => {
    const withSymbol = JSON.parse(JSON.stringify(payload)) as Record<PropertyKey, unknown>;
    withSymbol[Symbol('private')] = 'secret';

    const withHidden = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    Object.defineProperty(withHidden, 'hidden', { value: 'secret', enumerable: false });

    const withDangerousKey = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    Object.defineProperty(withDangerousKey, '__proto__', {
      value: { polluted: true },
      enumerable: true,
    });

    const withSparseArray = JSON.parse(JSON.stringify(payload)) as MutablePayload;
    const sparse = new Array<string>(2);
    sparse[0] = '检查发布。';
    withSparseArray.draft.content.starterPrompts = sparse;

    const withDeepValue = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    let cursor: Record<string, unknown> = {};
    withDeepValue.extra = cursor;
    for (let depth = 0; depth < 25; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    const withLargeValue = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    withLargeValue.extra = 'x'.repeat(262_145);

    for (const candidate of [
      withSymbol,
      withHidden,
      withDangerousKey,
      withSparseArray,
      withDeepValue,
      withLargeValue,
    ]) {
      const app = await startApp({ structuredContent: candidate });
      expect(app.elements.get('confirm')?.hidden).toBe(true);
      expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(0);
    }
  });

  it('hashes, validates, and renders one detached frozen snapshot across async digest work', async () => {
    const mutable = JSON.parse(JSON.stringify(payload)) as MutablePayload;
    let mutated = false;
    const app = await startApp({
      structuredContent: mutable,
      onDigest: () => {
        if (mutated) return;
        mutated = true;
        mutable.draft.content.name = '异步漂移名称';
        mutable.cardSnapshot.content.name = '异步漂移名称';
        mutable.cardSnapshot.title = '异步漂移名称';
        (mutable.actions[0] as { message: string }).message = '异步漂移确认';
      },
    });

    expect(mutated).toBe(true);
    expect(app.elements.get('title')?.textContent).toBe(payload.cardSnapshot.title);
    expect(descendantText(app.elements.get('content'))).toContain(
      payload.cardSnapshot.content.name,
    );
    expect(descendantText(app.elements.get('content'))).not.toContain('异步漂移名称');
    await app.elements.get('confirm')?.dispatch('click');
    await tick();
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toEqual([
      expect.objectContaining({
        params: {
          role: 'user',
          content: [{ type: 'text', text: PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_MESSAGE }],
        },
      }),
    ]);
  });

  it('reads a Proxy only through one descriptor snapshot and never re-reads it for rendering', async () => {
    const mutable = JSON.parse(JSON.stringify(payload)) as MutablePayload;
    const target = mutable.cardSnapshot.content;
    let propertyReads = 0;
    let ownKeyReads = 0;
    let descriptorReads = 0;
    const proxy = new Proxy(target, {
      get(targetValue, key, receiver) {
        propertyReads += 1;
        if (key === 'name' && propertyReads % 2 === 1) return '漂移名称';
        return Reflect.get(targetValue, key, receiver);
      },
      ownKeys(targetValue) {
        ownKeyReads += 1;
        return Reflect.ownKeys(targetValue);
      },
      getOwnPropertyDescriptor(targetValue, key) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(targetValue, key);
      },
    });
    mutable.cardSnapshot.content = proxy;

    const app = await startApp({ structuredContent: mutable });
    target.name = '快照后的外部变更';

    expect(propertyReads).toBe(0);
    expect(ownKeyReads).toBe(1);
    expect(descriptorReads).toBe(Object.keys(target).length);
    expect(app.elements.get('title')?.textContent).toBe(payload.cardSnapshot.title);
    expect(descendantText(app.elements.get('content'))).toContain(
      payload.cardSnapshot.content.name,
    );
    expect(descendantText(app.elements.get('content'))).not.toContain('漂移名称');
    expect(descendantText(app.elements.get('content'))).not.toContain('快照后的外部变更');
  });

  it.each([
    {
      name: 'noncanonical Agent name markup',
      mutate: ({ content: candidate }: ForgedPayloadInput) => {
        candidate.name = '<script>';
      },
    },
    {
      name: 'multiline starter prompt',
      mutate: ({ content: candidate }: ForgedPayloadInput) => {
        candidate.starterPrompts = ['检查\n发布。'];
      },
    },
    {
      name: 'format-control character',
      mutate: ({ content: candidate }: ForgedPayloadInput) => {
        candidate.instructions = '先核对\u2066，再验证。';
      },
    },
    {
      name: 'lone surrogate',
      mutate: ({ content: candidate }: ForgedPayloadInput) => {
        candidate.instructions = '先核对\ud800，再验证。';
      },
    },
    ...[`s1.${'A'.repeat(43)}`, `mat1.${'B'.repeat(43)}`, `cfrm_${'C'.repeat(43)}`].map(
      (secret) => ({
        name: `first-party secret ${secret.slice(0, 5)}`,
        mutate: ({ content: candidate }: ForgedPayloadInput) => {
          candidate.outputDescription = `结果 ${secret}`;
        },
      }),
    ),
    ...['projectId: private-123', 'source_thread_id=private-456'].map((identifier) => ({
      name: `Host identity ${identifier.split(/[:=]/u)[0]}`,
      mutate: ({ creatorRequest: request }: ForgedPayloadInput) => {
        request.request = `复用 ${identifier}`;
      },
    })),
    {
      name: 'source URL',
      mutate: ({ content: candidate }: ForgedPayloadInput) => {
        candidate.instructions = '从 https://private.example/internal 读取。';
      },
    },
    {
      name: 'absolute local path',
      mutate: ({ content: candidate }: ForgedPayloadInput) => {
        candidate.instructions = '读取 /Users/alice/private.txt。';
      },
    },
  ])('rejects an internally consistent Draft containing $name', async ({ mutate }) => {
    const app = await startApp({
      structuredContent: forgeInternallyConsistentPayload(mutate),
      legacyCompatibility: true,
    });
    await app.elements.get('confirm')?.dispatch('click');

    expect(app.elements.get('confirm')?.hidden).toBe(true);
    expect(app.elements.get('confirm')?.disabled).toBe(true);
    expect(app.elements.get('status')?.textContent).toBe(
      '草稿数据未通过完整性校验。为避免误创建，当前卡片已停用。',
    );
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(0);
    expect(app.compatibilityMessage).not.toHaveBeenCalled();
  });

  it('keeps portable consumer-relative guidance and public client IDs confirmable', async () => {
    const portable = forgeInternallyConsistentPayload(({ content: candidate }) => {
      candidate.instructions = `Review docs/release.md and AGENTS.md using 输入/输出; public client mcp_client_${'D'.repeat(43)}.`;
    });
    const app = await startApp({ structuredContent: portable });

    expect(app.elements.get('confirm')?.hidden).toBe(false);
    expect(app.elements.get('confirm')?.disabled).toBe(false);
    await app.elements.get('confirm')?.dispatch('click');
    await tick();
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(1);
  });

  it('prefers one standard ui/message with the exact fixed whole-message and locks immediately', async () => {
    const app = await startApp();
    const button = app.elements.get('confirm');
    const first = button?.dispatch('click');
    await button?.dispatch('click');
    await first;
    await tick();

    expect(app.outbound.filter((message) => message.method === 'ui/message')).toEqual([
      expect.objectContaining({
        params: {
          role: 'user',
          content: [{ type: 'text', text: PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_MESSAGE }],
        },
      }),
    ]);
    expect(app.compatibilityMessage).not.toHaveBeenCalled();
    expect(button?.disabled).toBe(true);
    expect(app.elements.get('status')?.textContent).toContain('正在等待 Codex');
  });

  it('ignores replacement tool results while the fixed confirmation is sending or locked', async () => {
    const replacement = forgeInternallyConsistentPayload(({ content: candidate }) => {
      candidate.instructions = '这是发送中不得换入的另一份运行指令。';
    });
    const app = await startApp({
      deferActionResponse: true,
      manualRequestTimeouts: true,
    });
    const button = app.elements.get('confirm');
    const send = button?.dispatch('click');
    await tick();

    app.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: replacement },
    });
    await tick();
    expect(descendantText(app.elements.get('content'))).toContain(
      payload.draft.content.instructions,
    );
    expect(descendantText(app.elements.get('content'))).not.toContain(
      replacement.draft.content.instructions,
    );

    app.settleAction('success');
    await send;
    app.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: replacement },
    });
    await tick();
    await button?.dispatch('click');

    expect(descendantText(app.elements.get('content'))).toContain(
      payload.draft.content.instructions,
    );
    expect(descendantText(app.elements.get('content'))).not.toContain(
      replacement.draft.content.instructions,
    );
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(1);
    expect(app.compatibilityMessage).not.toHaveBeenCalled();
  });

  it.each(['reject', 'timeout'] as const)(
    'keeps the create action locked after a %s result and never repeats it',
    async (actionResponse) => {
      const app = await startApp({
        actionResponse,
        manualRequestTimeouts: actionResponse === 'timeout',
      });
      const button = app.elements.get('confirm');
      const first = button?.dispatch('click');
      if (actionResponse === 'timeout') app.expireRequestTimeouts();
      await first;
      await button?.dispatch('click');

      expect(button?.disabled).toBe(true);
      expect(app.elements.get('status')?.textContent).toContain('发送状态不确定');
      expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(1);
    },
  );

  it('uses the compatibility helper only when standard Host initialization is unavailable', async () => {
    const app = await startApp({ initializeFailure: true, legacyCompatibility: true });
    await app.elements.get('confirm')?.dispatch('click');

    expect(app.compatibilityMessage).toHaveBeenCalledOnce();
    expect(app.compatibilityMessage).toHaveBeenCalledWith({
      prompt: PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_MESSAGE,
      scrollToBottom: true,
    });
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(0);
  });

  it('keeps a valid legacy payload inert while standard initialization is still pending', async () => {
    const app = await startApp({
      deferInitialize: true,
      legacyCompatibility: true,
    });
    const button = app.elements.get('confirm');

    await button?.dispatch('click');
    expect(button?.hidden).toBe(true);
    expect(button?.disabled).toBe(true);
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(0);
    expect(app.compatibilityMessage).not.toHaveBeenCalled();

    app.settleInitialize('success');
    for (let index = 0; index < 8; index += 1) await tick();
    expect(button?.hidden).toBe(false);
    expect(button?.disabled).toBe(false);

    await button?.dispatch('click');
    await tick();
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(1);
    expect(app.compatibilityMessage).not.toHaveBeenCalled();
  });

  it('enables exactly one compatibility send only after standard initialization is unavailable', async () => {
    const app = await startApp({
      deferInitialize: true,
      legacyCompatibility: true,
    });
    const button = app.elements.get('confirm');

    await button?.dispatch('click');
    expect(app.compatibilityMessage).not.toHaveBeenCalled();

    app.settleInitialize('reject');
    await tick();
    expect(button?.hidden).toBe(false);
    expect(button?.disabled).toBe(false);

    await button?.dispatch('click');
    await button?.dispatch('click');
    expect(app.compatibilityMessage).toHaveBeenCalledOnce();
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(0);
  });

  it.each(['reject', 'timeout'] as const)(
    'fails closed with no legacy payload when Host initialization ends in %s',
    async (failure) => {
      const app = await startApp({
        initializeFailure: failure === 'reject',
        initializeTimeout: failure === 'timeout',
        manualRequestTimeouts: failure === 'timeout',
      });
      if (failure === 'timeout') {
        app.expireRequestTimeouts();
        await tick();
      }
      await app.elements.get('confirm')?.dispatch('click');

      expect(app.elements.get('confirm')?.disabled).toBe(true);
      expect(app.elements.get('confirm')?.hidden).toBe(true);
      expect(app.elements.get('status')?.textContent).toBe(
        '无法初始化 Codex 卡片。为避免误创建，当前卡片已停用。',
      );
      expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(0);
      expect(app.compatibilityMessage).not.toHaveBeenCalled();
    },
  );

  it('ACKs teardown exactly once and permanently disables every follow-up bridge', async () => {
    const app = await startApp();
    app.deliver({ jsonrpc: '2.0', id: 91, method: 'ui/resource-teardown', params: {} });
    await app.elements.get('confirm')?.dispatch('click');

    expect(app.outbound.filter((message) => message.id === 91)).toEqual([
      { jsonrpc: '2.0', id: 91, result: {} },
    ]);
    expect(app.elements.get('confirm')?.disabled).toBe(true);
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(0);
    expect(app.compatibilityMessage).not.toHaveBeenCalled();
  });

  it('settles an in-flight standard send on teardown and ignores its late response', async () => {
    const app = await startApp({
      deferActionResponse: true,
      manualRequestTimeouts: true,
    });
    const send = app.elements.get('confirm')?.dispatch('click');
    await tick();
    expect(app.pendingRequestTimeoutCount()).toBe(1);

    app.deliver({ jsonrpc: '2.0', id: 92, method: 'ui/resource-teardown', params: {} });
    expect(app.pendingRequestTimeoutCount()).toBe(0);
    expect(app.elements.get('status')?.textContent).toBe(
      '卡片已关闭。当前卡片不会再发送任何确认。',
    );

    app.settleAction('success');
    await send;
    await tick();
    expect(app.elements.get('status')?.textContent).toBe(
      '卡片已关闭。当前卡片不会再发送任何确认。',
    );
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(1);
    expect(app.compatibilityMessage).not.toHaveBeenCalled();
  });

  it('locks into a fixed cancelled state without echoing Host reason or sending compatibility follow-up', async () => {
    const app = await startApp({ initializeFailure: true, legacyCompatibility: true });
    app.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-cancelled',
      params: { reason: confirmationToken },
    });
    await app.elements.get('confirm')?.dispatch('click');

    expect(app.elements.get('confirm')?.disabled).toBe(true);
    expect(app.elements.get('status')?.textContent).toBe(
      '草稿调用已取消。为避免误创建，当前卡片已停用。',
    );
    expect(app.elements.get('status')?.textContent).not.toContain(confirmationToken);
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(0);
    expect(app.compatibilityMessage).not.toHaveBeenCalled();
  });

  it('settles an in-flight standard send on cancellation and ignores its late failure', async () => {
    const app = await startApp({
      deferActionResponse: true,
      manualRequestTimeouts: true,
    });
    const send = app.elements.get('confirm')?.dispatch('click');
    await tick();
    expect(app.pendingRequestTimeoutCount()).toBe(1);

    app.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-cancelled',
      params: { reason: confirmationToken },
    });
    expect(app.pendingRequestTimeoutCount()).toBe(0);
    expect(app.elements.get('status')?.textContent).toBe(
      '草稿调用已取消。为避免误创建，当前卡片已停用。',
    );

    app.settleAction('reject');
    await send;
    await tick();
    expect(app.elements.get('status')?.textContent).toBe(
      '草稿调用已取消。为避免误创建，当前卡片已停用。',
    );
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(1);
    expect(app.compatibilityMessage).not.toHaveBeenCalled();
  });
});
