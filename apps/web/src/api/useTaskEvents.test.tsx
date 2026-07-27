// SSE 帧归并 + 连接语义测试。
//   reduceTaskEvents（纯函数）：state_snapshot 全量 / progress 增量保 subtasks / item-appended 追加 /
//   done 终态 / error 解包信封 / heartbeat 不改业务态。
//   useTaskEvents（hook + MockFetchEventSource）：建流→帧→done 关流；看门狗重连带 Last-Event-ID。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ProgressView, SSEEventType } from '@cb/shared';
import { makeCapability } from '../test/fixtures.js';
import { MockFetchEventSource } from '../test/mockFetchEventSource.js';
import {
  INITIAL_TASK_EVENTS_STATE,
  reduceTaskEvents,
  useTaskEvents,
  __setFetchEventSourceForTests,
  type TaskEventsState,
} from './useTaskEvents.js';

const PROGRESS: ProgressView = {
  percent: 40,
  phrase: '已分析 4 / 10 段会话',
  subtasks: [
    { key: 'fetch', label: '读取上传内容', status: 'done' },
    { key: 'extract', label: '归纳提炼能力', status: 'running' },
  ],
};

function frame(state: TaskEventsState, event: SSEEventType, payload: unknown): TaskEventsState {
  return reduceTaskEvents(state, { type: 'frame', event, payload });
}

describe('reduceTaskEvents — 帧归并（纯函数）', () => {
  it('state_snapshot：全量 progress 落位 + status=open', () => {
    const s = frame(INITIAL_TASK_EVENTS_STATE, 'state_snapshot', { progress: PROGRESS });
    expect(s.status).toBe('open');
    expect(s.progress).toEqual(PROGRESS);
  });

  it('progress：增量合并（percent/phrase 更新，subtasks 保留），清 slowHint', () => {
    let s = frame(INITIAL_TASK_EVENTS_STATE, 'state_snapshot', { progress: PROGRESS });
    s = frame(s, 'slow_hint', { phrase: '仍在处理…', elapsedMs: 30_000 });
    expect(s.slowHint?.phrase).toBe('仍在处理…');
    s = frame(s, 'progress', {
      percent: 60,
      phrase: '已分析 6 / 10 段会话',
      done: 6,
      total: 10,
      unit: '段',
    });
    expect(s.progress?.percent).toBe(60);
    expect(s.progress?.phrase).toBe('已分析 6 / 10 段会话');
    expect(s.progress?.done).toBe(6);
    expect(s.progress?.subtasks).toEqual(PROGRESS.subtasks); // 保留快照点亮
    expect(s.slowHint).toBeUndefined();
  });

  it('item-appended：追加 payload.item（边提取边显示）', () => {
    const cap1 = makeCapability({ id: 'c1', name: '周报整理' });
    const cap2 = makeCapability({ id: 'c2', name: '代码评审' });
    let s = frame(INITIAL_TASK_EVENTS_STATE, 'item-appended', { item: cap1 });
    s = frame(s, 'item-appended', { item: cap2 });
    expect(s.items.map((c) => c.name)).toEqual(['周报整理', '代码评审']);
  });

  it('done（成功）：status=done + payload 落位', () => {
    const s = frame(INITIAL_TASK_EVENTS_STATE, 'done', {
      status: 'succeeded',
      result: { capabilityCount: 3 },
    });
    expect(s.status).toBe('done');
    expect(s.done?.status).toBe('succeeded');
    expect(s.error).toBeUndefined();
  });

  it('done（失败）：解包 error 信封 → status=error + 人话错误体', () => {
    const envelope = {
      error: {
        userMessage: '模型服务暂时不可用，请稍后重试。',
        retriable: true,
        action: 'retry',
        traceId: 't-done',
      },
    };
    const s = frame(INITIAL_TASK_EVENTS_STATE, 'done', { status: 'failed', error: envelope });
    expect(s.status).toBe('error');
    expect(s.error?.userMessage).toBe('模型服务暂时不可用，请稍后重试。');
    expect(s.error?.action).toBe('retry');
  });

  it('error 帧：完整对外信封解包，code 不进 state', () => {
    const s = frame(INITIAL_TASK_EVENTS_STATE, 'error', {
      error: {
        userMessage: '这次处理超时了，点重试再来一次。',
        retriable: true,
        action: 'retry',
        traceId: 't-err',
        code: 'TASK_TIMEOUT',
      },
    });
    expect(s.status).toBe('error');
    expect(s.error).toEqual({
      userMessage: '这次处理超时了，点重试再来一次。',
      retriable: true,
      action: 'retry',
      traceId: 't-err',
    });
  });

  it('用户显式重连时清除旧握手错误，避免错误卡阻挡新连接状态', () => {
    const failed = reduceTaskEvents(INITIAL_TASK_EVENTS_STATE, {
      type: 'localError',
      error: {
        userMessage: '依赖服务暂时不可用。',
        retriable: true,
        action: 'retry',
        traceId: 'trace-reconnect',
      },
    });
    const reconnecting = reduceTaskEvents(failed, { type: 'connecting' });
    expect(reconnecting.status).toBe('connecting');
    expect(reconnecting.error).toBeUndefined();
  });

  it('heartbeat：不改业务态', () => {
    const before = frame(INITIAL_TASK_EVENTS_STATE, 'state_snapshot', { progress: PROGRESS });
    const after = frame(before, 'heartbeat', { ts: 1 });
    expect(after.progress).toEqual(before.progress);
    expect(after.status).toBe(before.status);
  });
});

