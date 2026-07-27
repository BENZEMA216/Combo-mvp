// 按 kind 渲染产物内容。html 走【沙箱 iframe】（allow-scripts、无 same-origin，隔离父页）。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { renderMarkdown } from '../lib/markdown.js';
import { injectStudioInspectionBridge } from '../lib/studioInspectionBridge.js';

export interface ComboRunRequest {
  prompt: string;
}

export interface ComboRunAccepted {
  turnId: string;
}

export interface ComboElementSelection {
  key: string;
  label: string;
  role: string | null;
  text: string;
  tagName: string;
  /** Fixed, bounded `body > tag:nth-of-type(n)` path; never executed as a selector by the host. */
  path: string;
  /** True only when the artifact authored this element's data-combo-key. */
  stableKey: boolean;
}

export interface ComboTerminalRun {
  runId: string;
  state: 'completed' | 'failed';
  message: string;
}

export type ComboRunState = 'running' | 'completed' | 'failed' | 'blocked';

interface ComboRunStateMessage {
  type: 'combo:run-state';
  version: 1;
  state: ComboRunState;
  message: string;
}

interface ArtifactRendererProps {
  kind: string;
  title: string;
  content: string;
  /** Present only in a real consume session. Studio previews deliberately omit it. */
  onRunRequest?: (request: ComboRunRequest) => Promise<ComboRunAccepted>;
  /** True while any real Agent turn is active; used only to block another confirmation. */
  runActive?: boolean;
  /** The SSE run currently active in this session. */
  activeRunId?: string | null;
  /** The latest SSE terminal run. Only an id match may complete this Miniapp request. */
  terminalRun?: ComboTerminalRun | null;
  /** Studio uses this to explain why its preview cannot execute the business Agent. */
  runDisabledMessage?: string;
  onRunBlocked?: (message: string) => void;
  /** Studio-only inspection controls. Consume sessions never inject this bridge. */
  inspectionEnabled?: boolean;
  selectedElementKey?: string | null;
  onElementSelect?: (element: ComboElementSelection) => void;
  onElementManifest?: (elements: ComboElementSelection[]) => void;
}

export const MAX_COMBO_RUN_PROMPT_LENGTH = 12_000;
export const MAX_COMBO_INSPECTION_MESSAGE_LENGTH = 65_536;
const MAX_COMBO_ELEMENT_MANIFEST_LENGTH = 80;
const SAFE_ELEMENT_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;
const SAFE_GENERATED_KEY = /^auto-[a-z0-9]{1,12}$/;
const SAFE_TAG_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SAFE_STRUCTURAL_PATH = /^body(?: > [a-z][a-z0-9-]{0,31}:nth-of-type\([1-9]\d{0,5}\)){1,7}$/;

/** kind 误标防御：LLM 产物可能把完整 HTML 文档标成 markdown/structured（实测出现过），
 *  按 markdown 渲染会输出转义汤。内容以 HTML 文档开头时无视 kind、走沙箱 iframe。 */
function looksLikeHtmlDocument(content: string): boolean {
  const head = content.trimStart().slice(0, 64).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

export function ArtifactRenderer({
  kind,
  title,
  content,
  onRunRequest,
  runActive = false,
  activeRunId = null,
  terminalRun = null,
  runDisabledMessage,
  onRunBlocked,
  inspectionEnabled = false,
  selectedElementKey = null,
  onElementSelect,
  onElementManifest,
}: ArtifactRendererProps) {
  if (kind === 'html' || looksLikeHtmlDocument(content)) {
    return (
      <HtmlView
        title={title}
        content={content}
        onRunRequest={onRunRequest}
        runActive={runActive}
        activeRunId={activeRunId}
        terminalRun={terminalRun}
        runDisabledMessage={runDisabledMessage}
        onRunBlocked={onRunBlocked}
        inspectionEnabled={inspectionEnabled}
        selectedElementKey={selectedElementKey}
        onElementSelect={onElementSelect}
        onElementManifest={onElementManifest}
      />
    );
  }
  switch (kind) {
    case 'markdown':
      return <MarkdownView content={content} />;
    case 'code':
      return (
        <pre className="rt-artifact__code">
          <code>{content}</code>
        </pre>
      );
    case 'structured':
      return <StructuredView content={content} />;
    default:
      return <pre className="rt-artifact__raw">{content}</pre>;
  }
}

/**
 * Sandboxed Miniapps may request a real Agent turn through one narrow protocol.
 * The source-window check lives in HtmlView; this parser only validates the payload.
 */
export function parseComboRunRequest(value: unknown): ComboRunRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { type?: unknown; version?: unknown; prompt?: unknown };
  if (
    candidate.type !== 'combo:run' ||
    candidate.version !== 1 ||
    typeof candidate.prompt !== 'string'
  ) {
    return null;
  }
  const prompt = candidate.prompt.trim();
  if (!prompt || prompt.length > MAX_COMBO_RUN_PROMPT_LENGTH) return null;
  return { prompt };
}

