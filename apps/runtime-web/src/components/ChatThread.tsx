// Codex-style conversation thread: messages are grouped by the real runtime turn id.
// The final assistant message is the conclusion; real tool/thinking blocks remain
// available in a compact disclosure instead of competing with the result.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MessageView } from '@cb/shared';
import { renderMarkdown } from '../lib/markdown.js';

export interface ThreadActivity {
  label: string;
  detail?: string;
  failed?: boolean;
  /** Stable key lets one tool call collapse into one final outcome. */
  key?: string;
}

export interface ContentParts {
  text: string;
  activities: ThreadActivity[];
}

function humanizeToolName(name: string): string {
  if (name === 'upsert_artifact') return '更新页面';
  return name.replace(/[_-]+/g, ' ').trim() || '调用工具';
}

/** pi native blocks -> user-facing text + truthful, compact activity metadata. */
export function splitContentBlocks(content: unknown[]): ContentParts {
  const texts: string[] = [];
  const activities: ThreadActivity[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as {
      type?: unknown;
      text?: unknown;
      name?: unknown;
      toolName?: unknown;
      id?: unknown;
      toolCallId?: unknown;
      isError?: unknown;
    };
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      continue;
    }
    if (block.type === 'toolCall') {
      const label = typeof block.name === 'string' ? humanizeToolName(block.name) : '调用工具';
      activities.push({
        label,
        key: 'tool:' + (typeof block.id === 'string' ? block.id : label),
      });
      continue;
    }
    if (block.type === 'toolResult') {
      const label =
        typeof block.toolName === 'string' ? humanizeToolName(block.toolName) : '工具执行';
      const failed = block.isError === true;
      activities.push({
        label: label + (failed ? '失败' : '已完成'),
        failed,
        key: 'tool:' + (typeof block.toolCallId === 'string' ? block.toolCallId : label),
      });
      continue;
    }
    if (block.type === 'thinking') {
      // Do not expose private reasoning; show only the truthful fact that analysis happened.
      activities.push({ label: '分析页面与任务' });
      continue;
    }
    if (block.type === 'image') activities.push({ label: '读取图片' });
  }
  return { text: texts.join('\n\n'), activities };
}

/** A call and its result are one user-visible action; the terminal result wins. */
export function compactActivities(activities: ThreadActivity[]): ThreadActivity[] {
  const compacted: ThreadActivity[] = [];
  const indexByKey = new Map<string, number>();
  for (const activity of activities) {
    if (!activity.key) {
      compacted.push(activity);
      continue;
    }
    const existingIndex = indexByKey.get(activity.key);
    if (existingIndex === undefined) {
      indexByKey.set(activity.key, compacted.length);
      compacted.push(activity);
      continue;
    }
    // A tool result carries the truthful terminal status and replaces the call placeholder.
    if (activity.failed || /(?:已完成|失败)$/.test(activity.label)) {
      compacted[existingIndex] = activity;
    }
  }
  return compacted;
}

interface MessageTurn {
  key: string;
  messages: MessageView[];
}

/** Legacy messages have no turnId and deliberately remain one-message turns. */
export function groupMessagesByTurn(messages: MessageView[]): MessageTurn[] {
  const turns: MessageTurn[] = [];
  const byId = new Map<string, MessageTurn>();
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    const key = message.turnId ?? 'message:' + message.id;
    let turn = byId.get(key);
    if (!turn) {
      turn = { key, messages: [] };
      byId.set(key, turn);
      turns.push(turn);
    }
    turn.messages.push(message);
  }
  return turns;
}

export interface ChatThreadProps {
  messages: MessageView[];
  /** Live assistant text before the turn is persisted. */
  streamingText: string | null;
  /** Honest activity label used only while no streaming text is available yet. */
  runningLabel?: string;
  /** Studio hides internal locator/operation routing while preserving it in model context. */
  formatMessageText?: (text: string) => string;
}

