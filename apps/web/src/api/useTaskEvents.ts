// useTaskEvents——按 @cb/shared SSE 帧协议消费 GET /tasks/:id/events。
//
// 帧协议（packages/shared/src/core/sse.ts）：连接首帧 state_snapshot 全量进度（含 subtasks 点亮），
// 之后增量 progress / item-appended（逐个推出新能力项），终止只发一次 done；heartbeat 探活。
//
// 传输层用 @microsoft/fetch-event-source 而非原生 EventSource：手动重连（看门狗触发）也能带
// Last-Event-ID 请求头续传，超窗后端重发 state_snapshot 重置——不重不漏。鉴权走同源 Cookie。
import { useEffect, useReducer, useRef } from 'react';
import { fetchEventSource, type EventSourceMessage } from '@microsoft/fetch-event-source';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  type CapabilityView,
  type DonePayload,
  type ErrorBody,
  type ProgressPayload,
  type ProgressView,
  type SSEEventType,
  type SlowHintPayload,
  type StateSnapshotPayload,
} from '@cb/shared';
import { unwrapErrorBody } from './client.js';
import { clientTraceHeaders, reportClientEvent } from './telemetry.js';

/** 连接级状态机：UI 据此区分「连接中 / 流动中 / 重连中 / 已完成 / 错误」，永不裸转圈。 */
export type SSEConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'done' | 'error';

export interface TaskEventsState {
  status: SSEConnectionStatus;
  /** 全量进度真源（state_snapshot 整体替换 + progress 帧增量合并）。 */
  progress?: ProgressView;
  /** slow_hint 安抚文案（不是错误）；下一个 progress 帧清掉。 */
  slowHint?: SlowHintPayload;
  /** done 帧 payload（终止状态）。 */
  done?: DonePayload;
  /** error 帧 / done.error / 建流失败的人话错误体；UI 只读 userMessage + action。 */
  error?: ErrorBody;
  /** item-appended 累积的新能力项（边提取边显示）。 */
  items: CapabilityView[];
}

export const INITIAL_TASK_EVENTS_STATE: TaskEventsState = { status: 'connecting', items: [] };

type Action =
  | { type: 'connecting' }
  | { type: 'open' }
  | { type: 'reconnecting' }
  | { type: 'frame'; event: SSEEventType; payload: unknown }
  | { type: 'localError'; error: ErrorBody };

/**
 * 帧归并（纯函数，单测直接打它）：
 *   state_snapshot 整体替换 progress；progress 增量合并（保留 subtasks）；item-appended 追加
 *   payload.item；done 定终态（失败时解包 error）；heartbeat 不改业务态。
 */
export function reduceTaskEvents(state: TaskEventsState, action: Action): TaskEventsState {
  switch (action.type) {
    case 'connecting': {
      if (state.status === 'done') return state;
      const { error: _error, ...rest } = state;
      return { ...rest, status: 'connecting' };
    }
    case 'open': {
      if (state.status === 'done') return state;
      const { error: _error, ...rest } = state;
      return { ...rest, status: 'open' };
    }
    case 'reconnecting':
      return state.status === 'done' ? state : { ...state, status: 'reconnecting' };
    case 'localError':
      return { ...state, status: 'error', error: action.error };
    case 'frame':
      break;
    default:
      return state;
  }

  const next: TaskEventsState = { ...state };
  switch (action.event) {
    case 'state_snapshot': {
      // 全量重置（首帧 / 重连超窗）：subtasks 点亮全在这里承载。
      const p = action.payload as StateSnapshotPayload;
      next.status = 'open';
      if (p?.progress) next.progress = p.progress;
      return next;
    }
    case 'progress': {
      const p = action.payload as ProgressPayload;
      next.status = 'open';
      next.progress = {
        percent: p.percent,
        phrase: p.phrase,
        ...(p.done !== undefined ? { done: p.done } : {}),
        ...(p.total !== undefined ? { total: p.total } : {}),
        ...(p.unit !== undefined ? { unit: p.unit } : {}),
        subtasks: state.progress?.subtasks ?? [],
      };
      delete next.slowHint;
      return next;
    }
    case 'item-appended': {
      // payload = { item: CapabilityView }（pipeline 逐项落库后推）。
      const item = (action.payload as { item?: CapabilityView } | undefined)?.item;
      if (item) next.items = [...state.items, item];
      return next;
    }
    case 'slow_hint':
      next.slowHint = action.payload as SlowHintPayload;
      return next;
    case 'error':
      next.status = 'error';
      next.error = unwrapErrorBody(action.payload);
      return next;
    case 'done': {
      const d = action.payload as DonePayload;
      next.done = d;
      if (d?.error) {
        next.status = 'error';
        next.error = unwrapErrorBody(d.error);
      } else {
        next.status = 'done';
      }
      return next;
    }
    case 'heartbeat':
    default:
      return next;
  }
}

/** 协议帧类型集合（过滤未知事件名，不污染状态机）。 */
const SSE_EVENT_SET: ReadonlySet<string> = new Set<SSEEventType>([
  'state_snapshot',
  'progress',
  'item-appended',
  'slow_hint',
  'error',
  'done',
  'heartbeat',
]);

/** 流中断后的重连延迟（ms），重连自动带 Last-Event-ID。 */
const SSE_RECONNECT_DELAY_MS = 1_000;

