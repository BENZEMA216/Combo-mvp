import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyInstruction } from './CopyInstruction.js';

const props = {
  text: '原始指令\n第二行 <不执行>',
  label: '复制使用指令',
  copiedHint: '已复制，尚未安装。',
};
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('CopyInstruction exact text recovery', () => {
  it('copies only on click and announces only clipboard success', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText');
    render(<CopyInstruction {...props} />);
    expect(copy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: props.label }));
    expect(copy).toHaveBeenCalledWith(props.text);
    expect(await screen.findByRole('status')).toHaveTextContent(props.copiedHint);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it.each(['missing', 'rejected'])(
    'offers identical selectable text if clipboard is %s',
    async (mode) => {
      const user = userEvent.setup();
      if (mode === 'missing') Reflect.deleteProperty(navigator, 'clipboard');
      else vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('blocked'));
      render(<CopyInstruction {...props} />);
      await user.click(screen.getByRole('button', { name: props.label }));
      const input = await screen.findByRole('textbox', { name: props.label + '的完整文本' });
      expect(input).toHaveValue(props.text);
      expect(input).toHaveAttribute('readonly');
      await user.click(input);
      expect((input as HTMLTextAreaElement).selectionStart).toBe(0);
      expect((input as HTMLTextAreaElement).selectionEnd).toBe(props.text.length);
      expect(screen.getByRole('alert')).toHaveTextContent('手动复制');
    },
  );
  it('clears stale feedback and fallback when the exact text changes', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('blocked'));
    const view = render(<CopyInstruction {...props} />);
    await user.click(screen.getByRole('button', { name: props.label }));
    await screen.findByRole('alert');
    view.rerender(<CopyInstruction {...props} text="新版本的完整指令" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
