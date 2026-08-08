import type { MessageView, ReleaseMetadata, SessionDetail } from '@cb/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type PropsWithChildren, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseMetadataProvider } from '../shell/releaseIdentity.js';
import {
  readRechargeRequired,
  sendSessionMessage,
  type SendSessionMessageResult,
} from './runtime.js';
import { sortArtifacts, subscribeSessionEvents, useSessionStream } from './useSessionStream.js';

vi.mock('./runtime.js', () => ({
  interruptSession: vi.fn(async () => ({ interrupted: false })),
  readRechargeRequired: vi.fn(() => null),
  sendSessionMessage: vi.fn(),
}));

const sendSessionMessageMock = vi.mocked(sendSessionMessage);
const readRechargeRequiredMock = vi.mocked(readRechargeRequired);
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const TURN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TURN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PREVIEW_METADATA: ReleaseMetadata = {
  schemaVersion: 1,
  environment: 'preview',
  sourceSha: 'a'.repeat(40),
  releaseId: `release-${'a'.repeat(40)}`,
  builtAt: '2026-07-25T00:00:00.000Z',
  releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
  webAssetManifest: `sha256:${'c'.repeat(64)}`,
};

class MockEventSource {
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(
    readonly url: string,
    readonly options: EventSourceInit,
  ) {
    MockEventSource.instances.push(this);
  }

  failClosed(): void {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  MockEventSource.instances = [];
});

beforeEach(() => {
  window.sessionStorage.clear();
  sendSessionMessageMock.mockReset();
  readRechargeRequiredMock.mockReset();
  readRechargeRequiredMock.mockReturnValue(null);
});

