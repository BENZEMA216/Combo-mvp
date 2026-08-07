import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ApiError } from '../api/client.js';
import { QueryErrorNotice } from './QueryErrorNotice.js';

describe('QueryErrorNotice authentication recovery', () => {
  it('routes every 401 through the first-party login page with a safe current /try path', () => {
    window.history.replaceState(
      {},
      '',
      '/try/session/11111111-1111-4111-8111-111111111111?mode=studio',
    );
    const navigateToAuth = vi.fn<(target: string) => void>();
    render(
      <QueryErrorNotice
        error={new ApiError('请先登录。', 401)}
        onRetry={vi.fn()}
        navigateToAuth={navigateToAuth}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('请先登录。');
    fireEvent.click(screen.getByRole('button', { name: '去登录' }));
    expect(navigateToAuth).toHaveBeenCalledWith(
      `/login?returnTo=${encodeURIComponent(
        '/try/session/11111111-1111-4111-8111-111111111111?mode=studio',
      )}`,
    );
  });

  it('announces a retryable query error and supports a compact host class', () => {
    const onRetry = vi.fn();
    render(
      <QueryErrorNotice
        error={new ApiError('历史会话暂时不可用。', 503)}
        onRetry={onRetry}
        className="rt-sidebar__empty rt-sidebar__empty--error"
      />,
    );

    expect(screen.getByRole('alert')).toHaveClass('rt-sidebar__empty--error');
    expect(screen.getByRole('alert')).toHaveTextContent('历史会话暂时不可用。');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
