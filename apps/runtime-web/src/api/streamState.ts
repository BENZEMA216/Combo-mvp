// SSE（AG-UI 标准事件）归并：把 /runtime/sessions/:id/stream 的原始事件流
// 折叠成 UI 可渲染的状态。纯函数，无 IO——单测直接喂事件序列断言。
//
// 会话流是「从 Last-Event-ID 之后整段重放 + 实时」的长流：历史轮次的文本事件
// 会被重放，但每轮都以 RUN_FINISHED / RUN_ERROR 收尾——终态即清空流式文本
// （落库消息以详情接口为真源），所以重放完只剩「进行中的一轮」的实时文本。
// 产物走 STATE_DELTA（add /artifacts/<id> + /activeArtifactId）；详情按 turn 世代协调：
// 同 active turn 保留/合并 stream 候选，只有确认终态后才以落库详情整表收敛。
import { EventType } from '@ag-ui/core';
import type { ArtifactView } from '@cb/shared';

/** 线上一帧 AG-UI 事件里前端消费的字段（其余字段透传忽略）。 */
export interface StreamEvent {
  type: string;
  /** Stable backend turn id; required to distinguish replayed and concurrent runs. */
  runId?: unknown;
  delta?: unknown;
  message?: string;
}

export interface StreamTerminalRun {
  runId: string;
  state: 'completed' | 'failed';
  message: string;
}

export interface StreamUiState {
  /** 后端是否正在生成（RUN_STARTED 后、终态前；发消息 202 后也乐观置起）。 */
  running: boolean;
  /** POST 已发出但 202 尚未返回；此时所有详情响应都可能早于本轮，不能收敛 UI。 */
  awaitingRunId: boolean;
  /** 当前由 POST 202、SSE 或详情明确标识的轮次。 */
  activeRunId: string | null;
  /** 最近一个带 runId 的终态；Miniapp bridge 只消费与自身请求匹配的终态。 */
  terminalRun: StreamTerminalRun | null;
  /** 进行中一轮的流式助手文本（打字机）；无进行中文本 → null。 */
  streamingText: string | null;
  /** 产物画布（id → 视图），详情种子 + STATE_DELTA 增量共同收敛。 */
  artifacts: Record<string, ArtifactView>;
  activeArtifactId: string | null;
  /** 可直接展示的人话错误（RUN_ERROR / 发送失败）。 */
  errorMessage: string | null;
}

export const initialStreamUiState: StreamUiState = {
  running: false,
  awaitingRunId: false,
  activeRunId: null,
  terminalRun: null,
  streamingText: null,
  artifacts: {},
  activeArtifactId: null,
  errorMessage: null,
};

export type StreamUiAction =
  | { kind: 'stream-event'; event: StreamEvent }
  | {
      kind: 'detail-snapshot';
      artifacts: ArtifactView[];
      activeTurnId: string | null;
      currentUiArtifactId: string | null;
      messageTurnIds: string[];
      failedTurnIds: string[];
    }
  | { kind: 'select-artifact'; id: string }
  /** POST 开始后先锁住当前世代；RUN_STARTED/详情不能被更旧 GET 覆盖。 */
  | { kind: 'turn-submitting' }
  /** POST 202 返回的 message.turnId 是本轮世代的权威 id。 */
  | { kind: 'turn-accepted'; runId: string }
  | { kind: 'error'; message: string }
  | { kind: 'reset' };

/** data: 帧原文 → 事件对象；非 JSON / 无 type → null（忽略该帧）。 */
export function parseStreamEvent(raw: string): StreamEvent | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const event = parsed as StreamEvent;
    return typeof event.type === 'string' ? event : null;
  } catch {
    return null;
  }
}

/** 终态事件：hook 据此回拉一次会话详情对齐真源。 */
export function isTerminalEvent(event: StreamEvent): boolean {
  return event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;
}

