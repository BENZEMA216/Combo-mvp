import type {
  PendingUsageRecoveryView,
  RecoveryRechargeOrderView,
  ReleaseMetadata,
  SessionDetail,
} from '@cb/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, StrictMode, type PropsWithChildren, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReleaseMetadataProvider } from '../shell/releaseIdentity.js';
import { getRechargeOrderByRecovery } from './billing.js';
import { ApiError } from './client.js';
import {
  abandonPendingUsageRecovery,
  coordinateRecoveryResume,
  getPendingUsageRecovery,
  resolvePendingRecoveryForSession,
} from './recovery.js';
import type * as RecoveryApi from './recovery.js';
import { readRechargeRequired, sendSessionMessage } from './runtime.js';
import { useSessionStream } from './useSessionStream.js';

vi.mock('./runtime.js', () => ({
  interruptSession: vi.fn(async () => ({ interrupted: false })),
  readRechargeRequired: vi.fn(() => null),
  sendSessionMessage: vi.fn(),
}));
vi.mock('./billing.js', () => ({ getRechargeOrderByRecovery: vi.fn() }));
vi.mock('./recovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RecoveryApi>();
  return {
    ...actual,
    abandonPendingUsageRecovery: vi.fn(),
    coordinateRecoveryResume: vi.fn(),
    getPendingUsageRecovery: vi.fn(),
    resolvePendingRecoveryForSession: vi.fn(),
  };
});

const sendMock = vi.mocked(sendSessionMessage);
const readRechargeMock = vi.mocked(readRechargeRequired);
const orderByRecoveryMock = vi.mocked(getRechargeOrderByRecovery);
const abandonMock = vi.mocked(abandonPendingUsageRecovery);
const coordinateMock = vi.mocked(coordinateRecoveryResume);
const exactRecoveryMock = vi.mocked(getPendingUsageRecovery);
const resolveRecoveryMock = vi.mocked(resolvePendingRecoveryForSession);

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CAPABILITY_ID = '33333333-3333-4333-8333-333333333333';
const TURN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REPLACEMENT_INTENT = '77777777-7777-4777-8777-777777777777';
const OLD_CREDITED_INTENT = '88888888-8888-4888-8888-888888888888';
const DETAIL = knowledgeDetail();
const PREVIEW_METADATA: ReleaseMetadata = {
  schemaVersion: 1,
  environment: 'preview',
  sourceSha: 'a'.repeat(40),
  releaseId: `release-${'a'.repeat(40)}`,
  builtAt: '2026-09-02T00:00:00.000Z',
  releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
  webAssetManifest: `sha256:${'c'.repeat(64)}`,
};

class MockEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: memoryStorage(),
  });
  window.sessionStorage.clear();
  vi.stubGlobal('EventSource', MockEventSource);
  sendMock.mockReset();
  readRechargeMock.mockReset();
  readRechargeMock.mockReturnValue(null);
  orderByRecoveryMock.mockReset();
  orderByRecoveryMock.mockResolvedValue(null);
  abandonMock.mockReset();
  abandonMock.mockResolvedValue({ abandoned: true });
  coordinateMock.mockReset();
  exactRecoveryMock.mockReset();
  coordinateMock.mockImplementation(async (usageId, action) =>
    action(await exactRecoveryMock(usageId), { signal: new AbortController().signal }),
  );
  resolveRecoveryMock.mockReset();
  resolveRecoveryMock.mockResolvedValue(null);
});

afterEach(() => vi.unstubAllGlobals());

