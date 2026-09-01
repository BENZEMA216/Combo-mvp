import type { KnowledgeAgentBinding, PendingUsageRecoveryView } from '@cb/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  abandonPendingUsageRecovery,
  coordinateRecoveryResume,
  pendingRecoveryMatchesBinding,
  resolveHostedPendingRecovery,
  resolvePendingRecoveryForSession,
} from './recovery.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const USAGE_ID = '22222222-2222-4222-8222-222222222222';
const CAPABILITY_ID = '33333333-3333-4333-8333-333333333333';
const INTENT_ID = '44444444-4444-4444-8444-444444444444';

const binding: KnowledgeAgentBinding = {
  productKind: 'knowledge_agent_test',
  capability: { id: CAPABILITY_ID, protocol: 'combo.agent-package-capability/2' },
  release: {
    protocol: 'combo.agent-package-release/1',
    releaseId: `release.agent-package.${'1'.repeat(32)}`,
    packageDigest: `sha256:${'2'.repeat(64)}`,
  },
  releaseScope: 'controlled_test',
  knowledge: {
    protocol: 'combo.knowledge-bundle/1',
    resourcePath: 'skills/knowledge/references/knowledge-bundle.json',
    resourceDigest: `sha256:${'3'.repeat(64)}`,
  },
};

const recovery: PendingUsageRecoveryView = {
  usageId: USAGE_ID,
  sessionId: SESSION_ID,
  capabilityId: CAPABILITY_ID,
  requestText: '前三次免费额度用完以后会怎样？',
  requestFingerprint: '4'.repeat(64),
  binding,
  billing: {
    currency: 'CNY',
    policyVersion: 'runtime-usage-v1',
    validatorPolicyVersion: 'knowledge-agent-grounded-validator-v2',
    unitPriceCents: '100',
    freeLimitSnapshot: 3,
  },
  status: 'active',
  activeRechargeIntentId: INTENT_ID,
  expiresAt: '2026-09-03T00:00:00.000Z',
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:01:00.000Z',
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
    } satisfies Storage,
  });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pending usage recovery server truth', () => {
  it('resolves one Session recovery through list then exact GET without browser storage', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, { data: { recoveries: [recovery] }, meta: { traceId: 'list' } }),
      )
      .mockResolvedValueOnce(response(200, { data: { recovery }, meta: { traceId: 'exact' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolvePendingRecoveryForSession(SESSION_ID)).resolves.toEqual(recovery);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/v1/runtime/pending-usage-recoveries?sessionId=${SESSION_ID}`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/runtime/pending-usage-recoveries/${USAGE_ID}`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('resolves the hosted entry through an unscoped list then exact GET', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, { data: { recoveries: [recovery] }, meta: { traceId: 'list' } }),
      )
      .mockResolvedValueOnce(response(200, { data: { recovery }, meta: { traceId: 'exact' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveHostedPendingRecovery()).resolves.toEqual(recovery);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/runtime/pending-usage-recoveries',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/runtime/pending-usage-recoveries/${USAGE_ID}`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('fails closed when the hosted entry sees more than one pending server row', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      response(200, {
        data: {
          recoveries: [
            recovery,
            {
              ...recovery,
              usageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            },
          ],
        },
        meta: { traceId: 'ambiguous-list' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveHostedPendingRecovery()).rejects.toThrow('待恢复任务与服务端状态不一致');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when list and exact server truth disagree or carry extra fields', async () => {
    for (const exact of [
      { ...recovery, activeRechargeIntentId: USAGE_ID },
      { ...recovery, internalOwnerId: 'private' },
    ]) {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          response(200, { data: { recoveries: [recovery] }, meta: { traceId: 'list' } }),
        )
        .mockResolvedValueOnce(
          response(200, { data: { recovery: exact }, meta: { traceId: 'exact' } }),
        );
      vi.stubGlobal('fetch', fetchMock);
      await expect(resolvePendingRecoveryForSession(SESSION_ID)).rejects.toThrow(
        '待恢复任务与服务端状态不一致',
      );
    }
  });

  it('requires the exact frozen Session binding before enabling payment', () => {
    expect(pendingRecoveryMatchesBinding(recovery, SESSION_ID, binding)).toBe(true);
    expect(
      pendingRecoveryMatchesBinding(recovery, SESSION_ID, {
        ...binding,
        release: { ...binding.release, packageDigest: `sha256:${'9'.repeat(64)}` },
      }),
    ).toBe(false);
    expect(pendingRecoveryMatchesBinding(recovery, INTENT_ID, binding)).toBe(false);
  });

  it('abandons only through the server endpoint and propagates 409 without local success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { data: { abandoned: true }, meta: { traceId: 'ok' } }))
      .mockResolvedValueOnce(
        response(409, {
          error: { userMessage: '任务正在恢复，不能放弃。', traceId: 'busy' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(abandonPendingUsageRecovery(USAGE_ID)).resolves.toEqual({ abandoned: true });
    await expect(abandonPendingUsageRecovery(USAGE_ID)).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/runtime/pending-usage-recoveries/${USAGE_ID}/abandon`,
      expect.objectContaining({ method: 'POST', body: undefined }),
    );
  });

  it('deduplicates concurrent StrictMode and multitab resume attempts before the business POST', async () => {
    let held = Promise.resolve();
    const request = vi.fn(
      async (
        _name: string,
        optionsOrCallback: LockOptions | (() => Promise<void>),
        maybeCallback?: () => Promise<void>,
      ) => {
        const callback =
          typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
        const previous = held;
        let release!: () => void;
        held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, { data: { recovery }, meta: { traceId: 'locked-exact' } }),
      )
      .mockResolvedValueOnce(
        response(404, {
          error: { userMessage: '待恢复任务不存在。', traceId: 'already-resumed' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const businessPost = vi.fn(async () => undefined);

    await Promise.all([
      coordinateRecoveryResume(USAGE_ID, businessPost),
      coordinateRecoveryResume(USAGE_ID, businessPost),
    ]);
    await coordinateRecoveryResume(USAGE_ID, businessPost);

    expect(request).toHaveBeenCalled();
    expect(businessPost).toHaveBeenCalledTimes(1);
    expect(businessPost).toHaveBeenCalledWith(recovery);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed without a browser-wide lock and sends no business POST', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const businessPost = vi.fn(async () => undefined);

    await expect(coordinateRecoveryResume(USAGE_ID, businessPost)).rejects.toThrow(
      '当前浏览器无法安全协调多标签恢复',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(businessPost).not.toHaveBeenCalled();
  });
});