/** JSON Pointer 段解码（产物 id 是 UUID，通常无需转义；按规范兜住 ~0/~1）。 */
function pointerDecode(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** STATE_DELTA：JSON Patch add/replace，只认 /artifacts/<id> 与 /activeArtifactId。 */
function applyStateDelta(state: StreamUiState, delta: unknown): StreamUiState {
  if (!Array.isArray(delta)) return state;
  let { artifacts, activeArtifactId } = state;
  for (const raw of delta) {
    if (!raw || typeof raw !== 'object') continue;
    const op = raw as { op?: unknown; path?: unknown; value?: unknown };
    if ((op.op !== 'add' && op.op !== 'replace') || typeof op.path !== 'string') continue;
    if (op.path === '/activeArtifactId') {
      if (typeof op.value === 'string') activeArtifactId = op.value;
      continue;
    }
    const prefix = '/artifacts/';
    if (op.path.startsWith(prefix) && op.value && typeof op.value === 'object') {
      const id = pointerDecode(op.path.slice(prefix.length));
      artifacts = { ...artifacts, [id]: op.value as ArtifactView };
    }
  }
  return { ...state, artifacts, activeArtifactId };
}

function withoutRunArtifacts(state: StreamUiState, runId: string | null): StreamUiState {
  if (!runId) return state;
  const artifacts = Object.fromEntries(
    Object.entries(state.artifacts).filter(([, artifact]) => artifact.sourceTurnId !== runId),
  );
  if (Object.keys(artifacts).length === Object.keys(state.artifacts).length) return state;
  return {
    ...state,
    artifacts,
    activeArtifactId:
      state.activeArtifactId && artifacts[state.activeArtifactId]
        ? state.activeArtifactId
        : (Object.values(artifacts).at(-1)?.id ?? null),
  };
}

function eventIsFromAnotherActiveRun(state: StreamUiState, runId: string | null): boolean {
  return Boolean(state.running && state.activeRunId && runId && state.activeRunId !== runId);
}

function applyStreamEvent(state: StreamUiState, event: StreamEvent): StreamUiState {
  const runId = typeof event.runId === 'string' && event.runId ? event.runId : null;
  switch (event.type) {
    case EventType.RUN_STARTED:
      if (eventIsFromAnotherActiveRun(state, runId)) return state;
      if (!state.running && runId && state.terminalRun?.runId === runId) return state;
      return {
        ...state,
        running: true,
        activeRunId: runId,
        streamingText: null,
        errorMessage: null,
        terminalRun: runId && state.terminalRun?.runId !== runId ? null : state.terminalRun,
      };
    case EventType.TEXT_MESSAGE_START:
      if (eventIsFromAnotherActiveRun(state, runId)) return state;
      return { ...state, streamingText: '' };
    case EventType.TEXT_MESSAGE_CONTENT:
      if (eventIsFromAnotherActiveRun(state, runId)) return state;
      if (typeof event.delta !== 'string') return state;
      return { ...state, streamingText: (state.streamingText ?? '') + event.delta };
    case EventType.STATE_DELTA:
      if (eventIsFromAnotherActiveRun(state, runId)) return state;
      if (!state.running && runId && state.terminalRun?.runId === runId) return state;
      return applyStateDelta(state, event.delta);
    case EventType.RUN_FINISHED:
      // 终态清空流式文本：这一轮的定稿以详情接口回拉为真源。
      if (runId && state.activeRunId && runId !== state.activeRunId) {
        return {
          ...state,
          terminalRun: { runId, state: 'completed', message: '已完成，页面结果已更新。' },
        };
      }
      return {
        ...state,
        running: false,
        awaitingRunId: false,
        activeRunId: null,
        streamingText: null,
        terminalRun: runId
          ? { runId, state: 'completed', message: '已完成，页面结果已更新。' }
          : state.terminalRun,
      };
    case EventType.RUN_ERROR: {
      const visibleState = withoutRunArtifacts(state, runId);
      if (runId && visibleState.activeRunId && runId !== visibleState.activeRunId) {
        return {
          ...visibleState,
          terminalRun: {
            runId,
            state: 'failed',
            message: event.message ?? '这轮生成失败了，请重试。',
          },
        };
      }
      return {
        ...visibleState,
        running: false,
        awaitingRunId: false,
        activeRunId: null,
        streamingText: null,
        errorMessage: event.message ?? '这轮生成失败了，请重试。',
        terminalRun: runId
          ? {
              runId,
              state: 'failed',
              message: event.message ?? '这轮生成失败了，请重试。',
            }
          : visibleState.terminalRun,
      };
    }
    default:
      // TEXT_MESSAGE_END / 心跳外的其他 AG-UI 事件：当前 UI 不消费，原样忽略。
      return state;
  }
}

interface DetailSnapshotAction {
  kind: 'detail-snapshot';
  artifacts: ArtifactView[];
  activeTurnId: string | null;
  currentUiArtifactId: string | null;
  messageTurnIds: string[];
  failedTurnIds: string[];
}

function artifactMap(artifacts: ArtifactView[]): Record<string, ArtifactView> {
  return Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact]));
}

function activeArtifactAfterDetail(
  state: StreamUiState,
  artifacts: Record<string, ArtifactView>,
  orderedArtifacts: ArtifactView[],
  currentUiArtifactId: string | null,
): string | null {
  if (state.activeArtifactId && artifacts[state.activeArtifactId]) return state.activeArtifactId;
  if (currentUiArtifactId && artifacts[currentUiArtifactId]) return currentUiArtifactId;
  return orderedArtifacts.at(-1)?.id ?? null;
}

/** Same-turn detail may lag STATE_DELTA; keep the newest SSE candidate for that turn only. */
function mergeActiveTurnArtifacts(
  state: StreamUiState,
  detailArtifacts: ArtifactView[],
  activeTurnId: string,
): Record<string, ArtifactView> {
  const merged = artifactMap(detailArtifacts);
  for (const artifact of Object.values(state.artifacts)) {
    if (artifact.sourceTurnId !== activeTurnId) continue;
    const fromDetail = merged[artifact.id];
    if (!fromDetail || artifact.updatedAt >= fromDetail.updatedAt) {
      merged[artifact.id] = artifact;
    }
  }
  return merged;
}

