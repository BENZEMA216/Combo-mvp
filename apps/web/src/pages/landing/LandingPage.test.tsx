import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CODING_AGENT_CREATION_TASK, LandingPage } from './LandingPage.js';
import { CREATION_INTAKE_STORAGE_KEY, saveLandingDraft } from './landingDraft.js';

const fetchMock = vi.fn();
function mount() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  sessionStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LandingPage current conversation entry', () => {
  it('shows one copy action and a clearly labeled concept without probing login or package data', () => {
    mount();
    expect(screen.getByRole('heading', { name: /把对话，\s*变成 Agent。/u })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('figure')).toHaveAccessibleName(/概念示意/u);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.title).toBe('把对话，变成 Agent · Combo');
  });
  it('copies the exact bounded installation request only on user click', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    mount();
    expect(write).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '复制指令' }));
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(CODING_AGENT_CREATION_TASK);
    expect(CODING_AGENT_CREATION_TASK).toContain('解析并固定当前版本');
    expect(CODING_AGENT_CREATION_TASK).toContain('不开始制作、上传或分享');
    expect(CODING_AGENT_CREATION_TASK).toContain('不切换来源、不卸载已有插件');
    expect(await screen.findByRole('status')).toHaveTextContent('先检查当前客户端的安装支持');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CREATION_INTAKE_STORAGE_KEY)).toBeNull();
  });
  it('automatically exposes the full selectable text when clipboard rejects', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('blocked'));
    mount();
    await user.click(screen.getByRole('button', { name: '复制指令' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('手动复制');
    expect(screen.getByRole('textbox', { name: '复制指令的完整文本' })).toHaveValue(
      CODING_AGENT_CREATION_TASK,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('neither loads nor deletes a previously saved legacy intake draft', () => {
    saveLandingDraft({
      profileUrl: 'https://example.com/creator',
      consent: true,
      sampleText: '这是一份用户以前保存的资料，新的入口不应读取或删除它。',
    });
    const previous = sessionStorage.getItem(CREATION_INTAKE_STORAGE_KEY);
    mount();
    expect(screen.queryByText('https://example.com/creator')).toBeNull();
    expect(sessionStorage.getItem(CREATION_INTAKE_STORAGE_KEY)).toBe(previous);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
