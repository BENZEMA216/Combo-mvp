// 会话流 hook：订阅 GET /runtime/sessions/:id/stream（SSE），事件归并交给
// streamState 纯函数；发消息 / 打断走 HTTP 端点。
//   - EventSource 断线自动重连并自带 Last-Event-ID 续传（浏览器原生行为）；
//   - 终态（RUN_FINISHED / RUN_ERROR）后回拉一次会话详情对齐真源；
//   - 页面关闭只断订阅，不打断后端生成；打断必须显式点按钮。
import { useEffect, useReducer, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ArtifactView, MessageView, SessionDetail } from '@cb/shared';
import { ApiError, isUnauthenticated } from './client.js';
import { goToLogin } from '../navigation/login.js';
import {
  interruptSession,
  readRechargeRequired,
  sendSessionMessage,
  type RechargeRequired,
} from './runtime.js';
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
  rechargeRequired: RechargeRequired | null;
  /** 当前充值订单 intent；与不可变的原任务 usageId 分离，并随 PendingUsageV2 恢复。 */
  activeRechargeIntentId: string | null;
  clearRechargeRequired: () => void;
  /** 页面重载后原调用源已丢失时，显示统一的安全重试入口。 */
  pendingRetryAvailable: boolean;
  retryPending: () => Promise<MessageView>;
  /** 在 credited intent 精确匹配后，以原 text/usageId 原子恢复原任务。 */
  resumeAfterRecharge: (creditedIntentId: string) => Promise<MessageView>;
  /** 新建替代订单前先持久化 intent，持久化失败则不得切换订单。 */
  setActiveRechargeIntent: (rechargeIntentId: string) => void;
  /** 只清理由 402 确认“未创建 Turn”的原任务；网络未知请求不能放弃。 */
  abandonRechargeUsage: () => void;
}

interface SessionEventSubscription {
  onMessage: (data: string) => void;
  onFatal: () => void;
}

interface PendingUsageV2 {
  version: 2;
  sessionId: string;
  text: string;
  usageId: string;
  reason: 'uncertain' | 'recharge_required';
  activeRechargeIntentId?: string;
}

interface LegacyPendingUsageV1 {
  sessionId: string;
  text: string;
  usageId: string;
  reason?: 'uncertain' | 'recharge_required';
}

const PENDING_USAGE_STORAGE_PREFIX = 'combo:pending-usage:v2:';
const LEGACY_PENDING_USAGE_STORAGE_PREFIX = 'combo:pending-usage:v1:';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function pendingUsageStorageKey(sessionId: string): string {
  return `${PENDING_USAGE_STORAGE_PREFIX}${sessionId}`;
}