describe('knowledge recovery uses server truth', () => {
  it('restores the exact server request after restart and discards stale browser state', async () => {
    const recovery = recoveryView(OLD_CREDITED_INTENT, 'server-owned request');
    resolveRecoveryMock.mockResolvedValue(recovery);
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.sessionStorage.setItem(
      `combo:pending-usage:v2:${SESSION_ID}`,
      JSON.stringify({
        version: 2,
        sessionId: SESSION_ID,
        text: 'stale browser request',
        usageId: '99999999-9999-4999-8999-999999999999',
        reason: 'recharge_required',
        activeRechargeIntentId: '99999999-9999-4999-8999-999999999999',
      }),
    );
    const { result } = renderHook(() => useSessionStream(SESSION_ID, DETAIL), {
      wrapper: wrapper(),
    });

    await vi.waitFor(() => expect(result.current.pendingRecovery).toEqual(recovery));
    expect(result.current.pendingRetryAvailable).toBe(true);
    expect(result.current.recoveryDialogOpen).toBe(true);
    expect(window.sessionStorage.length).toBe(0);
    await act(async () => result.current.retryPending());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fails closed when the recovered Package binding differs from the Session', async () => {
    const recovery = recoveryView(OLD_CREDITED_INTENT, 'bound request');
    resolveRecoveryMock.mockResolvedValue({
      ...recovery,
      binding: {
        ...recovery.binding,
        release: {
          ...recovery.binding.release,
          packageDigest: `sha256:${'9'.repeat(64)}`,
        },
      },
    });
    const { result } = renderHook(() => useSessionStream(SESSION_ID, DETAIL), {
      wrapper: wrapper(),
    });

    await vi.waitFor(() =>
      expect(result.current.errorMessage).toBe('无法确认服务端待恢复任务，已停止付款。'),
    );
    expect(result.current.pendingRecovery).toBeNull();
    expect(result.current.recoveryDialogOpen).toBe(false);
  });

  it.each(['new', 'legacy'] as const)(
    'validates a strict %s 402 against exact text, Package binding, intent and frozen price',
    async (kind) => {
      sendMock.mockRejectedValueOnce(new ApiError('recharge', 402));
      readRechargeMock.mockImplementation((_error, usageId) => ({
        rechargeRequired: true,
        ...(kind === 'new' ? { recoveryUsageId: usageId } : {}),
        rechargeIntentId: kind === 'new' ? REPLACEMENT_INTENT : usageId,
        balanceCents: '0',
        requiredCents: '100',
      }));
      exactRecoveryMock.mockImplementation(async (usageId) =>
        recoveryView(usageId, 'exact paid question', kind === 'new' ? REPLACEMENT_INTENT : usageId),
      );
      const { result } = renderHook(() => useSessionStream(SESSION_ID, DETAIL), {
        wrapper: wrapper(),
      });
      await vi.waitFor(() => expect(resolveRecoveryMock).toHaveBeenCalled());

      await act(async () => {
        await expect(result.current.send('exact paid question')).rejects.toThrow('免费次数已用完');
      });
      const usageId = sendMock.mock.calls[0]![2];
      expect(exactRecoveryMock).toHaveBeenCalledWith(usageId);
      expect(result.current.pendingRecovery).toMatchObject({
        usageId,
        requestText: 'exact paid question',
        activeRechargeIntentId: kind === 'new' ? REPLACEMENT_INTENT : usageId,
      });
      expect(result.current.recoveryDialogOpen).toBe(true);
      expect(window.sessionStorage.length).toBe(0);
    },
  );

  it('does not enable payment when a 402 has no exact server recovery row', async () => {
    sendMock.mockRejectedValueOnce(new ApiError('recharge', 402));
    readRechargeMock.mockImplementation((_error, usageId) => ({
      rechargeRequired: true,
      recoveryUsageId: usageId,
      rechargeIntentId: usageId,
      balanceCents: '0',
      requiredCents: '100',
    }));
    exactRecoveryMock.mockRejectedValueOnce(new ApiError('missing', 404));
    const { result } = renderHook(() => useSessionStream(SESSION_ID, DETAIL), {
      wrapper: wrapper(),
    });
    await vi.waitFor(() => expect(resolveRecoveryMock).toHaveBeenCalled());

    await act(async () => {
      await expect(result.current.send('missing recovery')).rejects.toThrow('已停止付款');
    });
    expect(result.current.pendingRecovery).toBeNull();
    expect(result.current.recoveryDialogOpen).toBe(false);
    expect(result.current.pendingRetryAvailable).toBe(true);
  });

  it('uses credited-old priority and deduplicates concurrent resume calls', async () => {
    const recovery = recoveryView(OLD_CREDITED_INTENT, 'resume exact request', REPLACEMENT_INTENT);
    resolveRecoveryMock.mockResolvedValue(recovery);
    exactRecoveryMock.mockResolvedValue(recovery);
    orderByRecoveryMock.mockResolvedValue(
      recoveryOrder(recovery.usageId, OLD_CREDITED_INTENT, 'credited'),
    );
    sendMock.mockResolvedValueOnce({
      message: {
        id: '55555555-5555-4555-8555-555555555555',
        seq: 1,
        turnId: TURN_ID,
        role: 'user',
        content: [{ type: 'text', text: recovery.requestText }],
        status: 'completed',
        createdAt: '2026-09-02T00:02:00.000Z',
      },
      replayed: true,
    });
    const { result } = renderHook(() => useSessionStream(SESSION_ID, DETAIL), {
      wrapper: strictWrapper(),
    });
    await vi.waitFor(() => expect(result.current.pendingRecovery).toEqual(recovery));

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = result.current.resumeAfterRecharge(OLD_CREDITED_INTENT);
      duplicate = result.current.resumeAfterRecharge(OLD_CREDITED_INTENT);
    });
    expect(first).toBe(duplicate);
    await act(async () => Promise.all([first, duplicate]));

    expect(orderByRecoveryMock).toHaveBeenCalledWith(recovery.usageId);
    expect(coordinateMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      SESSION_ID,
      recovery.requestText,
      recovery.usageId,
      expect.anything(),
    );
    expect(result.current.pendingRecovery).toBeNull();
  });

  it('keeps exact server recovery visible when bounded resume fails closed', async () => {
    const recovery = recoveryView(OLD_CREDITED_INTENT, 'server-owned bounded resume');
    resolveRecoveryMock.mockResolvedValue(recovery);
    exactRecoveryMock.mockResolvedValue(recovery);
    orderByRecoveryMock.mockResolvedValue(
      recoveryOrder(recovery.usageId, OLD_CREDITED_INTENT, 'credited'),
    );
    coordinateMock.mockRejectedValueOnce(new Error('原任务恢复超时，服务端恢复状态保持不变。'));
    const { result } = renderHook(() => useSessionStream(SESSION_ID, DETAIL), {
      wrapper: wrapper(),
    });
    await vi.waitFor(() => expect(result.current.pendingRecovery).toEqual(recovery));

    await act(async () => {
      await expect(result.current.resumeAfterRecharge(OLD_CREDITED_INTENT)).rejects.toThrow(
        '原任务恢复超时',
      );
    });

    expect(result.current.pendingRecovery).toEqual(recovery);
    expect(result.current.recoveryDialogOpen).toBe(true);
  });

  it('keeps recovery visible on abandon 409 and clears it only after success', async () => {
    const recovery = recoveryView(OLD_CREDITED_INTENT, 'abandon exact request');
    resolveRecoveryMock.mockResolvedValue(recovery);
    abandonMock
      .mockRejectedValueOnce(new ApiError('任务正在恢复', 409))
      .mockResolvedValueOnce({ abandoned: true });
    const { result } = renderHook(() => useSessionStream(SESSION_ID, DETAIL), {
      wrapper: wrapper(),
    });
    await vi.waitFor(() => expect(result.current.pendingRecovery).toEqual(recovery));

    await act(async () => {
      await expect(result.current.abandonRechargeUsage()).rejects.toMatchObject({ status: 409 });
    });
    expect(result.current.pendingRecovery).toEqual(recovery);
    expect(result.current.recoveryDialogOpen).toBe(true);

    await act(async () => result.current.abandonRechargeUsage());
    expect(result.current.pendingRecovery).toBeNull();
    expect(result.current.recoveryDialogOpen).toBe(false);
  });
});

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren): ReactElement {
    return createElement(ReleaseMetadataProvider, {
      metadata: PREVIEW_METADATA,
      children: createElement(QueryClientProvider, { client: queryClient, children }),
    });
  };
}