function inferredTerminalRun(
  state: StreamUiState,
  runId: string,
  failedTurnIds: Set<string>,
): StreamTerminalRun {
  if (state.terminalRun?.runId === runId) return state.terminalRun;
  const failed = failedTurnIds.has(runId);
  return {
    runId,
    state: failed ? 'failed' : 'completed',
    message: failed ? '这轮生成没有完成。' : '已完成，页面结果已更新。',
  };
}

function reconcileDetail(state: StreamUiState, action: DetailSnapshotAction): StreamUiState {
  // POST 尚未返回 turnId 时，无法证明任何 GET 是否包含本轮；一律等待世代落定。
  if (state.awaitingRunId) return state;

  const messageTurnIds = new Set(action.messageTurnIds);
  const failedTurnIds = new Set(action.failedTurnIds);
  const activeRunId = state.activeRunId;
  const terminalRunId = state.terminalRun?.runId ?? null;

  if (activeRunId) {
    if (action.activeTurnId === activeRunId) {
      const artifacts = mergeActiveTurnArtifacts(state, action.artifacts, activeRunId);
      return {
        ...state,
        artifacts,
        activeArtifactId: activeArtifactAfterDetail(
          state,
          artifacts,
          Object.values(artifacts),
          action.currentUiArtifactId,
        ),
        running: true,
        activeRunId,
      };
    }

    // A snapshot that does not contain the accepted/current turn predates this generation.
    if (!messageTurnIds.has(activeRunId)) return state;

    const artifacts = artifactMap(action.artifacts);
    if (action.activeTurnId === null) {
      const terminalRun = inferredTerminalRun(state, activeRunId, failedTurnIds);
      const visibleArtifacts =
        terminalRun.state === 'failed'
          ? artifactMap(
              action.artifacts.filter((artifact) => artifact.sourceTurnId !== activeRunId),
            )
          : artifacts;
      return {
        ...state,
        artifacts: visibleArtifacts,
        activeArtifactId: activeArtifactAfterDetail(
          state,
          visibleArtifacts,
          Object.values(visibleArtifacts),
          action.currentUiArtifactId,
        ),
        running: false,
        activeRunId: null,
        streamingText: null,
        errorMessage: terminalRun.state === 'failed' ? terminalRun.message : null,
        terminalRun,
      };
    }

    // Detail knows our turn and names a different active turn, so it is a newer generation.
    return {
      ...state,
      artifacts,
      activeArtifactId: activeArtifactAfterDetail(
        state,
        artifacts,
        action.artifacts,
        action.currentUiArtifactId,
      ),
      running: true,
      activeRunId: action.activeTurnId,
      streamingText: null,
      errorMessage: null,
    };
  }

  if (terminalRunId) {
    // A pre-terminal snapshot must not revive the just-finished turn or its candidate artifact.
    if (action.activeTurnId === terminalRunId) return state;
    if (!messageTurnIds.has(terminalRunId)) return state;
  }

  const filteredArtifacts =
    state.terminalRun?.state === 'failed'
      ? action.artifacts.filter((artifact) => artifact.sourceTurnId !== state.terminalRun?.runId)
      : action.artifacts;
  const artifacts = artifactMap(filteredArtifacts);
  return {
    ...state,
    artifacts,
    activeArtifactId: activeArtifactAfterDetail(
      state,
      artifacts,
      filteredArtifacts,
      action.currentUiArtifactId,
    ),
    running: action.activeTurnId !== null,
    activeRunId: action.activeTurnId,
    streamingText: action.activeTurnId === null ? null : state.streamingText,
    errorMessage:
      action.activeTurnId === null && state.terminalRun?.state !== 'failed'
        ? null
        : state.errorMessage,
  };
}

export function streamUiReducer(state: StreamUiState, action: StreamUiAction): StreamUiState {
  switch (action.kind) {
    case 'stream-event':
      return applyStreamEvent(state, action.event);
    case 'detail-snapshot':
      return reconcileDetail(state, action);
    case 'select-artifact':
      return { ...state, activeArtifactId: action.id };
    case 'turn-submitting':
      return {
        ...state,
        running: true,
        awaitingRunId: true,
        activeRunId: null,
        terminalRun: null,
        errorMessage: null,
      };
    case 'turn-accepted':
      if (state.terminalRun?.runId === action.runId && !state.running) {
        return { ...state, awaitingRunId: false };
      }
      return {
        ...state,
        running: true,
        awaitingRunId: false,
        activeRunId: action.runId,
        errorMessage: null,
      };
    case 'error':
      return {
        ...state,
        running: false,
        awaitingRunId: false,
        activeRunId: null,
        errorMessage: action.message,
      };
    case 'reset':
      return initialStreamUiState;
  }
}
