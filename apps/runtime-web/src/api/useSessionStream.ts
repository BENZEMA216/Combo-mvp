// 会话流 hook：订阅 GET /runtime/sessions/:id/stream（SSE），事件归并交给
// streamState 纯函数；发消息 / 打断走 HTTP 端点。
//   - EventSource 断线自动重连并自带 Last-Event-ID 续传（浏览器原生行为）；
//   - 终态（RUN_FINISHED / RUN_ERROR）后回拉一次会话详情对齐真源；
//   - 页面关闭只断订阅，不打断后端生成；打断必须显式点按钮。
import { useEffect, useReducer, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ArtifactView, MessageView, SessionDetail } from '@cb/shared';
import { ApiError, isUnauthenticated } from './client.js';
import { goToLogin } from '../navigation/login.js';
import { interruptSession, sendSessionMessage } from './runtime.js';
import { reportClientEvent } from './telemetry.js';
import {
  initialStreamUiState,
  isTerminalEvent,
  parseStreamEvent,
  streamUiReducer,
  type StreamUiState,
} from './streamState.js';

export interface SessionStream extends StreamUiState {
  /** 画布产物列表（map 展平，稳定给渲染用）。 */
  artifactList: ArtifactView[];
  selectArtifact: (id: string) => void;
  /** Resolves with the accepted user message, whose turnId links this request to SSE terminal events. */
  send: (text: string) => Promise<MessageView>;
  interrupt: () => void;
}

interface SessionEventSubscription {
  onMessage: (data: string) => void;
  onFatal: () => void;
}

/** 原生 EventSource 关闭后直接进入可见错误态；固定会话不续期，也不透明重建请求。 */
export function subscribeSessionEvents(
  url: string,
  callbacks: SessionEventSubscription,
): () => void {
  let stopped = false;
  let fatalReported = false;
  const source = new EventSource(url, { withCredentials: true });
  source.onmessage = (raw) => {
    if (!stopped) callbacks.onMessage(raw.data as string);
  };
  source.onerror = () => {
    if (stopped || fatalReported || source.readyState !== EventSource.CLOSED) return;
    fatalReported = true;
    source.close();
    callbacks.onFatal();
  };

  return () => {
    stopped = true;
    source.close();
  };
}