describe('runtime session EventSource fixed-session behavior', () => {
  it('uses the shared HttpOnly cookie and never calls a refresh endpoint', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const onFatal = vi.fn();

    const stop = subscribeSessionEvents('/stream', { onMessage: vi.fn(), onFatal });
    const source = MockEventSource.instances[0]!;
    expect(source.options.withCredentials).toBe(true);

    source.failClosed();

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    stop();
  });

  it('reports a closed stream only once and closes it during cleanup', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const onFatal = vi.fn();
    const stop = subscribeSessionEvents('/stream', { onMessage: vi.fn(), onFatal });
    const source = MockEventSource.instances[0]!;

    source.failClosed();
    source.failClosed();
    expect(onFatal).toHaveBeenCalledTimes(1);

    stop();
    expect(source.close).toHaveBeenCalled();
  });

  it('ignores queued events after the subscription is stopped', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const onMessage = vi.fn();
    const stop = subscribeSessionEvents('/stream', { onMessage, onFatal: vi.fn() });
    const source = MockEventSource.instances[0]!;

    stop();
    source.onmessage?.(new MessageEvent('message', { data: '{"type":"RUN_STARTED"}' }));
    source.onopen?.();
    source.onerror?.();

    expect(source.close).toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('runtime session generation fencing', () => {
  it('uses one synchronous in-flight lock for all send callers', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const pending = deferred<SendSessionMessageResult>();
    sendSessionMessageMock.mockReturnValueOnce(pending.promise);
    const queryClient = testQueryClient();
    const detail = sessionDetail(SESSION_A);
    const { result } = renderHook(() => useSessionStream(SESSION_A, detail), {
      wrapper: testWrapper(queryClient),
    });

    let accepted!: Promise<MessageView>;
    let duplicate!: Promise<MessageView>;
    act(() => {
      accepted = result.current.send('first request');
      duplicate = result.current.send('duplicate request');
    });

    await expect(duplicate).rejects.toThrow('Agent 正在处理当前任务');
    expect(sendSessionMessageMock).toHaveBeenCalledTimes(1);
    expect(sendSessionMessageMock).toHaveBeenCalledWith(
      SESSION_A,
      'first request',
      expect.any(String),
    );

    await act(async () => {
      pending.resolve(gatewayResponse(TURN_A));
      await accepted;
    });
    expect(result.current.activeRunId).toBe(TURN_A);
  });

  it('reuses the same usageId after an uncertain failure and rotates it after acceptance', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    sendSessionMessageMock
      .mockRejectedValueOnce(new Error('network lost'))
      .mockResolvedValueOnce(gatewayResponse(TURN_A))
      .mockRejectedValueOnce(new Error('second failure'));
    const queryClient = testQueryClient();
    const detail = sessionDetail(SESSION_A);
    const { result } = renderHook(() => useSessionStream(SESSION_A, detail), {
      wrapper: testWrapper(queryClient),
    });

    await act(async () => {
      await expect(result.current.send('same request')).rejects.toThrow('发送失败');
    });
    await act(async () => {
      await result.current.send('same request');
    });
    const firstUsageId = sendSessionMessageMock.mock.calls[0]?.[2];
    expect(firstUsageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(sendSessionMessageMock.mock.calls[1]?.[2]).toBe(firstUsageId);

    act(() => {
      MockEventSource.instances[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'RUN_FINISHED', runId: TURN_A }),
        }),
      );
    });
    await vi.waitFor(() => expect(result.current.running).toBe(false));

    await act(async () => {
      await expect(result.current.send('same request')).rejects.toThrow('发送失败');
    });
    expect(sendSessionMessageMock.mock.calls[2]?.[2]).not.toBe(firstUsageId);
  });

  it('keeps an uncertain usageId across a component remount and blocks a different request', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    sendSessionMessageMock
      .mockRejectedValueOnce(new Error('network lost'))
      .mockResolvedValueOnce(gatewayResponse(TURN_A, true));
    const queryClient = testQueryClient();
    const detail = sessionDetail(SESSION_A);
    const first = renderHook(() => useSessionStream(SESSION_A, detail), {
      wrapper: testWrapper(queryClient),
    });

    await act(async () => {
      await expect(first.result.current.send('persisted request')).rejects.toThrow('发送失败');
    });
    const originalUsageId = sendSessionMessageMock.mock.calls[0]?.[2];
    await act(async () => {
      await expect(first.result.current.send('different request')).rejects.toThrow(
        '上一次发送结果仍待确认',
      );
    });
    expect(sendSessionMessageMock).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderHook(() => useSessionStream(SESSION_A, detail), {
      wrapper: testWrapper(queryClient),
    });
    await vi.waitFor(() => expect(second.result.current.pendingRetryAvailable).toBe(true));
    act(() => {
      MockEventSource.instances.at(-1)?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'RUN_FINISHED', runId: TURN_A }),
        }),
      );
    });
    await act(async () => {
      await second.result.current.retryPending();
    });
    expect(sendSessionMessageMock.mock.calls[1]?.[2]).toBe(originalUsageId);
    expect(window.sessionStorage.length).toBe(0);
    expect(second.result.current.running).toBe(false);
    expect(second.result.current.activeRunId).toBeNull();
    expect(second.result.current.terminalRun).toMatchObject({
      runId: TURN_A,
      state: 'completed',
    });
    second.unmount();
  });

  it('blocks every new send while the current recharge requirement is unresolved', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    sendSessionMessageMock.mockRejectedValueOnce(new Error('test 402'));
    readRechargeRequiredMock.mockReturnValue({
      rechargeRequired: true,
      rechargeIntentId: '77777777-7777-4777-8777-777777777777',
      balanceCents: '0',
      requiredCents: '100',
    });
    const queryClient = testQueryClient();
    const detail = sessionDetail(SESSION_A);
    const { result } = renderHook(() => useSessionStream(SESSION_A, detail), {
      wrapper: testWrapper(queryClient),
    });

    await act(async () => {
      await expect(result.current.send('first request')).rejects.toThrow('免费次数已用完');
    });
    expect(result.current.rechargeRequired).not.toBeNull();
    expect(readRechargeRequiredMock).toHaveBeenCalledWith(
      expect.any(Error),
      sendSessionMessageMock.mock.calls[0]?.[2],
    );

    await act(async () => {
      await expect(result.current.send('another request')).rejects.toThrow(
        '请先完成或关闭当前充值流程',
      );
    });
    expect(sendSessionMessageMock).toHaveBeenCalledTimes(1);

    sendSessionMessageMock.mockResolvedValueOnce(gatewayResponse(TURN_A));
    await act(async () => {
      result.current.abandonRechargeUsage();
    });
    await act(async () => {
      await result.current.send('another request');
    });
    expect(sendSessionMessageMock).toHaveBeenCalledTimes(2);
    expect(sendSessionMessageMock.mock.calls[1]?.[2]).not.toBe(
      sendSessionMessageMock.mock.calls[0]?.[2],
    );
  });

  it('does not let an old session POST completion or stale detail poison the new session', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const pendingA = deferred<SendSessionMessageResult>();
    const pendingB = deferred<SendSessionMessageResult>();
    sendSessionMessageMock
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);
    const queryClient = testQueryClient();
    const { result, rerender } = renderHook(
      ({ sessionId, detail }: { sessionId: string; detail: SessionDetail }) =>
        useSessionStream(sessionId, detail),
      {
        initialProps: { sessionId: SESSION_A, detail: sessionDetail(SESSION_A) },
        wrapper: testWrapper(queryClient),
      },
    );

    let requestA!: Promise<MessageView>;
    act(() => {
      requestA = result.current.send('session A request');
    });

    // The route changes before A's 202 response. Passing A's stale query data for one render must
    // neither seed its artifacts nor keep its generation lock attached to B.
    rerender({ sessionId: SESSION_B, detail: sessionDetail(SESSION_A, TURN_A) });
    await vi.waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.artifactList).toEqual([]);

    let requestB!: Promise<MessageView>;
    act(() => {
      requestB = result.current.send('session B request');
    });
    await act(async () => {
      pendingB.resolve(gatewayResponse(TURN_B));
      await requestB;
    });
    expect(result.current.activeRunId).toBe(TURN_B);

    await act(async () => {
      pendingA.resolve(gatewayResponse(TURN_A));
      await requestA;
    });
    expect(result.current.running).toBe(true);
    expect(result.current.activeRunId).toBe(TURN_B);
    expect(result.current.errorMessage).toBeNull();
  });

  it('does not let an old session rejection reset a newer active generation', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const pendingA = deferred<SendSessionMessageResult>();
    const pendingB = deferred<SendSessionMessageResult>();
    sendSessionMessageMock
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);
    const queryClient = testQueryClient();
    const { result, rerender } = renderHook(
      ({ sessionId, detail }: { sessionId: string; detail: SessionDetail }) =>
        useSessionStream(sessionId, detail),
      {
        initialProps: { sessionId: SESSION_A, detail: sessionDetail(SESSION_A) },
        wrapper: testWrapper(queryClient),
      },
    );

    let requestA!: Promise<MessageView>;
    act(() => {
      requestA = result.current.send('session A request');
    });
    rerender({ sessionId: SESSION_B, detail: sessionDetail(SESSION_B) });
    await vi.waitFor(() => expect(result.current.running).toBe(false));

    let requestB!: Promise<MessageView>;
    act(() => {
      requestB = result.current.send('session B request');
    });
    await act(async () => {
      pendingB.resolve(gatewayResponse(TURN_B));
      await requestB;
    });

    let staleError: unknown;
    await act(async () => {
      pendingA.reject(new Error('session A failed'));
      try {
        await requestA;
      } catch (error) {
        staleError = error;
      }
    });
    expect(staleError).toBeInstanceOf(Error);
    expect(result.current.running).toBe(true);
    expect(result.current.activeRunId).toBe(TURN_B);
    expect(result.current.errorMessage).toBeNull();
  });
});

