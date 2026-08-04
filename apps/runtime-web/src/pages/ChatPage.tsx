// 会话页（GUI 形态）：产物画布是主界面，聊天是稳定的修改工作区——
//   - consume 首屏按能力输入开始真实任务；studio 从左侧对话直接开始第一版 UI；
//   - 第一轮生成中且还没有任何产物时显示诚实的页面骨架；
//   - 有产物后画布渲染产物（多产物顶部 chips 切换），左侧对话负责反复微调；
//   - 恢复：GET /runtime/sessions/:id（详情真源）；实时：/stream SSE（useSessionStream）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ArtifactView, SessionDetail } from '@cb/shared';
import { useArtifactContent, useCreateSession, useSession } from '../api/runtime.js';
import { useSessionStream } from '../api/useSessionStream.js';
import {
  ArtifactRenderer,
  type ComboElementSelection,
  type ComboRunRequest,
} from '../components/ArtifactRenderer.js';
import { FloatingChat } from '../components/FloatingChat.js';
import { GeneratingPageSkeleton } from '../components/GeneratingPageSkeleton.js';
import { QueryErrorNotice } from '../components/QueryErrorNotice.js';
import { RechargeDialog } from '../components/RechargeDialog.js';
import { SessionSidebar } from '../components/SessionSidebar.js';
import { TrialIntakeForm } from '../components/TrialIntakeForm.js';
import {
  artifactDownloadLabel,
  artifactDownloadTitle,
  downloadArtifact,
} from '../components/artifactDownload.js';
import {
  appendRuntimeReturnTo,
  readRuntimeReturnTo,
  rememberRuntimeReturnTo,
  runtimeBackLabel,
  safeCapabilityReleaseRuntimeReturnTo,
  safeRuntimeReturnTo,
} from '../navigation/runtimeReturn.js';
import {
  buildContextualStudioPrompt,
  formatStudioAnnotationMessage,
} from '../lib/studioAnnotation.js';
import {
  buildStudioDesignOperationPrompt,
  STUDIO_DESIGN_OPERATIONS,
  type StudioDesignOperation,
} from '../lib/studioDesignOperations.js';
import { resolveSessionExperience } from '../sessionExperience.js';
import { useDocumentTitle } from '../shell/useDocumentTitle.js';

export type TrialCanvasState = 'intake' | 'running' | 'output';
export type StudioSaveTone = 'idle' | 'progress' | 'success' | 'error';

export interface StudioSaveStatus {
  label: string;
  tone: StudioSaveTone;
}

/** Pure state contract: streamed prose never counts as a rendered artifact. */
export function resolveTrialCanvasState(input: {
  messageCount: number;
  running: boolean;
  hasArtifact: boolean;
}): TrialCanvasState {
  if (input.running && !input.hasArtifact) return 'running';
  if (input.messageCount === 0 && !input.hasArtifact) return 'intake';
  return 'output';
}

/** Studio 只有完整轮次成功后才会把 revision 提升为 Agent 当前 UI。 */
export function resolveStudioSaveStatus(input: {
  running: boolean;
  hasArtifact: boolean;
  hasError: boolean;
  activeArtifactId: string | null;
  currentUiArtifactId: string | null | undefined;
  terminalState: 'completed' | 'failed' | null;
}): StudioSaveStatus {
  if (input.running) return { label: '正在生成并保存…', tone: 'progress' };
  if (input.terminalState === 'failed') {
    return { label: '本轮未保存', tone: 'error' };
  }
  if (input.hasError) {
    return { label: '保存状态待确认', tone: 'error' };
  }
  if (input.activeArtifactId !== null && input.currentUiArtifactId === input.activeArtifactId) {
    return { label: '已自动保存', tone: 'success' };
  }
  if (input.terminalState === 'completed' && !input.hasArtifact) {
    return { label: '本轮未生成 UI', tone: 'error' };
  }
  if (
    input.hasArtifact &&
    input.currentUiArtifactId !== undefined &&
    input.currentUiArtifactId !== input.activeArtifactId
  ) {
    return input.terminalState === 'completed'
      ? { label: '保存状态待确认', tone: 'progress' }
      : { label: '当前版本未设为 Agent UI', tone: 'error' };
  }
  if (input.hasArtifact) return { label: '自动保存已开启', tone: 'idle' };
  return { label: '尚未生成', tone: 'idle' };
}

