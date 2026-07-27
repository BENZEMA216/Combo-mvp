import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TaskEventsState } from '../../api/useTaskEvents.js';
import { ExtractCard } from './TaskDetailPage.js';

const progress = {
  percent: 60,
  phrase: '旧进度不应继续显示',
  subtasks: [],
};

describe('ExtractCard SSE handshake failures', () => {
  it('renders an initial 401 before the loading skeleton and routes to the custom login action', async () => {
    const onLogin = vi.fn();
    const state: TaskEventsState = {
      status: 'error',
      items: [],
      error: {
        userMessage: '请先登录。',
        retriable: false,
        action: 'escalate',
        traceId: 'trace-sse-401',
      },
    };

    render(<ExtractCard sse={state} onReconnect={vi.fn()} onLogin={onLogin} />);

    expect(screen.getByRole('alert')).toHaveTextContent('请先登录。');
    expect(screen.queryByText('正在连接进度流')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '去登录' }));
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it('replaces stale progress after a 503 and exposes an explicit reconnect action', async () => {
    const onReconnect = vi.fn();
    const state: TaskEventsState = {
      status: 'error',
      items: [],
      progress,
      error: {
        userMessage: '进度服务暂时不可用，请稍后重试。',
        retriable: true,
        action: 'retry',
        traceId: 'trace-sse-503',
      },
    };

    render(<ExtractCard sse={state} onReconnect={onReconnect} />);

    expect(screen.getByRole('alert')).toHaveTextContent('进度服务暂时不可用');
    expect(screen.queryByText(progress.phrase)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '重新连接' }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