export function ChatThread({
  messages,
  streamingText,
  runningLabel,
  formatMessageText,
}: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const stickToLatestRef = useRef(true);
  const turns = useMemo(() => groupMessagesByTurn(messages), [messages]);

  useEffect(() => {
    if (!stickToLatestRef.current) return;
    window.requestAnimationFrame(() =>
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }),
    );
  }, [messages.at(-1)?.id, runningLabel, streamingText]);

  return (
    <div
      className="rt-thread"
      role="log"
      aria-label="对话记录"
      onScroll={(event) => {
        const target = event.currentTarget;
        stickToLatestRef.current =
          target.scrollHeight - target.scrollTop - target.clientHeight < 72;
      }}
    >
      {turns.map((turn) => (
        <TurnBlock key={turn.key} turn={turn} formatMessageText={formatMessageText} />
      ))}
      {streamingText !== null && (
        <div className="rt-msg rt-msg--assistant rt-msg--streaming">
          <div className="rt-msg__role">Combo</div>
          <AssistantBody
            text={formatMessageText ? formatMessageText(streamingText) : streamingText}
            streaming
          />
        </div>
      )}
      {runningLabel && streamingText === null && (
        <div className="rt-msg rt-msg--activity" role="status" aria-live="polite">
          <span className="rt-msg__activity-dot" aria-hidden="true" />
          <span>{runningLabel}</span>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function TurnBlock({
  turn,
  formatMessageText,
}: {
  turn: MessageTurn;
  formatMessageText?: (text: string) => string;
}) {
  const users = turn.messages.filter((message) => message.role === 'user');
  const assistants = turn.messages.filter((message) => message.role === 'assistant');
  const finalAssistant = assistants.at(-1);
  const finalParts = finalAssistant ? splitContentBlocks(finalAssistant.content) : null;
  const activities: ThreadActivity[] = [];

  for (const message of turn.messages) {
    if (message === finalAssistant || message.role === 'user') continue;
    const parts = splitContentBlocks(message.content);
    activities.push(...parts.activities);
    if (message.role === 'assistant' && parts.text) {
      activities.push({
        label: '中间说明',
        detail: formatMessageText ? formatMessageText(parts.text) : parts.text,
      });
    }
  }
  if (finalParts) activities.push(...finalParts.activities);
  const compactedActivities = compactActivities(activities);

  return (
    <section className="rt-thread__turn" data-turn-id={turn.key}>
      {users.map((message) => {
        const parts = splitContentBlocks(message.content);
        return (
          <div key={message.id} className="rt-msg rt-msg--user">
            <div className="rt-msg__bubble">
              {formatMessageText ? formatMessageText(parts.text) : parts.text}
            </div>
          </div>
        );
      })}
      {finalAssistant && finalParts && (
        <div className="rt-msg rt-msg--assistant">
          <div className="rt-msg__role">Combo</div>
          {finalAssistant.status === 'failed' && !finalParts.text ? (
            <div className="rt-msg__body rt-error rt-error--inline">这轮处理没有完成。</div>
          ) : (
            <AssistantBody
              text={formatMessageText ? formatMessageText(finalParts.text) : finalParts.text}
              failed={finalAssistant.status === 'failed'}
            />
          )}
          {compactedActivities.length > 0 && (
            <ActivityDisclosure activities={compactedActivities} />
          )}
        </div>
      )}
      {!finalAssistant && compactedActivities.length > 0 && (
        <ActivityDisclosure activities={compactedActivities} />
      )}
    </section>
  );
}

function ActivityDisclosure({ activities }: { activities: ThreadActivity[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rt-msg__activity-details"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span aria-hidden="true">{open ? '⌄' : '›'}</span>
        {open ? '收起执行详情' : '展开执行详情 · ' + activities.length}
      </summary>
      <ol>
        {activities.map((activity, index) => (
          <li
            key={(activity.key ?? activity.label) + '-' + index}
            data-failed={activity.failed ? 'true' : 'false'}
          >
            <span className="rt-msg__activity-icon" aria-hidden="true">
              {activity.failed ? '!' : '✓'}
            </span>
            <div>
              <strong>{activity.label}</strong>
              {activity.detail && <p>{activity.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

function AssistantBody({
  text,
  streaming,
  failed,
}: {
  text: string;
  streaming?: boolean;
  failed?: boolean;
}) {
  const html = useMemo(() => (text ? renderMarkdown(text) : ''), [text]);
  return (
    <div className={'rt-msg__body rt-md' + (failed ? ' rt-msg__body--failed' : '')}>
      {text ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : streaming ? (
        <span className="rt-typing" aria-label="正在回复">
          <span />
          <span />
          <span />
        </span>
      ) : null}
      {streaming && text && <span className="rt-caret" />}
    </div>
  );
}
