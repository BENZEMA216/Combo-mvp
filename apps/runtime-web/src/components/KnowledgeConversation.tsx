import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { KnowledgeTurnResult, MessageView } from '@cb/shared';
import { renderMarkdown } from '../lib/markdown.js';

export interface KnowledgeConversationProps {
  sessionId: string;
  messages: MessageView[];
  results: KnowledgeTurnResult[];
  isRunning: boolean;
  contractError?: boolean;
  pendingRetryAvailable?: boolean;
  onRetryPending?: () => Promise<unknown>;
  streamConnectionFailed?: boolean;
  onRetryStreamConnection?: () => void;
  onSend: (text: string) => Promise<unknown>;
  onInterrupt: () => void;
}

interface KnowledgeConversationEntry {
  key: string;
  user: MessageView | null;
  result: KnowledgeTurnResult | null;
}

const BILLING_SOURCE_LABEL: Record<KnowledgeTurnResult['billing']['source'], string> = {
  owner: '发布者承担',
  free: '免费额度',
  wallet: '钱包',
};

const VALIDATION_CODE_LABEL: Record<
  Extract<KnowledgeTurnResult, { outcome: 'failed' }>['validation']['code'],
  string
> = {
  not_run: '未执行',
  rejected: '引用校验未通过',
  unavailable: '知识服务暂不可用',
  protocol_invalid: '运行协议无效',
};

/** Knowledge Sessions never project assistant/tool blocks; only persisted user text is readable. */
export function knowledgeUserMessageText(message: MessageView): string {
  if (message.role !== 'user') return '';
  return message.content
    .flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const block = raw as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
    })
    .join('\n\n');
}

/** Pair immutable results to their user turn without depending on assistant Messages. */
export function buildKnowledgeConversationEntries(
  messages: MessageView[],
  results: KnowledgeTurnResult[],
): KnowledgeConversationEntry[] {
  const orderedUsers = messages
    .filter((message) => message.role === 'user')
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  const orderedResults = [...results].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.receiptId.localeCompare(right.receiptId),
  );
  const firstResultByTurn = new Map<string, KnowledgeTurnResult>();
  for (const result of orderedResults) {
    if (!firstResultByTurn.has(result.turnId)) firstResultByTurn.set(result.turnId, result);
  }

  const usedReceiptIds = new Set<string>();
  const entries = orderedUsers.map((user): KnowledgeConversationEntry => {
    const result = user.turnId ? (firstResultByTurn.get(user.turnId) ?? null) : null;
    if (result) usedReceiptIds.add(result.receiptId);
    return { key: `message:${user.id}`, user, result };
  });
  for (const result of orderedResults) {
    if (usedReceiptIds.has(result.receiptId)) continue;
    entries.push({ key: `receipt:${result.receiptId}`, user: null, result });
  }
  return entries;
}