export function ChatPage() {
  const { sessionId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const sessionQ = useSession(sessionId);
  const detail = sessionQ.data;
  const stream = useSessionStream(sessionId, detail);
  const createTrial = useCreateSession();
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const runStartedAtRef = useRef<number | null>(null);
  const [lastSidebarCapability, setLastSidebarCapability] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [inspectionEnabled, setInspectionEnabled] = useState(false);
  const [selectedElement, setSelectedElement] = useState<ComboElementSelection | null>(null);
  const [inspectableElements, setInspectableElements] = useState<ComboElementSelection[]>([]);
  const [operationPending, setOperationPending] = useState(false);
  const operationInFlightRef = useRef(false);
  const [trialStartError, setTrialStartError] = useState<string | null>(null);
  const [retryResolutionVersion, setRetryResolutionVersion] = useState(0);
  const rechargeBackgroundRef = useRef<HTMLDivElement>(null);

  // 普通试用和 Studio 都记住严格校验后的 returnTo，保证反复修改后能继续定价发布。
  const queryReturnTo = safeRuntimeReturnTo(searchParams.get('returnTo'));
  const returnTo = queryReturnTo ?? readRuntimeReturnTo(sessionId);
  useEffect(() => {
    rememberRuntimeReturnTo(sessionId, queryReturnTo);
  }, [queryReturnTo, sessionId]);

  const capability = detail?.capability;
  const experience = resolveSessionExperience(detail, searchParams.get('mode'));
  const studioMode = experience === 'studio';
  const contextualReturnTo = studioMode ? (returnTo ?? '/capabilities') : returnTo;
  const releaseReturnTo = safeCapabilityReleaseRuntimeReturnTo(contextualReturnTo);
  useDocumentTitle(
    capability ? `${capability.name} · ${studioMode ? 'UI 设计' : 'Combo 试用'}` : undefined,
  );
  const sidebarCapability = capability
    ? { id: capability.id, name: capability.name }
    : lastSidebarCapability;
  const messages = detail?.messages ?? [];
  const activeArtifact = stream.activeArtifactId
    ? (stream.artifacts[stream.activeArtifactId] ?? null)
    : (stream.artifactList.at(-1) ?? null);
  const activeTurn = detail?.activeTurn ?? null;
  const studioSaveStatus = resolveStudioSaveStatus({
    running: stream.running,
    hasArtifact: activeArtifact !== null,
    hasError: stream.errorMessage !== null,
    activeArtifactId: activeArtifact?.id ?? null,
    currentUiArtifactId: detail?.currentUiArtifactId,
    terminalState: stream.terminalRun?.state ?? null,
  });

  // 画布状态机：intake（还没开始）→ running（第一轮生成、尚无任何产出）→ output。
  // 流式解释不是产物：第一段文字到达后也要继续保留页面骨架，直到真正产物出现。
  const canvasState = resolveTrialCanvasState({
    messageCount: messages.length,
    running: stream.running,
    hasArtifact: activeArtifact !== null,
  });
  const hasStarted = canvasState !== 'intake';
  // Studio 的对话就是设计入口：空会话也保持左对话、右画布，不再切换成另一套首屏表单。
  const showConversation = hasStarted || studioMode;
  const showIntake = canvasState === 'intake';
  const showGenerating = canvasState === 'running';
  const showStudioDefault = studioMode && activeArtifact === null && !showGenerating;
  if (stream.running && runStartedAtRef.current === null) {
    const restoredStart = activeTurn?.createdAt ? Date.parse(activeTurn.createdAt) : Number.NaN;
    runStartedAtRef.current = Number.isFinite(restoredStart) ? restoredStart : Date.now();
  }
  if (!stream.running && runStartedAtRef.current !== null) runStartedAtRef.current = null;
  const runStartedAt = runStartedAtRef.current ?? undefined;

  useEffect(() => {
    if (!capability) return;
    setLastSidebarCapability((current) =>
      current?.id === capability.id && current.name === capability.name
        ? current
        : { id: capability.id, name: capability.name },
    );
  }, [capability?.id, capability?.name]);

  useEffect(() => {
    setMobileSessionsOpen(false);
    setInspectionEnabled(false);
    setSelectedElement(null);
    setInspectableElements([]);
    setTrialStartError(null);
  }, [sessionId]);

  useEffect(() => {
    setInspectionEnabled(false);
    setSelectedElement(null);
    setInspectableElements([]);
  }, [activeArtifact?.id, activeArtifact?.updatedAt]);

  useEffect(() => {
    rechargeBackgroundRef.current?.toggleAttribute('inert', stream.rechargeRequired !== null);
  }, [stream.rechargeRequired]);

  useEffect(() => {
    if (!mobileSessionsOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMobileSessionsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileSessionsOpen]);

  const sendConversationMessage = useCallback(
    async (text: string) => {
      const prompt =
        studioMode && selectedElement ? buildContextualStudioPrompt(selectedElement, text) : text;
      const accepted = await stream.send(prompt);
      if (studioMode && selectedElement) {
        setSelectedElement(null);
        setInspectionEnabled(false);
      }
      return accepted;
    },
    [selectedElement, stream.send, studioMode],
  );

  const retryPendingUsage = useCallback(async (): Promise<void> => {
    try {
      await stream.retryPending();
      // 统一恢复入口持有并重放的是完整原请求。成功确认后重挂载原输入源，
      // 避免表单、对话草稿或 Miniapp 再把相同内容以新 usageId 发送一次。
      setRetryResolutionVersion((version) => version + 1);
      setSelectedElement(null);
      setInspectionEnabled(false);
    } catch {
      // useSessionStream owns the visible error and retains the same usageId for another retry.
    }
  }, [stream.retryPending]);

  const runDesignOperation = useCallback(
    async (operation: StudioDesignOperation): Promise<void> => {
      if (!studioMode || stream.running || operationInFlightRef.current) return;
      operationInFlightRef.current = true;
      setOperationPending(true);
      const operationPrompt = buildStudioDesignOperationPrompt(
        operation,
        selectedElement ? 'element' : 'page',
      );
      const prompt = selectedElement
        ? buildContextualStudioPrompt(selectedElement, operationPrompt)
        : operationPrompt;
      try {
        await stream.send(prompt);
        setSelectedElement(null);
        setInspectionEnabled(false);
      } catch {
        // useSessionStream presents the server error and keeps the current selection for retry.
      } finally {
        operationInFlightRef.current = false;
        setOperationPending(false);
      }
    },
    [selectedElement, stream, studioMode],
  );

  const startCurrentUiTrial = useCallback(async (): Promise<void> => {
    if (!studioMode || !capability || !sessionId || createTrial.isPending) return;
    setTrialStartError(null);
    try {
      const trial = await createTrial.mutateAsync(capability.id);
      const studioReturnTo = appendRuntimeReturnTo(
        `/try/session/${sessionId}?mode=studio`,
        contextualReturnTo,
      );
      navigate(appendRuntimeReturnTo(`/session/${trial.id}`, studioReturnTo));
    } catch {
      setTrialStartError('试用会话没有创建成功，请重试。');
    }
  }, [capability, contextualReturnTo, createTrial, navigate, sessionId, studioMode]);

  return (
    <div className={`rt-app rt-trial-app${studioMode ? ' rt-trial-app--studio' : ''}`}>
      <div
        ref={rechargeBackgroundRef}
        className="rt-recharge-background"
        aria-hidden={stream.rechargeRequired ? true : undefined}
      >
        {!studioMode && (
          <SessionSidebar
            activeSessionId={sessionId}
            capabilityId={sidebarCapability?.id}
            capabilityName={sidebarCapability?.name}
            returnTo={contextualReturnTo}
            runningSessionId={stream.running ? sessionId : undefined}
            experience={experience}
          />
        )}
        <div className="rt-trial">
          {sessionQ.isPending ? (
            <div className="rt-loading">加载会话…</div>
          ) : sessionQ.isError || !detail || !capability ? (
            <QueryErrorNotice error={sessionQ.error} onRetry={() => void sessionQ.refetch()} />
          ) : (
            <>
              <header className="rt-trial__toolbar">
                <div className="rt-trial__title-group">
                  <h1>
                    {activeArtifact?.title ??
                      (studioMode ? `${capability.name} UI` : capability.name)}
                  </h1>
                  {studioMode ? (
                    <div className="rt-studio-status">
                      <span className="rt-source-pill">UI 设计</span>
                      <span id="rt-studio-save-help" className="rt-sr-only">
                        每次生成成功后会自动设为 Agent 当前 UI，无需手动保存。
                      </span>
                      <span
                        className={`rt-save-pill is-${studioSaveStatus.tone}`}
                        role="status"
                        aria-live="polite"
                        aria-label={`保存状态：${studioSaveStatus.label}`}
                        aria-describedby="rt-studio-save-help"
                      >
                        <span className="rt-save-pill__dot" aria-hidden="true" />
                        {studioSaveStatus.label}
                      </span>
                    </div>
                  ) : (
                    <span className="rt-source-pill">
                      {capability.name} · {capability.kind}
                    </span>
                  )}
                </div>
                <div className="rt-trial__actions">
                  {!studioMode && (
                    <button
                      type="button"
                      className="rt-toolbar-pill rt-mobile-sessions-trigger"
                      aria-expanded={mobileSessionsOpen}
                      aria-controls="rt-mobile-session-panel"
                      onClick={() => setMobileSessionsOpen(true)}
                    >
                      会话管理
                    </button>
                  )}
                  {studioMode ? (
                    <>
                      {detail.currentUiArtifactId && (
                        <button
                          type="button"
                          className="rt-toolbar-pill rt-toolbar-pill--accent"
                          disabled={stream.running || createTrial.isPending}
                          onClick={() => void startCurrentUiTrial()}
                        >
                          {createTrial.isPending ? '正在创建试用…' : '试用当前 UI'}
                        </button>
                      )}
                      {releaseReturnTo && (
                        <button
                          type="button"
                          className="rt-toolbar-pill rt-toolbar-pill--accent"
                          disabled={stream.running}
                          onClick={() => window.location.assign(releaseReturnTo)}
                        >
                          下一步：定价与发布
                        </button>
                      )}
                      <a className="rt-toolbar-pill" href="/capabilities">
                        返回我的 Agent
                      </a>
                    </>
                  ) : returnTo ? (
                    <button
                      type="button"
                      className="rt-toolbar-pill"
                      onClick={() => window.location.assign(returnTo)}
                    >
                      {runtimeBackLabel(returnTo).replace(/^←\s*/, '')}
                    </button>
                  ) : (
                    <a className="rt-toolbar-pill" href="/capabilities">
                      返回我的 Agent
                    </a>
                  )}
                </div>
              </header>

              <main className={`rt-genui${showConversation ? ' rt-genui--conversation' : ''}`}>
                {showConversation && sessionId && (
                  <FloatingChat
                    key={`${sessionId}:${retryResolutionVersion}`}
                    sessionId={sessionId}
                    messages={messages}
                    streamingText={stream.streamingText}
                    isRunning={stream.running}
                    hasArtifact={activeArtifact !== null}
                    error={stream.errorMessage}
                    onSend={sendConversationMessage}
                    onInterrupt={stream.interrupt}
                    experience={experience}
                    formatMessageText={studioMode ? formatStudioAnnotationMessage : undefined}
                  />
                )}
                <div className="rt-genui__canvas" data-state={canvasState}>
                  {stream.pendingRetryAvailable && !stream.rechargeRequired && (
                    <div className="rt-inline-error" role="alert">
                      上一次发送结果仍待确认。为避免重复运行或扣费，请先重试原任务。
                      <button
                        type="button"
                        className="rt-toolbar-pill"
                        disabled={stream.running}
                        onClick={() => void retryPendingUsage()}
                      >
                        重试原任务
                      </button>
                    </div>
                  )}
                  {studioMode && activeArtifact && (
                    <StudioDesignToolbar
                      artifact={activeArtifact}
                      running={stream.running}
                      operationPending={operationPending}
                      inspectionEnabled={inspectionEnabled}
                      inspectableCount={inspectableElements.length}
                      selectedElement={selectedElement}
                      onToggleInspection={() => setInspectionEnabled((enabled) => !enabled)}
                      onClearSelection={() => {
                        setSelectedElement(null);
                        setInspectionEnabled(false);
                      }}
                      onOperation={(operation) => void runDesignOperation(operation)}
                    />
                  )}
                  {trialStartError && (
                    <div className="rt-inline-error" role="alert">
                      {trialStartError}
                    </div>
                  )}
                  {/* consume 首轮失败时对话尚未挂载，错误必须留在画布；Studio 的错误在左侧对话里。 */}
                  {stream.errorMessage && !showConversation && (
                    <div className="rt-inline-error" role="alert">
                      {stream.errorMessage}
                    </div>
                  )}
                  {(stream.artifactList.length > 1 ||
                    (studioMode && stream.artifactList.length > 0)) && (
                    <div
                      className={`rt-canvas-chips${studioMode ? ' rt-canvas-chips--revisions' : ''}`}
                      aria-label={studioMode ? 'UI 版本历史' : '产物列表'}
                    >
                      {stream.artifactList.map((a, index) => (
                        <button
                          key={a.id}
                          type="button"
                          className={`rt-artifact-chip${a.id === activeArtifact?.id ? ' is-active' : ''}`}
                          onClick={() => stream.selectArtifact(a.id)}
                        >
                          <span className="rt-artifact-chip__glyph">▤</span>
                          <span className="rt-artifact-chip__title">
                            {studioMode ? `版本 ${index + 1}` : (a.title ?? '未命名产物')}
                          </span>
                          {studioMode && detail.currentUiArtifactId === a.id && (
                            <span className="rt-artifact-chip__state">当前 UI</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  {activeArtifact ? (
                    <ArtifactStage
                      key={`${activeArtifact.id}:${retryResolutionVersion}`}
                      artifact={activeArtifact}
                      onRunRequest={
                        studioMode
                          ? undefined
                          : async ({ prompt }) => {
                              const message = await stream.send(prompt);
                              if (!message.turnId) {
                                throw new Error('运行请求缺少轮次标识，请重试。');
                              }
                              return { turnId: message.turnId };
                            }
                      }
                      runActive={!studioMode && stream.running}
                      activeRunId={studioMode ? null : stream.activeRunId}
                      terminalRun={studioMode ? null : stream.terminalRun}
                      runDisabledMessage={
                        studioMode
                          ? '当前是 UI 设计预览。请返回「我的 Agent」，从真实试用运行 Agent。'
                          : undefined
                      }
                      studioMode={studioMode}
                      inspectionEnabled={studioMode && inspectionEnabled}
                      selectedElementKey={studioMode ? (selectedElement?.key ?? null) : null}
                      onElementSelect={
                        studioMode
                          ? (element) => {
                              setSelectedElement(element);
                              setInspectionEnabled(false);
                            }
                          : undefined
                      }
                      onElementManifest={studioMode ? setInspectableElements : undefined}
                    />
                  ) : !studioMode && hasStarted && !showGenerating ? (
                    <div className="rt-empty">这轮还没有生成产物，可以在对话里继续要求。</div>
                  ) : null}
                  {(showStudioDefault || (!studioMode && showIntake)) && (
                    <div
                      className={`rt-genui__overlay${
                        studioMode ? ' rt-genui__overlay--studio-default' : ''
                      }`}
                    >
                      {studioMode ? (
                        <StudioDefaultPreview capability={capability} />
                      ) : (
                        <TrialIntakeForm
                          key={`${sessionId}:${retryResolutionVersion}`}
                          capability={capability}
                          disabled={stream.running}
                          onSubmit={(prompt) => {
                            void stream.send(prompt).catch(() => undefined);
                          }}
                        />
                      )}
                    </div>
                  )}
                  {showGenerating && (
                    <div className="rt-genui__overlay rt-genui__overlay--plain">
                      <GeneratingPageSkeleton startedAt={runStartedAt} experience={experience} />
                    </div>
                  )}
                </div>
              </main>
            </>
          )}
        </div>
        {!studioMode && mobileSessionsOpen && (
          <div
            className="rt-mobile-session-layer"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setMobileSessionsOpen(false);
            }}
          >
            <section
              id="rt-mobile-session-panel"
              className="rt-mobile-session-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="rt-mobile-session-title"
            >
              <div className="rt-mobile-session-panel__head">
                <h2 id="rt-mobile-session-title">会话管理</h2>
                <button
                  type="button"
                  autoFocus
                  aria-label="关闭会话管理"
                  onClick={() => setMobileSessionsOpen(false)}
                >
                  ×
                </button>
              </div>
              <SessionSidebar
                activeSessionId={sessionId}
                capabilityId={sidebarCapability?.id}
                capabilityName={sidebarCapability?.name}
                returnTo={contextualReturnTo}
                runningSessionId={stream.running ? sessionId : undefined}
                instanceId="mobile"
                experience={experience}
                onNavigate={() => setMobileSessionsOpen(false)}
              />
            </section>
          </div>
        )}
      </div>
      {stream.rechargeRequired && (
        <RechargeDialog
          requirement={stream.rechargeRequired}
          onClose={stream.clearRechargeRequired}
          onCredited={stream.abandonRechargeUsage}
          onAbandon={stream.abandonRechargeUsage}
        />
      )}
    </div>
  );
}

function StudioDesignToolbar({
  artifact,
  running,
  operationPending,
  inspectionEnabled,
  inspectableCount,
  selectedElement,
  onToggleInspection,
  onClearSelection,
  onOperation,
}: {
  artifact: ArtifactView;
  running: boolean;
  operationPending: boolean;
  inspectionEnabled: boolean;
  inspectableCount: number;
  selectedElement: ComboElementSelection | null;
  onToggleInspection: () => void;
  onClearSelection: () => void;
  onOperation: (operation: StudioDesignOperation) => void;
}) {
  const inspectionAvailable = artifact.kind === 'html';
  return (
    <section className="rt-studio-tools" aria-label="Studio 页面工具">
      <div className="rt-studio-tools__inspection">
        <button
          type="button"
          className={`rt-toolbar-pill${inspectionEnabled ? ' is-active' : ''}`}
          aria-pressed={inspectionEnabled}
          disabled={!inspectionAvailable || running}
          title={
            inspectionAvailable ? '在页面预览中选择要局部修改的元素' : '只有 HTML 页面可以选择元素'
          }
          onClick={onToggleInspection}
        >
          {inspectionEnabled ? '取消选择元素' : '选择页面元素'}
        </button>
        {inspectionAvailable && inspectableCount > 0 && (
          <span className="rt-studio-tools__count">{inspectableCount} 个可选元素</span>
        )}
        {selectedElement && (
          <span className="rt-studio-tools__selection">
            已选「{selectedElement.label}」
            <button type="button" aria-label="清除页面元素选择" onClick={onClearSelection}>
              ×
            </button>
          </span>
        )}
      </div>
      <div className="rt-studio-tools__operations" aria-label="设计操作">
        {STUDIO_DESIGN_OPERATIONS.map((operation) => (
          <button
            key={operation.id}
            type="button"
            className="rt-toolbar-pill"
            disabled={running || operationPending}
            title={operation.description}
            onClick={() => onOperation(operation)}
          >
            {operation.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function StudioDefaultPreview({
  capability,
}: {
  capability: NonNullable<SessionDetail['capability']>;
}) {
  return (
    <section className="rt-studio-default" aria-label="当前系统默认页面">
      <div className="rt-studio-default__notice">
        <span className="rt-studio-default__eyebrow">系统默认页面</span>
        <h2>这个 Agent 还没有专属 UI</h2>
        <p>消费者当前会看到下面的默认页面。在对话区描述要求后，会生成专属 UI 并自动替换。</p>
      </div>
      <div className="rt-studio-default__preview">
        <span className="rt-studio-default__preview-badge">仅预览 · 消费者默认页</span>
        <TrialIntakeForm
          capability={capability}
          disabled={false}
          preview
          onSubmit={() => undefined}
        />
      </div>
    </section>
  );
}

/** 产物舞台：内容回读（GET /runtime/artifacts/:id/content）+ 按 kind 渲染，占满画布。 */
function ArtifactStage({
  artifact,
  onRunRequest,
  runActive,
  activeRunId,
  terminalRun,
  runDisabledMessage,
  studioMode,
  inspectionEnabled,
  selectedElementKey,
  onElementSelect,
  onElementManifest,
}: {
  artifact: ArtifactView;
  onRunRequest?: (request: ComboRunRequest) => Promise<{ turnId: string }>;
  runActive: boolean;
  activeRunId: string | null;
  terminalRun: { runId: string; state: 'completed' | 'failed'; message: string } | null;
  runDisabledMessage?: string;
  studioMode: boolean;
  inspectionEnabled?: boolean;
  selectedElementKey?: string | null;
  onElementSelect?: (element: ComboElementSelection) => void;
  onElementManifest?: (elements: ComboElementSelection[]) => void;
}) {
  const content = useArtifactContent(artifact);
  const title = artifact.title ?? '未命名产物';
  const htmlStage =
    artifact.kind === 'html' ||
    Boolean(
      content.data &&
      ['<!doctype html', '<html'].some((prefix) =>
        content.data.trimStart().slice(0, 64).toLowerCase().startsWith(prefix),
      ),
    );
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const downloadHelpId = `rt-artifact-download-help-${artifact.id}`;
  const downloadTitle = artifactDownloadTitle(artifact.kind, studioMode);
  useEffect(() => setRunNotice(null), [artifact.id, runDisabledMessage]);
  return (
    <div
      className={`rt-artifact-stage${htmlStage ? ' rt-artifact-stage--html' : ''}${
        studioMode ? ' rt-artifact-stage--studio' : ''
      }`}
    >
      <div className="rt-artifact-stage__actions">
        {runNotice && (
          <span className="rt-artifact-run-notice" role="status">
            {runNotice}
          </span>
        )}
        <span id={downloadHelpId} className="rt-sr-only">
          {downloadTitle}
        </span>
        <button
          type="button"
          className="rt-toolbar-pill rt-artifact-download"
          disabled={content.data === undefined || content.isPending || content.isError}
          title={downloadTitle}
          aria-describedby={downloadHelpId}
          onClick={() => {
            if (content.data !== undefined) downloadArtifact(title, artifact.kind, content.data);
          }}
        >
          {content.isPending ? '正在准备…' : artifactDownloadLabel(artifact.kind, studioMode)}
        </button>
      </div>
      {content.isPending ? (
        <div className="rt-empty">产物加载中…</div>
      ) : content.isError ? (
        <div className="rt-empty rt-empty--error">产物内容加载失败，稍后重试。</div>
      ) : (
        <ArtifactRenderer
          kind={artifact.kind}
          title={title}
          content={content.data}
          onRunRequest={onRunRequest}
          runActive={runActive}
          activeRunId={activeRunId}
          terminalRun={terminalRun}
          runDisabledMessage={runDisabledMessage}
          onRunBlocked={setRunNotice}
          inspectionEnabled={inspectionEnabled}
          selectedElementKey={selectedElementKey}
          onElementSelect={onElementSelect}
          onElementManifest={onElementManifest}
        />
      )}
    </div>
  );
}