function legacyPendingUsageStorageKey(sessionId: string): string {
  return `${LEGACY_PENDING_USAGE_STORAGE_PREFIX}${sessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isCanonicalPendingText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 20_000 &&
    value.trim() === value
  );
}

function parsePendingUsageV2(raw: string, sessionId: string): PendingUsageV2 | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      !hasOnlyKeys(parsed, [
        'version',
        'sessionId',
        'text',
        'usageId',
        'reason',
        'activeRechargeIntentId',
      ]) ||
      parsed.version !== 2 ||
      parsed.sessionId !== sessionId ||
      !isCanonicalPendingText(parsed.text) ||
      typeof parsed.usageId !== 'string' ||
      !UUID_V4_PATTERN.test(parsed.usageId) ||
      (parsed.reason !== 'uncertain' && parsed.reason !== 'recharge_required')
    ) {
      return null;
    }
    if (parsed.reason === 'recharge_required') {
      const activeRechargeIntentId = parsed.activeRechargeIntentId;
      if (
        typeof activeRechargeIntentId !== 'string' ||
        !UUID_V4_PATTERN.test(activeRechargeIntentId)
      ) {
        return null;
      }
      return {
        version: 2,
        sessionId,
        text: parsed.text,
        usageId: parsed.usageId,
        reason: 'recharge_required',
        activeRechargeIntentId,
      };
    }
    if (parsed.activeRechargeIntentId !== undefined) return null;
    return {
      version: 2,
      sessionId,
      text: parsed.text,
      usageId: parsed.usageId,
      reason: 'uncertain',
    };
  } catch {
    return null;
  }
}

function parseLegacyPendingUsage(raw: string, sessionId: string): LegacyPendingUsageV1 | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      !hasOnlyKeys(parsed, ['sessionId', 'text', 'usageId', 'reason']) ||
      parsed.sessionId !== sessionId ||
      !isCanonicalPendingText(parsed.text) ||
      typeof parsed.usageId !== 'string' ||
      !UUID_V4_PATTERN.test(parsed.usageId) ||
      (parsed.reason !== undefined &&
        parsed.reason !== 'uncertain' &&
        parsed.reason !== 'recharge_required')
    ) {
      return null;
    }
    return {
      sessionId,
      text: parsed.text,
      usageId: parsed.usageId,
      reason: parsed.reason,
    };
  } catch {
    return null;
  }
}

function storePendingUsage(pending: PendingUsageV2): boolean {
  try {
    window.sessionStorage.setItem(
      pendingUsageStorageKey(pending.sessionId),
      JSON.stringify(pending),
    );
    return true;
  } catch {
    // 浏览器禁用或耗尽 sessionStorage 时仍保留当前组件内的幂等保护。
    return false;
  }
}

function readStoredPendingUsage(sessionId: string): PendingUsageV2 | null {
  try {
    const key = pendingUsageStorageKey(sessionId);
    const raw = window.sessionStorage.getItem(key);
    if (raw !== null) {
      const parsed = parsePendingUsageV2(raw, sessionId);
      if (!parsed) {
        window.sessionStorage.removeItem(key);
        // 损坏的当前版本必须同时淘汰旧版本。否则下一次挂载会在 V2 已删除后
        // 重新迁移并复活更旧的任务，破坏 fail-closed 边界。
        window.sessionStorage.removeItem(legacyPendingUsageStorageKey(sessionId));
      }
      // 存在损坏的 V2 时 fail closed，不向旧 key 降级，避免复活更旧的任务。
      return parsed;
    }

    const legacyKey = legacyPendingUsageStorageKey(sessionId);
    const legacyRaw = window.sessionStorage.getItem(legacyKey);
    if (legacyRaw === null) return null;
    const legacy = parseLegacyPendingUsage(legacyRaw, sessionId);
    if (!legacy) {
      window.sessionStorage.removeItem(legacyKey);
      return null;
    }
    // V1 没有保存替代订单指针。只迁移可证明的原任务，并强制再次请求权威 402；
    // 不能把 usageId 猜成用户刷新前最后操作的 payment intent。
    const migrated: PendingUsageV2 = {
      version: 2,
      sessionId,
      text: legacy.text,
      usageId: legacy.usageId,
      reason: 'uncertain',
    };
    if (storePendingUsage(migrated)) window.sessionStorage.removeItem(legacyKey);
    return migrated;
  } catch {
    return null;
  }
}

function clearStoredPendingUsage(sessionId: string, usageId: string): void {
  try {
    const v2Key = pendingUsageStorageKey(sessionId);
    const v2Raw = window.sessionStorage.getItem(v2Key);
    if (v2Raw) {
      const v2 = parsePendingUsageV2(v2Raw, sessionId);
      if (!v2) window.sessionStorage.removeItem(v2Key);
      if (v2?.usageId === usageId) {
        window.sessionStorage.removeItem(v2Key);
        // V2 是当前任务真源；一旦它结算完成，任何并存的 V1 都只能是陈旧降级数据。
        window.sessionStorage.removeItem(legacyPendingUsageStorageKey(sessionId));
        return;
      }
    }
    const legacyKey = legacyPendingUsageStorageKey(sessionId);
    const legacyRaw = window.sessionStorage.getItem(legacyKey);
    if (legacyRaw && parseLegacyPendingUsage(legacyRaw, sessionId)?.usageId === usageId) {
      window.sessionStorage.removeItem(legacyKey);
    }
  } catch {
    // 当前组件内的 ref 仍会被清理。
  }
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
  const [rechargeRequired, setRechargeRequired] = useState<RechargeRequired | null>(null);
  const [activeRechargeIntentId, setActiveRechargeIntentId] = useState<string | null>(null);
  const [pendingRetryAvailable, setPendingRetryAvailable] = useState(false);
  const activeSessionIdRef = useRef(sessionId);
  const sendInFlightRef = useRef<{ sessionId: string; token: symbol } | null>(null);
  const pendingUsageRef = useRef<PendingUsageV2 | null>(null);
  const rechargeRequiredRef = useRef<RechargeRequired | null>(rechargeRequired);
  const resumeInFlightRef = useRef<{
    sessionId: string;
    creditedIntentId: string;
    promise: Promise<MessageView>;
  } | null>(null);

  // Route parameters can change before effects clean up the previous subscription. Keep the
  // generation pointer current during render so an old POST/SSE callback cannot mutate the new
  // session's reducer. A new session also gets its own submission lock immediately.
  activeSessionIdRef.current = sessionId;
  rechargeRequiredRef.current = rechargeRequired;
  if (sendInFlightRef.current && sendInFlightRef.current.sessionId !== sessionId) {
    sendInFlightRef.current = null;
  }
  if (pendingUsageRef.current && pendingUsageRef.current.sessionId !== sessionId) {
    pendingUsageRef.current = null;
  }
  if (resumeInFlightRef.current && resumeInFlightRef.current.sessionId !== sessionId) {
    resumeInFlightRef.current = null;
  }

  useEffect(() => {
    dispatch({ kind: 'reset' });
    setRechargeRequired(null);
    rechargeRequiredRef.current = null;
    const storedPending = sessionId ? readStoredPendingUsage(sessionId) : null;
    pendingUsageRef.current = storedPending;
    setActiveRechargeIntentId(
      storedPending?.reason === 'recharge_required'
        ? (storedPending.activeRechargeIntentId ?? null)
        : null,
    );
    setPendingRetryAvailable(storedPending !== null);
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

  const setRechargeGate = (requirement: RechargeRequired | null): void => {
    rechargeRequiredRef.current = requirement;
    setRechargeRequired(requirement);
  };

  const submitMessage = async (
    text: string,
    resume?: { creditedIntentId: string; usageId: string },
  ): Promise<MessageView> => {
    const trimmed = text.trim();
    if (!sessionId) throw new Error('会话还没有准备好，请稍后重试。');
    if (!trimmed) throw new Error('请输入任务内容。');
    if (rechargeRequiredRef.current && !resume) {
      throw new Error('请先完成或关闭当前充值流程。');
    }
    if (state.running || sendInFlightRef.current) {
      throw new Error('Agent 正在处理当前任务，请稍候。');
    }
    const requestSessionId = sessionId;
    const requestToken = Symbol('runtime-send');
    const previousUsage =
      pendingUsageRef.current?.sessionId === requestSessionId
        ? pendingUsageRef.current
        : readStoredPendingUsage(requestSessionId);
    if (
      resume &&
      (!previousUsage ||
        previousUsage.usageId !== resume.usageId ||
        previousUsage.text !== trimmed ||
        previousUsage.reason !== 'recharge_required' ||
        previousUsage.activeRechargeIntentId !== resume.creditedIntentId)
    ) {
      throw new Error('充值订单与待恢复任务不匹配，请刷新页面后重试。');
    }
    if (previousUsage && previousUsage.text !== trimmed) {
      throw new Error('上一次发送结果仍待确认，请先重试原任务。');
    }
    const usageId =
      previousUsage?.sessionId === requestSessionId && previousUsage.text === trimmed
        ? previousUsage.usageId
        : crypto.randomUUID();
    pendingUsageRef.current = {
      version: 2,
      sessionId: requestSessionId,
      text: trimmed,
      usageId,
      reason: previousUsage?.reason ?? 'uncertain',
      ...(previousUsage?.reason === 'recharge_required'
        ? { activeRechargeIntentId: previousUsage.activeRechargeIntentId }
        : {}),
    };
    storePendingUsage(pendingUsageRef.current);
    // 当前调用源（聊天、首屏表单或 Miniapp）仍持有自己的草稿和生命周期；
    // 只有页面重载、调用源丢失后才显示统一恢复入口。
    setPendingRetryAvailable(false);
    sendInFlightRef.current = { sessionId: requestSessionId, token: requestToken };
    dispatch({ kind: 'turn-submitting' });
    try {
      const accepted = await sendSessionMessage(requestSessionId, trimmed, usageId);
      const { message } = accepted;
      const turnId = message.turnId;
      if (!turnId) {
        throw new Error('服务端已接受消息，但没有返回轮次标识。请刷新页面确认结果。');
      }
      // usageId 重放只返回原消息，不会启动新轮。必须撤销 submitting，并回拉真源，
      // 否则已完成的原 Turn 会被错误复活为 running，且永远等不到新的 SSE 终态。
      if (activeSessionIdRef.current === requestSessionId) {
        dispatch({
          kind: accepted.replayed ? 'turn-replayed' : 'turn-accepted',
          runId: turnId,
        });
      }
      // 缓存更新只负责让聊天立即可见。只有新启动的轮次可以乐观标记 active；
      // replay 必须保留缓存中的真实 activeTurn，并立即回拉详情。
      qc.setQueryData<SessionDetail>(['session', requestSessionId], (cur) =>
        cur
          ? {
              ...cur,
              messages: appendMessage(cur.messages, message),
              ...(accepted.replayed
                ? {}
                : { activeTurn: { id: turnId, createdAt: message.createdAt } }),
            }
          : cur,
      );
      if (accepted.replayed) {
        // Keep the synchronous send lock until the authoritative detail refetch settles.
        // This closes the brief replay window where the original Turn may still be running.
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['session', requestSessionId] }),
          qc.invalidateQueries({ queryKey: ['sessions'] }),
        ]);
        if (sendInFlightRef.current?.token === requestToken) sendInFlightRef.current = null;
      }
      clearStoredPendingUsage(requestSessionId, usageId);
      if (pendingUsageRef.current?.usageId === usageId) pendingUsageRef.current = null;
      if (activeSessionIdRef.current === requestSessionId) setPendingRetryAvailable(false);
      if (activeSessionIdRef.current === requestSessionId) {
        setRechargeGate(null);
        setActiveRechargeIntentId(null);
      }
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
      const recharge = readRechargeRequired(err, usageId);
      if (recharge) {
        const pending = pendingUsageRef.current;
        if (pending?.usageId === usageId) {
          // 同一任务再次得到 402 时必须保留已经持久化的订单指针。即使 credited
          // 后恢复仍余额不足，也只能由用户在对话框明确“新建一笔充值”来切换 intent。
          const nextActiveIntentId =
            pending.reason === 'recharge_required'
              ? (pending.activeRechargeIntentId ?? recharge.rechargeIntentId)
              : recharge.rechargeIntentId;
          const updatedPending: PendingUsageV2 = {
            version: 2,
            sessionId: pending.sessionId,
            text: pending.text,
            usageId: pending.usageId,
            reason: 'recharge_required',
            activeRechargeIntentId: nextActiveIntentId,
          };
          pendingUsageRef.current = updatedPending;
          storePendingUsage(updatedPending);
          if (requestIsCurrent) setActiveRechargeIntentId(nextActiveIntentId);
        }
        if (requestIsCurrent) setRechargeGate(recharge);
      }
      const outcomeMayHaveCommitted =
        recharge !== null ||
        !(err instanceof ApiError) ||
        err.status === 0 ||
        err.status === 409 ||
        err.status >= 500;
      if (outcomeMayHaveCommitted) {
        if (requestIsCurrent) setPendingRetryAvailable(true);
      } else {
        clearStoredPendingUsage(requestSessionId, usageId);
        if (pendingUsageRef.current?.usageId === usageId) pendingUsageRef.current = null;
        if (requestIsCurrent) {
          setPendingRetryAvailable(false);
          setRechargeGate(null);
          setActiveRechargeIntentId(null);
        }
      }
      // 服务端错误信封中的 userMessage 已是人话；同时 reject 给 Miniapp bridge，
      // 让它不依赖一次可能来不及渲染的 optimistic running 状态。
      const message = isUnauthenticated(err)
        ? '登录态失效了，请重新登录。'
        : recharge
          ? '免费次数已用完，充值后可继续使用。'
          : err instanceof ApiError
            ? err.userMessage
            : '发送失败，请重试。';
      if (requestIsCurrent) dispatch({ kind: 'error', message });
      throw new Error(message, { cause: err });
    }
  };

  const send = (text: string): Promise<MessageView> => submitMessage(text);

  const setActiveRechargeIntent = (rechargeIntentId: string): void => {
    if (!UUID_V4_PATTERN.test(rechargeIntentId)) {
      throw new Error('新的充值订单标识无效，请刷新页面后重试。');
    }
    if (!sessionId) throw new Error('会话还没有准备好，请稍后重试。');
    const pending =
      pendingUsageRef.current?.sessionId === sessionId
        ? pendingUsageRef.current
        : readStoredPendingUsage(sessionId);
    if (!pending || pending.reason !== 'recharge_required') {
      throw new Error('没有可绑定这笔充值的待恢复任务。');
    }
    if (rechargeRequiredRef.current?.rechargeIntentId !== pending.usageId) {
      throw new Error('充值流程与待恢复任务不匹配，请刷新页面后重试。');
    }
    if (pending.activeRechargeIntentId === rechargeIntentId) return;
    const updatedPending: PendingUsageV2 = {
      ...pending,
      activeRechargeIntentId: rechargeIntentId,
    };
    // 新订单必须先把指针写稳。否则刷新后无法知道该查哪笔权威订单，禁止切换。
    if (!storePendingUsage(updatedPending)) {
      throw new Error('无法保存充值恢复状态，请检查浏览器存储设置后重试。');
    }
    pendingUsageRef.current = updatedPending;
    setActiveRechargeIntentId(rechargeIntentId);
  };

  const resumeAfterRecharge = (creditedIntentId: string): Promise<MessageView> => {
    if (!sessionId) return Promise.reject(new Error('会话还没有准备好，请稍后重试。'));
    if (!UUID_V4_PATTERN.test(creditedIntentId)) {
      return Promise.reject(new Error('充值订单标识无效，请刷新页面后重试。'));
    }
    const existingResume = resumeInFlightRef.current;
    if (existingResume?.sessionId === sessionId) {
      return existingResume.creditedIntentId === creditedIntentId
        ? existingResume.promise
        : Promise.reject(new Error('另一笔充值正在恢复原任务，请稍候。'));
    }
    const pending =
      pendingUsageRef.current?.sessionId === sessionId
        ? pendingUsageRef.current
        : readStoredPendingUsage(sessionId);
    if (
      !pending ||
      pending.reason !== 'recharge_required' ||
      pending.activeRechargeIntentId !== creditedIntentId ||
      rechargeRequiredRef.current?.rechargeIntentId !== pending.usageId
    ) {
      return Promise.reject(new Error('充值订单与待恢复任务不匹配，请刷新页面后重试。'));
    }
    const requestSessionId = sessionId;
    const operation = submitMessage(pending.text, {
      creditedIntentId,
      usageId: pending.usageId,
    });
    const tracked = operation.finally(() => {
      if (resumeInFlightRef.current?.promise === tracked) resumeInFlightRef.current = null;
    });
    resumeInFlightRef.current = {
      sessionId: requestSessionId,
      creditedIntentId,
      promise: tracked,
    };
    return tracked;
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
    rechargeRequired,
    activeRechargeIntentId,
    clearRechargeRequired: () => setRechargeGate(null),
    pendingRetryAvailable,
    retryPending: () => {
      if (!sessionId) return Promise.reject(new Error('会话还没有准备好，请稍后重试。'));
      const pending =
        pendingUsageRef.current?.sessionId === sessionId
          ? pendingUsageRef.current
          : readStoredPendingUsage(sessionId);
      if (!pending) return Promise.reject(new Error('没有需要重试的任务。'));
      return send(pending.text);
    },
    resumeAfterRecharge,
    setActiveRechargeIntent,
    abandonRechargeUsage: () => {
      if (!sessionId) return;
      const pending =
        pendingUsageRef.current?.sessionId === sessionId
          ? pendingUsageRef.current
          : readStoredPendingUsage(sessionId);
      if (!pending || pending.reason !== 'recharge_required') return;
      clearStoredPendingUsage(sessionId, pending.usageId);
      if (pendingUsageRef.current?.usageId === pending.usageId) pendingUsageRef.current = null;
      setPendingRetryAvailable(false);
      setRechargeGate(null);
      setActiveRechargeIntentId(null);
    },
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