export function formatKnowledgeCents(cents: string): string {
  if (!/^(0|[1-9][0-9]{0,18})$/u.test(cents)) return '金额不可用';
  const padded = cents.padStart(3, '0');
  return `¥${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

function visibleSubmissionError(error: unknown): string {
  if (!(error instanceof Error)) return '发送失败，请重试。';
  const message = error.message.trim();
  let hasUnsafeControl = false;
  for (let index = 0; index < message.length; index += 1) {
    const unit = message.charCodeAt(index);
    if (unit <= 0x08 || unit === 0x0b || unit === 0x0c || (unit >= 0x0e && unit <= 0x1f)) {
      hasUnsafeControl = true;
      break;
    }
  }
  if (!message || message.length > 300 || hasUnsafeControl) {
    return '发送失败，请重试。';
  }
  return message;
}

export function KnowledgeConversation({
  sessionId,
  messages,
  results,
  isRunning,
  contractError = false,
  pendingRetryAvailable = false,
  onRetryPending,
  streamConnectionFailed = false,
  onRetryStreamConnection,
  onSend,
  onInterrupt,
}: KnowledgeConversationProps) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const requestInFlightRef = useRef(false);
  const currentSessionRef = useRef(sessionId);
  const entries = useMemo(
    () => buildKnowledgeConversationEntries(messages, results),
    [messages, results],
  );

  useEffect(() => {
    currentSessionRef.current = sessionId;
    requestInFlightRef.current = false;
    setText('');
    setSubmitting(false);
    setSubmissionError(null);
  }, [sessionId]);

  const submit = useCallback(async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || isRunning || requestInFlightRef.current || contractError) return;
    const submittedText = text;
    const submittedSessionId = sessionId;
    requestInFlightRef.current = true;
    setSubmitting(true);
    setSubmissionError(null);
    try {
      await onSend(trimmed);
      if (currentSessionRef.current !== submittedSessionId) return;
      setText((current) => (current === submittedText ? '' : current));
    } catch (error: unknown) {
      if (currentSessionRef.current === submittedSessionId) {
        setSubmissionError(visibleSubmissionError(error));
      }
    } finally {
      if (currentSessionRef.current === submittedSessionId) {
        requestInFlightRef.current = false;
        setSubmitting(false);
      }
    }
  }, [contractError, isRunning, onSend, sessionId, text]);

  const retryPending = useCallback(async (): Promise<void> => {
    if (!onRetryPending || isRunning || requestInFlightRef.current) return;
    const retrySessionId = sessionId;
    requestInFlightRef.current = true;
    setSubmitting(true);
    setSubmissionError(null);
    try {
      await onRetryPending();
    } catch (error: unknown) {
      if (currentSessionRef.current === retrySessionId) {
        setSubmissionError(visibleSubmissionError(error));
      }
    } finally {
      if (currentSessionRef.current === retrySessionId) {
        requestInFlightRef.current = false;
        setSubmitting(false);
      }
    }
  }, [isRunning, onRetryPending, sessionId]);

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    void submit();
  };

  const hasText = Boolean(text.trim());
  const actionLabel = isRunning
    ? hasText
      ? '本轮回答完成后发送'
      : '停止本轮回答'
    : submitting
      ? '正在发送问题'
      : '发送问题';

  return (
    <section className="rt-knowledge-conversation" aria-label="知识问答">
      <KnowledgeThread
        entries={entries}
        isRunning={isRunning}
        streamConnectionFailed={streamConnectionFailed}
      />

      {contractError && (
        <div className="rt-knowledge-alert" role="alert">
          当前会话缺少权威知识结果，已停止展示候选回答。请刷新页面后重试。
        </div>
      )}
      {pendingRetryAvailable && !contractError && (
        <div className="rt-knowledge-alert" role="alert">
          上一次发送结果仍待确认。为避免重复运行或扣费，请重试原问题。
          <button
            type="button"
            className="rt-toolbar-pill"
            disabled={isRunning || submitting || !onRetryPending}
            onClick={() => void retryPending()}
          >
            重试原问题
          </button>
        </div>
      )}
      {streamConnectionFailed && (
        <div className="rt-knowledge-alert" role="alert">
          实时连接已中断。权威结果不会从候选文本恢复，请重新连接并刷新结果。
          <button
            type="button"
            className="rt-toolbar-pill"
            disabled={!onRetryStreamConnection}
            onClick={onRetryStreamConnection}
          >
            重新连接
          </button>
        </div>
      )}
      {submissionError && (
        <div className="rt-knowledge-alert" role="alert">
          {submissionError}
        </div>
      )}

      <div className="rt-knowledge-composer" role="group" aria-label="知识问题输入">
        <textarea
          value={text}
          rows={3}
          aria-label="输入知识问题"
          aria-keyshortcuts="Enter"
          placeholder="输入问题；答案只会在引用校验并生成使用收据后显示。"
          disabled={contractError}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleInputKeyDown}
        />
        <div className="rt-knowledge-composer__actions">
          <small>
            {isRunning
              ? '草稿会保留，本轮完成后再发送'
              : submitting
                ? '服务端接受后才会清空'
                : 'Enter 发送 · Shift + Enter 换行'}
          </small>
          <div className="rt-conversation-composer__buttons">
            {isRunning && hasText && (
              <button
                type="button"
                className="rt-conversation-stop"
                aria-label="停止本轮回答"
                title="停止本轮回答"
                onClick={onInterrupt}
              >
                <span aria-hidden="true">■</span>
              </button>
            )}
            <button
              type="button"
              className={'rt-conversation-send' + (isRunning && !hasText ? ' is-stop' : '')}
              aria-label={actionLabel}
              title={actionLabel}
              disabled={
                (contractError && !isRunning) ||
                (isRunning && hasText) ||
                submitting ||
                (!isRunning && !hasText)
              }
              onClick={isRunning && !hasText ? onInterrupt : () => void submit()}
            >
              <span aria-hidden="true">{isRunning && !hasText ? '■' : '↑'}</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function KnowledgeThread({
  entries,
  isRunning,
  streamConnectionFailed,
}: {
  entries: KnowledgeConversationEntry[];
  isRunning: boolean;
  streamConnectionFailed: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const unresolvedCount = entries.filter((entry) => entry.user && !entry.result).length;

  useEffect(() => {
    window.requestAnimationFrame(() =>
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }),
    );
  }, [entries.at(-1)?.key, isRunning]);

  return (
    <div className="rt-knowledge-thread" role="log" aria-label="知识问答记录">
      {entries.length === 0 && !isRunning && (
        <div className="rt-knowledge-empty" role="status">
          <strong>从一个问题开始</strong>
          <span>回答会绑定已发布知识引用和实际计费收据。</span>
        </div>
      )}
      {entries.map((entry) => (
        <article className="rt-knowledge-turn" key={entry.key}>
          {entry.user && (
            <div className="rt-msg rt-msg--user">
              <div className="rt-msg__bubble">{knowledgeUserMessageText(entry.user)}</div>
            </div>
          )}
          {entry.result && <KnowledgeResultCard result={entry.result} />}
        </article>
      ))}
      {isRunning && (
        <div className="rt-knowledge-running" role="status" aria-live="polite">
          <span className="rt-msg__activity-dot" aria-hidden="true" />
          正在检索并校验已发布知识…
        </div>
      )}
      {!isRunning && unresolvedCount > 0 && !streamConnectionFailed && (
        <div className="rt-knowledge-pending" role="status">
          正在确认权威结果；候选回答不会显示。
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function KnowledgeResultCard({ result }: { result: KnowledgeTurnResult }) {
  const label =
    result.outcome === 'answered'
      ? '已回答'
      : result.outcome === 'insufficient_evidence'
        ? '证据不足'
        : result.outcome === 'failed'
          ? '未完成'
          : '已中断';
  const role = result.outcome === 'failed' ? 'alert' : 'status';

  return (
    <div
      className={`rt-knowledge-result is-${result.outcome}`}
      role={role}
      aria-label={`知识回答：${label}`}
    >
      <div className="rt-knowledge-result__head">
        <span className="rt-knowledge-result__eyebrow">Combo 知识回答</span>
        <span className="rt-knowledge-result__status">{label}</span>
      </div>

      {result.answer ? (
        <KnowledgeAnswerText text={result.answer.text} />
      ) : result.outcome === 'failed' ? (
        <p className="rt-knowledge-result__notice">
          {VALIDATION_CODE_LABEL[result.validation.code]}，没有可展示的权威答案。
        </p>
      ) : (
        <p className="rt-knowledge-result__notice">本轮已中断，没有产生答案或扣费。</p>
      )}

      {result.citations.length > 0 && (
        <section className="rt-knowledge-citations" aria-label="来源引用">
          <h3>来源</h3>
          <ol>
            {result.citations.map((citation, index) => (
              <li key={citation.chunkId}>
                <span aria-hidden="true">[{index + 1}]</span>
                <span>{citation.displayLabel}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <KnowledgeReceipt result={result} />
    </div>
  );
}

function KnowledgeAnswerText({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div className="rt-knowledge-result__answer rt-md" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function KnowledgeReceipt({ result }: { result: KnowledgeTurnResult }) {
  const billingSource = BILLING_SOURCE_LABEL[result.billing.source];
  const settled = formatKnowledgeCents(result.billing.settledCents);
  return (
    <details className="rt-knowledge-receipt">
      <summary>
        使用收据 · {billingSource} · 实际结算 {settled}
      </summary>
      <dl>
        <div>
          <dt>结果</dt>
          <dd>{result.outcome}</dd>
        </div>
        <div>
          <dt>实际扣费来源</dt>
          <dd>{billingSource}</dd>
        </div>
        <div>
          <dt>实际结算</dt>
          <dd>{settled}</dd>
        </div>
        <div>
          <dt>收据 ID</dt>
          <dd>{result.receiptId}</dd>
        </div>
        <div>
          <dt>Usage ID</dt>
          <dd>{result.usageId}</dd>
        </div>
        <div>
          <dt>Package Release</dt>
          <dd>{result.binding.release.releaseId}</dd>
        </div>
        <div>
          <dt>Package Digest</dt>
          <dd>{result.binding.release.packageDigest}</dd>
        </div>
        <div>
          <dt>Runtime Release</dt>
          <dd>{result.runtime.releaseId}</dd>
        </div>
        <div>
          <dt>Runtime Source SHA</dt>
          <dd>{result.runtime.sourceSha}</dd>
        </div>
      </dl>
    </details>
  );
}