function strictWrapper() {
  const Wrapper = wrapper();
  return function StrictWrapper({ children }: PropsWithChildren): ReactElement {
    return createElement(StrictMode, null, createElement(Wrapper, { children }));
  };
}

function knowledgeDetail(): SessionDetail {
  return {
    session: {
      id: SESSION_ID,
      capabilityId: CAPABILITY_ID,
      mode: 'consume',
      status: 'active',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    },
    capability: {
      id: CAPABILITY_ID,
      name: 'Combo Knowledge',
      summary: '',
      kind: 'knowledge',
      inputs: [],
      starterPrompts: [],
    },
    messages: [],
    artifacts: [],
    activeTurn: null,
    currentUiArtifactId: null,
    agentBinding: {
      productKind: 'knowledge_agent_test',
      capability: { id: CAPABILITY_ID, protocol: 'combo.agent-package-capability/2' },
      release: {
        protocol: 'combo.agent-package-release/1',
        releaseId: `release.agent-package.${'a'.repeat(32)}`,
        packageDigest: `sha256:${'b'.repeat(64)}`,
      },
      releaseScope: 'controlled_test',
      knowledge: {
        protocol: 'combo.knowledge-bundle/1',
        resourcePath: 'skills/knowledge/references/knowledge-bundle.json',
        resourceDigest: `sha256:${'c'.repeat(64)}`,
      },
    },
    knowledgeResults: [],
  };
}

function recoveryView(
  usageId: string,
  requestText: string,
  activeRechargeIntentId = usageId,
): PendingUsageRecoveryView {
  return {
    usageId,
    sessionId: SESSION_ID,
    capabilityId: CAPABILITY_ID,
    requestText,
    requestFingerprint: '4'.repeat(64),
    binding: DETAIL.agentBinding as PendingUsageRecoveryView['binding'],
    billing: {
      currency: 'CNY',
      policyVersion: 'runtime-usage-v1',
      validatorPolicyVersion: 'knowledge-agent-grounded-validator-v2',
      unitPriceCents: '100',
      freeLimitSnapshot: 3,
    },
    status: 'active',
    activeRechargeIntentId,
    expiresAt: '2026-09-03T00:00:00.000Z',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:01:00.000Z',
  };
}

function recoveryOrder(
  recoveryUsageId: string,
  rechargeIntentId: string,
  status: RecoveryRechargeOrderView['status'],
): RecoveryRechargeOrderView {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    recoveryUsageId,
    rechargeIntentId,
    amountCents: '100',
    channel: 'qr',
    payType: 'alipay',
    status,
    reconciliationActive: false,
    createdAt: '2026-09-02T00:02:00.000Z',
    updatedAt: '2026-09-02T00:03:00.000Z',
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