function isBoundedInspectionPayload(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= MAX_COMBO_INSPECTION_MESSAGE_LENGTH;
  } catch {
    return false;
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Parse into a fresh object so extra/untrusted frame fields never cross the host boundary. */
export function parseComboElementSelection(value: unknown): ComboElementSelection | null {
  if (!isBoundedInspectionPayload(value) || typeof value !== 'object' || value === null)
    return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.key !== 'string' ||
    typeof candidate.label !== 'string' ||
    !(candidate.role === null || typeof candidate.role === 'string') ||
    typeof candidate.text !== 'string' ||
    typeof candidate.tagName !== 'string' ||
    typeof candidate.path !== 'string' ||
    typeof candidate.stableKey !== 'boolean'
  ) {
    return null;
  }
  const key = candidate.key.trim();
  const label = candidate.label.trim();
  const role = typeof candidate.role === 'string' ? candidate.role.trim() : null;
  const text = candidate.text.trim();
  const tagName = candidate.tagName.trim().toLowerCase();
  const path = candidate.path.trim();
  const finalPathPart = path.split(' > ').at(-1);
  if (
    !key ||
    !label ||
    label.length > 160 ||
    text.length > 240 ||
    (role !== null && (role.length > 60 || hasControlCharacter(role))) ||
    hasControlCharacter(label) ||
    hasControlCharacter(text) ||
    !SAFE_TAG_NAME.test(tagName) ||
    !SAFE_STRUCTURAL_PATH.test(path) ||
    !finalPathPart?.startsWith(`${tagName}:nth-of-type(`)
  ) {
    return null;
  }
  if (candidate.stableKey ? !SAFE_ELEMENT_KEY.test(key) : !SAFE_GENERATED_KEY.test(key)) {
    return null;
  }
  return { key, label, role, text, tagName, path, stableKey: candidate.stableKey };
}

export function parseComboElementSelectMessage(value: unknown): ComboElementSelection | null {
  if (!isBoundedInspectionPayload(value) || typeof value !== 'object' || value === null)
    return null;
  const candidate = value as { type?: unknown; version?: unknown; element?: unknown };
  if (candidate.type !== 'combo:element-select' || candidate.version !== 1) return null;
  return parseComboElementSelection(candidate.element);
}

export function parseComboElementManifestMessage(value: unknown): ComboElementSelection[] | null {
  if (!isBoundedInspectionPayload(value) || typeof value !== 'object' || value === null)
    return null;
  const candidate = value as { type?: unknown; version?: unknown; elements?: unknown };
  if (
    candidate.type !== 'combo:element-manifest' ||
    candidate.version !== 1 ||
    !Array.isArray(candidate.elements) ||
    candidate.elements.length > MAX_COMBO_ELEMENT_MANIFEST_LENGTH
  ) {
    return null;
  }
  const elements: ComboElementSelection[] = [];
  const keys = new Set<string>();
  for (const raw of candidate.elements) {
    const parsed = parseComboElementSelection(raw);
    if (!parsed || keys.has(parsed.key)) return null;
    keys.add(parsed.key);
    elements.push(parsed);
  }
  return elements;
}