describe('useTaskEvents — 连接语义（MockFetchEventSource）', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('建流 → 帧驱动状态 → done 后 abort 关流', () => {
    restore = __setFetchEventSourceForTests(MockFetchEventSource.impl);
    const { result } = renderHook(() => useTaskEvents('/api/v1/tasks/t1/events'));
    expect(result.current.status).toBe('connecting');

    const conn = MockFetchEventSource.last!;
    expect(conn.url).toBe('/api/v1/tasks/t1/events');
    expect(conn.init.credentials).toBe('include');

    act(() => conn.open());
    expect(result.current.status).toBe('open');

    act(() => conn.emit('state_snapshot', { progress: PROGRESS }, { id: '1-1' }));
    expect(result.current.progress?.percent).toBe(40);

    act(() =>
      conn.emit(
        'item-appended',
        { item: makeCapability({ id: 'c9', name: '新能力' }) },
        { id: '2-1' },
      ),
    );
    expect(result.current.items).toHaveLength(1);

    act(() => conn.emit('done', { status: 'succeeded' }, { id: '3-1' }));
    expect(result.current.status).toBe('done');
    expect(conn.aborted).toBe(true); // done 后主动断流，不留悬挂连接
  });

  it('看门狗超时重连：新连接带当前 Last-Event-ID 续传锚点', () => {
    vi.useFakeTimers();
    restore = __setFetchEventSourceForTests(MockFetchEventSource.impl);
    const { result } = renderHook(() => useTaskEvents('/api/v1/tasks/t1/events'));

    const first = MockFetchEventSource.last!;
    act(() => first.open());
    act(() => first.emit('state_snapshot', { progress: PROGRESS }, { id: '7-0' }));
    expect(first.lastEventIdAtOpen).toBeNull(); // 首连无锚点

    // 超过 2× 心跳间隔无帧 → 看门狗断旧连接、带锚点重建。
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(MockFetchEventSource.connections).toHaveLength(2);
    const second = MockFetchEventSource.last!;
    expect(second).not.toBe(first);
    expect(first.aborted).toBe(true);
    expect(second.lastEventIdAtOpen).toBe('7-0');
    expect(result.current.status).toBe('connecting'); // 重建中（非裸转圈：状态可见）

    // 重连成功续传：progress 帧在快照基础上继续。
    act(() => second.open());
    act(() =>
      second.emit('progress', { percent: 80, phrase: '已分析 8 / 10 段会话' }, { id: '8-0' }),
    );
    expect(result.current.progress?.percent).toBe(80);
    expect(result.current.progress?.subtasks).toEqual(PROGRESS.subtasks);
  });

  it('建流前 HTTP 401 直接进入统一错误态，不续期或重连', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    restore = __setFetchEventSourceForTests(MockFetchEventSource.impl);
    const { result } = renderHook(() => useTaskEvents('/api/v1/tasks/t1/events'));
    const conn = MockFetchEventSource.last!;

    await act(async () => {
      conn.open(
        new Response(
          JSON.stringify({
            error: {
              userMessage: '请先登录。',
              retriable: false,
              action: 'escalate',
              traceId: 't-401',
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      );
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.userMessage).toBe('请先登录。');
    expect(MockFetchEventSource.connections).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enabled=false / url=null 不建流', () => {
    restore = __setFetchEventSourceForTests(MockFetchEventSource.impl);
    renderHook(() => useTaskEvents(null));
    renderHook(() => useTaskEvents('/api/v1/tasks/t1/events', { enabled: false }));
    expect(MockFetchEventSource.connections).toHaveLength(0);
  });
});