export function useSessionStream(
  sessionId: string | undefined,
  detail: SessionDetail | undefined,
): SessionStream {
  const qc = useQueryClient();
  const [state, dispatch] = useReducer(streamUiReducer, initialStreamUiState);
  const activeSessionIdRef = useRef(sessionId);
  const sendInFlightRef = useRef<{ sessionId: string; token: symbol } | null>(null);

  // Route parameters can change before effects clean up the previous subscription. Keep the
  // generation pointer current during render so an old POST/SSE callback cannot mutate the new
  // session's reducer. A new session also gets its own submission lock immediately.
  activeSessionIdRef.current = sessionId;
  if (sendInFlightRef.current && sendInFlightRef.current.sessionId !== sessionId) {
    sendInFlightRef.current = null;
  }

  useEffect(() => {
    dispatch({ kind: 'reset' });
    if (!sessionId) return;
    const subscribedSessionId = sessionId;
    const sessionIsCurrent = (): boolean => activeSessionIdRef.current === subscribedSessionId;
    const url = `/api/v1/runtime/sessions/${sessionId}/stream`;
    return subscribeSessionEvents(url, {
      onMessage: (data) => {
        if (!sessionIsCurrent()) return;
        const event = parseStreamEvent(data);
        if (!event) return;
        dispatch({ kind: 'stream-event', event });
        if (isTerminalEvent(event)) {
          void qc.invalidateQueries({ queryKey: ['session', sessionId] });
          void qc.invalidateQueries({ queryKey: ['sessions'] });
        }
      },
      onFatal: () => {
        if (!sessionIsCurrent()) return;
        reportClientEvent('sse_error', { message: 'session stream closed', url });
        dispatch({ kind: 'error', message: '事件流连接不上，请刷新页面重试。' });
      },
    });
  }, [sessionId, qc]);

  // 声明在 reset/subscription effect 之后，保证首屏详情不会先协调后又被 reset 清空。
  // reducer 用 message turn ids 判定世代：同 active turn 只合并，确认终态才整表收敛。
  useEffect(() => {
    if (!detail || detail.session.id !== sessionId) return;
    const messageTurnIds = [
      ...new Set(detail.messages.flatMap((message) => (message.turnId ? [message.turnId] : []))),
    ];
    const failedTurnIds = [
      ...new Set(
        detail.messages.flatMap((message) =>
          message.turnId && message.status === 'failed' ? [message.turnId] : [],
        ),
      ),
    ];
    dispatch({
      kind: 'detail-snapshot',
      artifacts: detail.artifacts,
      activeTurnId: detail.activeTurn?.id ?? null,
      currentUiArtifactId: detail.currentUiArtifactId ?? null,
      messageTurnIds,
      failedTurnIds,
    });
  }, [detail, sessionId]);

  // A successful POST remains globally locked until SSE/detail proves that generation terminal.
  // This ref, unlike render state, is synchronous and is shared by every caller of this hook.
  useEffect(() => {
    const inFlight = sendInFlightRef.current;
    if (inFlight?.sessionId === sessionId && !state.running && !state.awaitingRunId) {
      sendInFlightRef.current = null;
    }
  }, [sessionId, state.awaitingRunId, state.running]);

  const send = async (text: string): Promise<MessageView> => {
    const trimmed = text.trim();
    if (!sessionId) throw new Error('会话还没有准备好，请稍后重试。');
    if (!trimmed) throw new Error('请输入任务内容。');
    if (state.running || sendInFlightRef.current) {
      throw new Error('Agent 正在处理当前任务，请稍候。');
    }
    const requestSessionId = sessionId;
    const requestToken = Symbol('runtime-send');
    sendInFlightRef.current = { sessionId: requestSessionId, token: requestToken };
    dispatch({ kind: 'turn-submitting' });
    try {
      const message = await sendSessionMessage(requestSessionId, trimmed);
      const turnId = message.turnId;
      if (!turnId) {
        throw new Error('服务端已接受消息，但没有返回轮次标识。请刷新页面确认结果。');
      }
      // 202 的 turnId 先落 reducer，关闭“STATE_DELTA 已到、cache 仍旧”的竞态窗口。
      if (activeSessionIdRef.current === requestSessionId) {
        dispatch({ kind: 'turn-accepted', runId: turnId });
      }
      // 缓存更新只负责让聊天立即可见，并标记本轮 active；其 artifacts 不是权威快照。
      // reducer 看到同 active turn 时会保留/合并 SSE 候选，绝不会整表替换。
      qc.setQueryData<SessionDetail>(['session', requestSessionId], (cur) =>
        cur
          ? {
              ...cur,
              messages: appendMessage(cur.messages, message),
              activeTurn: { id: turnId, createdAt: message.createdAt },
            }
          : cur,
      );
      return message;
    } catch (err: unknown) {
      if (sendInFlightRef.current?.token === requestToken) {
        sendInFlightRef.current = null;
      }
      const requestIsCurrent = activeSessionIdRef.current === requestSessionId;
      // 登录态失效：跳创作端登录（回来落在当前会话页）。
      if (requestIsCurrent && isUnauthenticated(err)) {
        goToLogin();
      }
      // 服务端错误信封中的 userMessage 已是人话；同时 reject 给 Miniapp bridge，
      // 让它不依赖一次可能来不及渲染的 optimistic running 状态。
      const message = isUnauthenticated(err)
        ? '登录态失效了，请重新登录。'
        : err instanceof ApiError
          ? err.userMessage
          : '发送失败，请重试。';
      if (requestIsCurrent) dispatch({ kind: 'error', message });
      throw new Error(message, { cause: err });
    }
  };

  const interrupt = (): void => {
    if (!sessionId) return;
    void interruptSession(sessionId).catch(() => undefined);
  };

  return {
    ...state,
    artifactList: sortArtifacts(Object.values(state.artifacts)),
    selectArtifact: (id) => dispatch({ kind: 'select-artifact', id }),
    send,
    interrupt,
  };
}

/** Revision order is server-created time first, with deterministic id fallback. */
export function sortArtifacts(artifacts: ArtifactView[]): ArtifactView[] {
  return [...artifacts].sort((left, right) => {
    const leftCreated = left.createdAt || left.updatedAt;
    const rightCreated = right.createdAt || right.updatedAt;
    return leftCreated.localeCompare(rightCreated) || left.id.localeCompare(right.id);
  });
}

function appendMessage(messages: MessageView[], message: MessageView): MessageView[] {
  if (messages.some((m) => m.id === message.id)) return messages;
  return [...messages, message];
}