describe('runtime session artifact ordering', () => {
  it('sorts revisions by createdAt and uses id as a deterministic tie-breaker', () => {
    const revisions = sortArtifacts([
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        kind: 'html',
        createdAt: '2026-07-25T02:00:00.000Z',
        updatedAt: '2026-07-25T03:00:00.000Z',
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        kind: 'html',
        createdAt: '2026-07-25T01:00:00.000Z',
        updatedAt: '2026-07-25T04:00:00.000Z',
      },
    ] as Parameters<typeof sortArtifacts>[0]);

    expect(revisions.map((revision) => revision.id)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
  });
});

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function testWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren): ReactElement {
    const queryProvider = createElement(QueryClientProvider, { client: queryClient, children });
    return createElement(ReleaseMetadataProvider, {
      metadata: PREVIEW_METADATA,
      children: queryProvider,
    });
  };
}

function sessionDetail(sessionId: string, sourceTurnId?: string): SessionDetail {
  return {
    session: {
      id: sessionId,
      capabilityId: '33333333-3333-4333-8333-333333333333',
      mode: 'studio',
      status: 'active',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    },
    capability: {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Studio test',
      summary: '',
      kind: 'workflow',
      inputs: [],
      starterPrompts: [],
    },
    messages: [],
    artifacts: sourceTurnId
      ? [
          {
            id: '44444444-4444-4444-8444-444444444444',
            kind: 'html',
            sourceTurnId,
            createdAt: '2026-07-25T00:00:01.000Z',
            updatedAt: '2026-07-25T00:00:01.000Z',
          },
        ]
      : [],
    activeTurn: sourceTurnId ? { id: sourceTurnId, createdAt: '2026-07-25T00:00:01.000Z' } : null,
    currentUiArtifactId: null,
  };
}

function message(turnId: string): MessageView {
  return {
    id:
      turnId === TURN_A
        ? '55555555-5555-4555-8555-555555555555'
        : '66666666-6666-4666-8666-666666666666',
    seq: 1,
    turnId,
    role: 'user',
    content: [{ type: 'text', text: 'accepted' }],
    status: 'completed',
    createdAt: '2026-07-25T00:00:01.000Z',
  };
}

function gatewayResponse(turnId: string, replayed = false): SendSessionMessageResult {
  return { message: message(turnId), replayed };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
