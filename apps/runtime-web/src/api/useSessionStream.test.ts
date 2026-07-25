import type { MessageView, ReleaseMetadata, SessionDetail } from '@cb/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type PropsWithChildren, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseMetadataProvider } from '../shell/releaseIdentity.js';
import { sendSessionMessage } from './runtime.js';
import { sortArtifacts, subscribeSessionEvents, useSessionStream } from './useSessionStream.js';

vi.mock('./runtime.js', () => ({
  interruptSession: vi.fn(async () => ({ interrupted: false })),
  sendSessionMessage: vi.fn(),
}));

const sendSessionMessageMock = vi.mocked(sendSessionMessage);
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
  sendSessionMessageMock.mockReset();
});

describe('runtime session EventSource auth recovery', () => {
  it('refreshes and rebuilds once after a CLOSED stream', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const onFatal = vi.fn();
    const stop = subscribeSessionEvents('/stream', { onMessage: vi.fn(), onFatal });

    MockEventSource.instances[0]!.failClosed();
    await vi.waitFor(() => expect(MockEventSource.instances).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances[1]!.options.withCredentials).toBe(true);

    // 新连接尚未成功 open 就再次 CLOSED：不再 refresh，避免循环。
    MockEventSource.instances[1]!.failClosed();
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it('surfaces a fatal state when refresh is rejected', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const onFatal = vi.fn();
    const onAuthRejected = vi.fn();
    subscribeSessionEvents('/stream', { onMessage: vi.fn(), onFatal, onAuthRejected });

    MockEventSource.instances[0]!.failClosed();
    await vi.waitFor(() => expect(onAuthRejected).toHaveBeenCalledTimes(1));
    expect(onFatal).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(1);
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
    const pending = deferred<MessageView>();
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

    await act(async () => {
      pending.resolve(message(TURN_A));
      await accepted;
    });
    expect(result.current.activeRunId).toBe(TURN_A);
  });

  it('does not let an old session POST completion or stale detail poison the new session', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const pendingA = deferred<MessageView>();
    const pendingB = deferred<MessageView>();
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
      pendingB.resolve(message(TURN_B));
      await requestB;
    });
    expect(result.current.activeRunId).toBe(TURN_B);

    await act(async () => {
      pendingA.resolve(message(TURN_A));
      await requestA;
    });
    expect(result.current.running).toBe(true);
    expect(result.current.activeRunId).toBe(TURN_B);
    expect(result.current.errorMessage).toBeNull();
  });

  it('does not let an old session rejection reset a newer active generation', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const pendingA = deferred<MessageView>();
    const pendingB = deferred<MessageView>();
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
      pendingB.resolve(message(TURN_B));
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