/** 注入点：测试经此换受控 mock（见 test/mockFetchEventSource.ts）。 */
export type FetchEventSourceFn = typeof fetchEventSource;
let fetchEventSourceImpl: FetchEventSourceFn = fetchEventSource;
/** 仅测试用：替换底层 fetchEventSource 实现，返回还原函数。 */
export function __setFetchEventSourceForTests(fn: FetchEventSourceFn): () => void {
  const prev = fetchEventSourceImpl;
  fetchEventSourceImpl = fn;
  return () => {
    fetchEventSourceImpl = prev;
  };
}

/** 致命错误：onerror 抛它即停止库内自动重连（鉴权失败 / done 后不该再连）。 */
class SSEFatalError extends Error {}

export interface UseTaskEventsOptions {
  /** false 时不建流（任务已终态等场景）。 */
  enabled?: boolean;
  /** 用户显式重连时递增；不携带凭据，也不自动重放业务写请求。 */
  reconnectKey?: number;
}

/** 订阅一条任务进度流。url 为 null 或 enabled=false 时不建流。 */
export function useTaskEvents(
  url: string | null,
  options: UseTaskEventsOptions = {},
): TaskEventsState {
  const enabled = options.enabled !== false && !!url;
  const [state, dispatch] = useReducer(reduceTaskEvents, INITIAL_TASK_EVENTS_STATE);

  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneRef = useRef(false);
  /** 续传锚点：每帧 id 更新；重连（库内自动 / 看门狗重建）都带它做 Last-Event-ID 头。 */
  const lastEventIdRef = useRef<string>('');

  useEffect(() => {
    if (!enabled || !url) return;

    doneRef.current = false;
    lastEventIdRef.current = '';
    let closed = false;
    const trace = clientTraceHeaders();
    let ctrl = new AbortController();

    const clearWatchdog = () => {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    };

    // 看门狗：超过 2× 心跳间隔无任何帧 → 断开当前连接、带 Last-Event-ID 重建。
    const armWatchdog = () => {
      clearWatchdog();
      watchdogRef.current = setTimeout(() => {
        if (closed || doneRef.current) return;
        dispatch({ type: 'reconnecting' });
        const old = ctrl;
        ctrl = new AbortController();
        old.abort();
        connect();
      }, SSE_HEARTBEAT_INTERVAL_MS * 2);
    };

    const reportSseError = (error: ErrorBody) => {
      reportClientEvent('sse_error', {
        traceId: error.traceId || trace.traceId,
        message: error.userMessage,
        url,
      });
    };

    const connect = () => {
      dispatch({ type: 'connecting' });
      void fetchEventSourceImpl(url, {
        signal: ctrl.signal,
        credentials: 'include', // 同源 Cookie 鉴权。
        openWhenHidden: true, // 后台标签页不暂停流（任务仍在跑）。
        headers: {
          ...trace.headers,
          ...(lastEventIdRef.current ? { 'Last-Event-ID': lastEventIdRef.current } : {}),
        },

        async onopen(response: Response) {
          if (closed) return;
          const contentType = response.headers.get('content-type') ?? '';
          if (!response.ok || !contentType.includes('text/event-stream')) {
            // 建流前 HTTP 失败（含会话 401）：解析 ErrorEnvelope 后终止，不续期也不重放。
            let body: unknown;
            try {
              body = await response.clone().json();
            } catch {
              body = undefined;
            }
            const error = unwrapErrorBody(body);
            reportSseError(error);
            doneRef.current = true;
            clearWatchdog();
            dispatch({ type: 'localError', error });
            throw new SSEFatalError('sse open failed');
          }
          dispatch({ type: 'open' });
          armWatchdog();
        },

        onmessage(msg: EventSourceMessage) {
          if (closed) return;
          armWatchdog();
          if (msg.id) lastEventIdRef.current = msg.id;
          if (!SSE_EVENT_SET.has(msg.event)) return;
          let payload: unknown;
          try {
            payload = msg.data ? JSON.parse(msg.data) : undefined;
          } catch {
            payload = undefined;
          }
          const event = msg.event as SSEEventType;
          dispatch({ type: 'frame', event, payload });
          if (event === 'error') reportSseError(unwrapErrorBody(payload));
          if (event === 'done') {
            const done = payload as DonePayload | undefined;
            if (done?.error) reportSseError(unwrapErrorBody(done.error));
            doneRef.current = true;
            clearWatchdog();
            ctrl.abort();
          }
        },

        onerror(err) {
          if (err instanceof SSEFatalError) throw err;
          if (closed || doneRef.current) throw new SSEFatalError('closed');
          // 网络/流中断：库自动带 Last-Event-ID 重连；UI 标 reconnecting。
          dispatch({ type: 'reconnecting' });
          armWatchdog();
          return SSE_RECONNECT_DELAY_MS;
        },

        onclose() {
          if (closed || doneRef.current) return;
          dispatch({ type: 'reconnecting' });
          armWatchdog();
        },
      }).catch(() => {
        // onerror 抛致命错误时 reject——预期内（done/cleanup），吞掉不外溢。
      });
    };

    connect();
    return () => {
      closed = true;
      doneRef.current = true;
      clearWatchdog();
      ctrl.abort();
    };
  }, [url, enabled, options.reconnectKey]);

  return state;
}
