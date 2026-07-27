// Stable conversation rail for repeated page edits. The name is kept for import
// compatibility, but the component is intentionally no longer a floating window:
// one history, one composer, and one dynamic primary action.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { MessageView } from '@cb/shared';
import type { RuntimeSessionExperience } from '../sessionExperience.js';
import { ChatThread } from './ChatThread.js';

export interface FloatingChatProps {
  sessionId: string;
  messages: MessageView[];
  streamingText: string | null;
  isRunning: boolean;
  hasArtifact: boolean;
  error: string | null;
  /** Resolve only after the server has accepted and persisted the user message. */
  onSend: (text: string) => Promise<unknown>;
  onInterrupt: () => void;
  experience?: RuntimeSessionExperience;
  formatMessageText?: (text: string) => string;
}

export function FloatingChat({
  sessionId,
  messages,
  streamingText,
  isRunning,
  hasArtifact,
  error,
  onSend,
  onInterrupt,
  experience = 'consume',
  formatMessageText,
}: FloatingChatProps) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const requestInFlightRef = useRef(false);
  const currentSessionRef = useRef(sessionId);

  useEffect(() => {
    currentSessionRef.current = sessionId;
    setText('');
    setSubmitting(false);
    requestInFlightRef.current = false;
  }, [sessionId]);

  const submit = useCallback(async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || isRunning || requestInFlightRef.current) return;
    const submittedText = text;
    const submittedSessionId = sessionId;
    requestInFlightRef.current = true;
    setSubmitting(true);
    try {
      await onSend(trimmed);
      if (currentSessionRef.current !== submittedSessionId) return;
      // If the user kept typing during the request, clear only the accepted draft.
      setText((current) => (current === submittedText ? '' : current));
    } catch {
      // useSessionStream owns the user-facing error. The draft deliberately remains intact.
    } finally {
      if (currentSessionRef.current === submittedSessionId) {
        requestInFlightRef.current = false;
        setSubmitting(false);
      }
    }
  }, [isRunning, onSend, sessionId, text]);

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    void submit();
  };

  const hasText = Boolean(text.trim());
  const isFirstStudioPrompt = experience === 'studio' && messages.length === 0 && !hasArtifact;
  const actionLabel =
    isRunning && !hasText
      ? '停止当前修改'
      : isRunning
        ? '当前修改完成后发送'
        : submitting
          ? '正在发送'
          : isFirstStudioPrompt
            ? '生成第一版 UI'
            : '发送修改';
  const runningLabel =
    experience === 'studio'
      ? hasArtifact
        ? '正在应用 UI 修改'
        : '正在生成第一版 UI'
      : hasArtifact
        ? '正在应用修改'
        : '正在生成页面';

  return (
    <aside
      className="rt-conversation-panel"
      aria-label={experience === 'studio' ? 'UI 设计对话' : '页面修改'}
    >
      <ChatThread
        messages={messages}
        streamingText={streamingText}
        runningLabel={isRunning ? runningLabel : undefined}
        formatMessageText={formatMessageText}
      />

      {error && (
        <div className="rt-conversation-panel__error" role="alert">
          {error}
        </div>
      )}

      <div className="rt-conversation-panel__footer">
        <div className="rt-conversation-composer" role="group" aria-label="页面修改输入">
          <textarea
            value={text}
            rows={4}
            placeholder={
              isFirstStudioPrompt
                ? '描述你想要的页面结构、交互和视觉…'
                : '想怎么改这个页面？描述期望的结果…'
            }
            aria-label={isFirstStudioPrompt ? '描述第一版 UI' : '描述页面修改'}
            aria-keyshortcuts="Enter"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <div className="rt-conversation-composer__actions">
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
                  aria-label="停止当前修改"
                  title="停止当前修改"
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
                disabled={(isRunning && hasText) || submitting || (!isRunning && !hasText)}
                onClick={isRunning && !hasText ? onInterrupt : () => void submit()}
              >
                <span aria-hidden="true">{isRunning && !hasText ? '■' : '↑'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
