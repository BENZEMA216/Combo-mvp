import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MessageView } from '@cb/shared';
import {
  ChatThread,
  compactActivities,
  groupMessagesByTurn,
  splitContentBlocks,
} from './ChatThread.js';

const TURN = '11111111-1111-4111-8111-111111111111';

function message(
  id: string,
  seq: number,
  role: MessageView['role'],
  content: unknown[],
  overrides: Partial<MessageView> = {},
): MessageView {
  return {
    id,
    seq,
    turnId: TURN,
    role,
    content,
    status: 'completed',
    createdAt: '2026-07-22T10:00:00.000Z',
    ...overrides,
  };
}

describe('ChatThread', () => {
  it('groups a real runtime turn and keeps the final assistant conclusion primary', () => {
    const messages = [
      message('m1', 1, 'user', [{ type: 'text', text: '把页面改得更克制' }]),
      message('m2', 2, 'assistant', [
        { type: 'text', text: '我先检查并更新页面。' },
        { type: 'toolCall', id: 'tc-1', name: 'upsert_artifact', arguments: {} },
      ]),
      message('m3', 3, 'tool', [
        {
          type: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'upsert_artifact',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        },
      ]),
      message('m4', 4, 'assistant', [{ type: 'text', text: '页面已经更新好了。' }]),
    ];

    render(<ChatThread messages={messages} streamingText={null} />);

    expect(screen.getByText('页面已经更新好了。')).toBeInTheDocument();
    const details = screen.getByText('展开执行详情 · 2').closest('details');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('展开执行详情 · 2'));
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('中间说明')).toBeInTheDocument();
    expect(screen.getByText('更新页面已完成')).toBeInTheDocument();
  });

  it('renders every historical message without truncating the conversation', () => {
    const messages = Array.from({ length: 8 }, (_, index) =>
      message(
        'm' + index,
        index,
        index % 2 === 0 ? 'user' : 'assistant',
        [{ type: 'text', text: '第 ' + (index + 1) + ' 条消息' }],
        { turnId: undefined },
      ),
    );
    render(<ChatThread messages={messages} streamingText={null} />);

    expect(screen.getByText('第 1 条消息')).toBeInTheDocument();
    expect(screen.getByText('第 8 条消息')).toBeInTheDocument();
  });

  it('shows only an honest running label before streamed text arrives', () => {
    render(<ChatThread messages={[]} streamingText={null} runningLabel="正在生成页面" />);
    expect(screen.getByRole('status')).toHaveTextContent('正在生成页面');
    expect(screen.queryByText(/读取能力定义|整理产物结构/)).not.toBeInTheDocument();
  });

  it('does not steal scroll when the user is reading older messages', async () => {
    const first = [message('m1', 1, 'user', [{ type: 'text', text: '第一条' }])];
    const { rerender } = render(<ChatThread messages={first} streamingText={null} />);
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    const callsBefore = vi.mocked(Element.prototype.scrollIntoView).mock.calls.length;
    const log = screen.getByRole('log', { name: '对话记录' });
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(log);

    rerender(
      <ChatThread
        messages={[...first, message('m2', 2, 'assistant', [{ type: 'text', text: '第二条' }])]}
        streamingText={null}
      />,
    );
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.calls).toHaveLength(callsBefore);
  });

  it('formats Studio locator context only for the creator-facing user bubble', () => {
    const messages = [
      message('m1', 1, 'user', [{ type: 'text', text: 'internal locator\n把按钮放大' }]),
    ];
    render(
      <ChatThread
        messages={messages}
        streamingText={null}
        formatMessageText={(text) => text.replace('internal locator\n', '标注「主按钮」\n')}
      />,
    );

    expect(screen.getByText(/标注「主按钮」/)).toBeInTheDocument();
    expect(screen.queryByText(/internal locator/)).not.toBeInTheDocument();
  });
});

describe('conversation block parsing', () => {
  it('keeps private thinking hidden while exposing a truthful activity label', () => {
    expect(
      splitContentBlocks([{ type: 'thinking', thinking: 'private chain of thought' }]),
    ).toEqual({ text: '', activities: [{ label: '分析页面与任务' }] });
  });

  it('groups same-turn messages by the server turn id', () => {
    const messages = [
      message('m1', 1, 'user', [{ type: 'text', text: '问题' }]),
      message('m2', 2, 'assistant', [{ type: 'text', text: '回答' }]),
    ];
    expect(groupMessagesByTurn(messages)).toHaveLength(1);
  });

  it('collapses a tool call and result into one truthful terminal activity', () => {
    expect(
      compactActivities([
        { key: 'tool:1', label: '更新页面' },
        { key: 'tool:1', label: '更新页面失败', failed: true },
      ]),
    ).toEqual([{ key: 'tool:1', label: '更新页面失败', failed: true }]);
  });

  it('labels failed tool results as failed instead of completed', () => {
    expect(
      splitContentBlocks([
        { type: 'toolResult', toolCallId: 'tc-1', toolName: 'upsert_artifact', isError: true },
      ]).activities,
    ).toEqual([{ key: 'tool:tc-1', label: '更新页面失败', failed: true }]);
  });
});
