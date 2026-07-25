import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FloatingChat, type FloatingChatProps } from './FloatingChat.js';

function props(overrides: Partial<FloatingChatProps> = {}): FloatingChatProps {
  return {
    sessionId: '11111111-1111-4111-8111-111111111111',
    messages: [],
    streamingText: null,
    isRunning: false,
    hasArtifact: true,
    error: null,
    onSend: vi.fn().mockResolvedValue(undefined),
    onInterrupt: vi.fn(),
    ...overrides,
  };
}

describe('FloatingChat conversation rail', () => {
  it('starts the first studio revision in the same conversation rail', () => {
    render(<FloatingChat {...props({ messages: [], hasArtifact: false, experience: 'studio' })} />);

    expect(screen.getByRole('complementary', { name: 'UI 设计对话' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '描述第一版 UI' })).toHaveAttribute(
      'placeholder',
      '描述你想要的页面结构、交互和视觉…',
    );
    expect(screen.getByRole('button', { name: '生成第一版 UI' })).toBeDisabled();
  });

  it('keeps the composer editable while a page change is running', () => {
    render(<FloatingChat {...props({ isRunning: true })} />);

    expect(screen.getByRole('textbox', { name: '描述页面修改' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '停止当前修改' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('正在应用修改');
  });

  it('uses explicit UI revision language for studio runs', () => {
    render(<FloatingChat {...props({ isRunning: true, experience: 'studio' })} />);

    expect(screen.getByRole('complementary', { name: 'UI 设计对话' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('正在应用 UI 修改');
  });

  it('keeps a running-turn draft without pretending it was queued or accepted', () => {
    const onInterrupt = vi.fn();
    render(<FloatingChat {...props({ isRunning: true, onInterrupt })} />);

    fireEvent.click(screen.getByRole('button', { name: '停止当前修改' }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);

    const composer = screen.getByRole('textbox', { name: '描述页面修改' });
    fireEvent.change(composer, { target: { value: '再收紧一点间距' } });
    expect(screen.getByRole('button', { name: '停止当前修改' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '当前修改完成后发送' })).toBeDisabled();
    expect(composer).toHaveValue('再收紧一点间距');
  });

  it('requires an explicit send after the active run completes', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const running = props({ isRunning: true, onSend });
    const { rerender } = render(<FloatingChat {...running} />);
    const composer = screen.getByRole('textbox', { name: '描述页面修改' });
    fireEvent.change(composer, { target: { value: '把主按钮改成暖红色' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(composer).toHaveValue('把主按钮改成暖红色');

    rerender(<FloatingChat {...running} isRunning={false} />);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('把主按钮改成暖红色'));
    await waitFor(() => expect(composer).toHaveValue(''));
  });

  it('sends an idle edit with Enter and keeps Shift+Enter for a newline', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<FloatingChat {...props({ onSend })} />);
    const composer = screen.getByRole('textbox', { name: '描述页面修改' });

    fireEvent.change(composer, { target: { value: '统一页面圆角' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('统一页面圆角'));
    await waitFor(() => expect(composer).toHaveValue(''));
  });

  it('retains the draft when the server rejects it', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('发送失败'));
    render(<FloatingChat {...props({ onSend })} />);
    const composer = screen.getByRole('textbox', { name: '描述页面修改' });
    fireEvent.change(composer, { target: { value: '扩大结果区域' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    await waitFor(() => expect(composer).toHaveValue('扩大结果区域'));
    expect(screen.getByRole('button', { name: '发送修改' })).toBeEnabled();
  });

  it('deduplicates clicks while acceptance is pending and preserves newer typing', async () => {
    let accept!: () => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    render(<FloatingChat {...props({ onSend })} />);
    const composer = screen.getByRole('textbox', { name: '描述页面修改' });
    fireEvent.change(composer, { target: { value: '第一条修改' } });
    const send = screen.getByRole('button', { name: '发送修改' });
    fireEvent.click(send);
    fireEvent.click(send);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '正在发送' })).toBeDisabled();
    fireEvent.change(composer, { target: { value: '第一条修改，并补充新要求' } });
    accept();
    await waitFor(() => expect(composer).toHaveValue('第一条修改，并补充新要求'));
  });
});