function isComboInspectionReadyMessage(
  value: unknown,
): value is { type: 'combo:inspection-ready'; version: 1 } {
  if (!isBoundedInspectionPayload(value) || typeof value !== 'object' || value === null)
    return false;
  const candidate = value as { type?: unknown; version?: unknown };
  return candidate.type === 'combo:inspection-ready' && candidate.version === 1;
}

function HtmlView({
  title,
  content,
  onRunRequest,
  runActive = false,
  activeRunId = null,
  terminalRun = null,
  runDisabledMessage,
  onRunBlocked,
  inspectionEnabled = false,
  selectedElementKey = null,
  onElementSelect,
  onElementManifest,
}: Omit<ArtifactRendererProps, 'kind'>) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Set synchronously on an accepted postMessage. This closes the small gap before React
  // receives the optimistic `running` state from useSessionStream.
  const requestInFlightRef = useRef(false);
  const lastStateRef = useRef<ComboRunStateMessage | null>(null);
  const [pendingRequest, setPendingRequest] = useState<ComboRunRequest | null>(null);
  const [requestRunId, setRequestRunId] = useState<string | null>(null);
  const inspectionBridgeEnabled = Boolean(onElementSelect || onElementManifest);
  const srcDoc = useMemo(
    () => (inspectionBridgeEnabled ? injectStudioInspectionBridge(content) : content),
    [content, inspectionBridgeEnabled],
  );

  const postRunState = useCallback((state: ComboRunState, message: string): void => {
    const payload: ComboRunStateMessage = {
      type: 'combo:run-state',
      version: 1,
      state,
      message,
    };
    lastStateRef.current = payload;
    frameRef.current?.contentWindow?.postMessage(payload, '*');
  }, []);

  const syncInspectionState = useCallback((): void => {
    if (!inspectionBridgeEnabled) return;
    frameRef.current?.contentWindow?.postMessage(
      {
        type: 'combo:inspection-state',
        version: 1,
        enabled: inspectionEnabled,
        selectedElementKey,
      },
      '*',
    );
  }, [inspectionBridgeEnabled, inspectionEnabled, selectedElementKey]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>): void => {
      // The iframe has no same-origin privilege, so its WindowProxy is the only accepted source.
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (isComboInspectionReadyMessage(event.data)) {
        syncInspectionState();
        return;
      }
      const selected = parseComboElementSelectMessage(event.data);
      if (selected) {
        // The frame is untrusted content and can post this schema without a user click. Only an
        // explicit host-side inspection mode may turn it into editing context.
        if (inspectionEnabled) onElementSelect?.(selected);
        return;
      }
      const manifest = parseComboElementManifestMessage(event.data);
      if (manifest) {
        onElementManifest?.(manifest);
        return;
      }
      const request = parseComboRunRequest(event.data);
      if (!request) return;

      if (runDisabledMessage) {
        postRunState('blocked', runDisabledMessage);
        onRunBlocked?.(runDisabledMessage);
        return;
      }
      if (!onRunRequest) {
        postRunState('blocked', '当前页面不能运行 Agent。');
        return;
      }
      if (runActive || requestInFlightRef.current) {
        postRunState(
          'running',
          pendingRequest ? '请先在 Combo 中确认本次运行。' : 'Agent 正在处理当前任务，请稍候。',
        );
        return;
      }

      requestInFlightRef.current = true;
      setPendingRequest(request);
      postRunState('running', '请先在 Combo 中确认本次运行。');
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [
    onElementManifest,
    onElementSelect,
    inspectionEnabled,
    onRunBlocked,
    onRunRequest,
    pendingRequest,
    postRunState,
    runActive,
    runDisabledMessage,
    syncInspectionState,
  ]);

  useEffect(() => {
    syncInspectionState();
  }, [syncInspectionState]);

  useEffect(() => {
    if (!requestRunId) return;
    if (activeRunId === requestRunId) {
      postRunState('running', 'Agent 正在处理当前任务。');
    }
    if (terminalRun?.runId !== requestRunId) return;

    requestInFlightRef.current = false;
    setRequestRunId(null);
    postRunState(terminalRun.state, terminalRun.message);
  }, [activeRunId, postRunState, requestRunId, terminalRun]);

  const cancelPendingRun = (): void => {
    const message = '已取消，本次没有运行 Agent。';
    requestInFlightRef.current = false;
    setPendingRequest(null);
    postRunState('blocked', message);
    onRunBlocked?.(message);
  };

  const confirmPendingRun = (): void => {
    if (!pendingRequest || !onRunRequest) return;
    const request = pendingRequest;
    setPendingRequest(null);
    postRunState('running', 'Agent 已开始处理。');
    void onRunRequest(request)
      .then((accepted) => {
        if (!accepted.turnId) throw new Error('运行请求缺少轮次标识，请重试。');
        setRequestRunId(accepted.turnId);
      })
      .catch((error: unknown) => {
        requestInFlightRef.current = false;
        setRequestRunId(null);
        postRunState(
          'failed',
          error instanceof Error && error.message ? error.message : '请求没有发出，请重试。',
        );
      });
  };

  return (
    <>
      <iframe
        ref={frameRef}
        className="rt-artifact__frame"
        title={title}
        sandbox="allow-scripts allow-popups allow-forms"
        srcDoc={srcDoc}
        onLoad={() => {
          const state = lastStateRef.current;
          if (state) frameRef.current?.contentWindow?.postMessage(state, '*');
          syncInspectionState();
        }}
      />
      {pendingRequest && (
        <div className="rt-run-confirm-backdrop">
          <section
            className="rt-run-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rt-run-confirm-title"
            aria-describedby="rt-run-confirm-description"
          >
            <span className="rt-run-confirm__eyebrow">Combo 安全确认</span>
            <h2 id="rt-run-confirm-title">确认运行这个 Agent？</h2>
            <p id="rt-run-confirm-description">这会创建一次真实任务。以下内容将发送给 Agent：</p>
            <blockquote>{pendingRequest.prompt}</blockquote>
            <div className="rt-run-confirm__actions">
              <button
                type="button"
                className="rt-toolbar-pill"
                autoFocus
                onClick={cancelPendingRun}
              >
                取消
              </button>
              <button
                type="button"
                className="rt-toolbar-pill rt-run-confirm__submit"
                onClick={confirmPendingRun}
              >
                确认运行
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function MarkdownView({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return <div className="rt-md rt-artifact__md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 结构化产物：渲染成可读的键值/列表卡（#28），不再把裸 JSON 墙塞给用户；原始 JSON 收进折叠。 */
function StructuredView({ content }: { content: string }) {
  const parsed = useMemo(() => {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return null;
    }
  }, [content]);
  const pretty = useMemo(
    () => (parsed === null ? content : JSON.stringify(parsed, null, 2)),
    [parsed, content],
  );
  if (parsed === null || typeof parsed !== 'object') {
    return (
      <pre className="rt-artifact__code rt-artifact__json">
        <code>{pretty}</code>
      </pre>
    );
  }
  return (
    <div className="rt-structured">
      <StructuredNode value={parsed} depth={0} />
      <details className="rt-structured__raw">
        <summary>查看原始 JSON</summary>
        <pre className="rt-artifact__code rt-artifact__json">
          <code>{pretty}</code>
        </pre>
      </details>
    </div>
  );
}

/** 机器 key 人话化：snake/camel → 空格分词（中文 key 原样保留）。 */
function humanizeKey(key: string): string {
  if (/[一-鿿]/.test(key)) return key;
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

function StructuredNode({ value, depth }: { value: unknown; depth: number }): ReactElement {
  if (value === null || value === undefined) return <span className="rt-structured__nil">—</span>;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="rt-structured__nil">（空）</span>;
    return (
      <ul className="rt-structured__list">
        {value.map((item, i) => (
          <li key={i}>
            <StructuredNode value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="rt-structured__nil">（空）</span>;
  // 深层对象降级为紧凑 JSON，避免无限嵌套表格；前两层用键值行。
  if (depth >= 2) {
    return <code className="rt-structured__inline">{JSON.stringify(value)}</code>;
  }
  return (
    <dl className="rt-structured__group">
      {entries.map(([k, v]) => (
        <div className="rt-structured__row" key={k}>
          <dt className="rt-structured__key">{humanizeKey(k)}</dt>
          <dd className="rt-structured__val">
            <StructuredNode value={v} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
