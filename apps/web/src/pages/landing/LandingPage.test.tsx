import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LandingPage } from './LandingPage.js';
import { CREATION_INTAKE_STORAGE_KEY, saveLandingDraft } from './landingDraft.js';

function renderPageWithoutFetch() {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const view = render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
  return { fetchMock, ...view };
}

function getCodingAgentTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /使用 Coding Agent/ });
}

function getComboTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /粘贴公开主页/ });
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LandingPage', () => {
  it('匿名首屏展示折叠式双入口和默认 Agent 示例，全程不请求服务', () => {
    const { fetchMock } = renderPageWithoutFetch();

    expect(
      screen.getByRole('heading', {
        name: '把你的内容，变成一个可以工作的 Agent。',
      }),
    ).toBeInTheDocument();

    const codingAgentTrigger = getCodingAgentTrigger();
    const comboTrigger = getComboTrigger();
    expect(codingAgentTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(codingAgentTrigger).toHaveAttribute('aria-controls', 'cb-landing-agent-panel');
    expect(comboTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(comboTrigger).toHaveAttribute('aria-controls', 'cb-landing-combo-panel');
    expect(document.getElementById('cb-landing-agent-panel')).toBeNull();
    expect(document.getElementById('cb-landing-combo-panel')).toBeNull();
    expect(screen.getByText('选择一种方式开始')).toBeInTheDocument();

    expect(screen.getByRole('tablist', { name: '切换 Agent 示例' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '穿搭' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '内容' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: '复盘' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'cb-demo-tab-style');
    expect(screen.getByRole('heading', { name: '场合穿搭顾问' })).toBeInTheDocument();
    expect(screen.getByText('奶油色针织衫 + 深灰直筒裤')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('双入口点击后保持单开，切换回来不丢失 Combo 表单输入', async () => {
    const { fetchMock } = renderPageWithoutFetch();

    await userEvent.click(getComboTrigger());
    expect(getComboTrigger()).toHaveAttribute('aria-expanded', 'true');
    expect(getCodingAgentTrigger()).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('cb-landing-combo-panel')).toBeInTheDocument();

    const profileUrl = screen.getByLabelText('公开主页 URL');
    const consent = screen.getByLabelText(/我是账号本人或已获授权/);
    await userEvent.type(profileUrl, 'https://example.com/creator');
    await userEvent.click(consent);
    await userEvent.click(screen.getByText('可选：补充一段代表内容'));
    await userEvent.type(
      screen.getByRole('textbox', { name: /代表内容/ }),
      '这是一段足够长的代表内容，切换入口之后也不应该丢失。',
    );

    await userEvent.click(getCodingAgentTrigger());
    expect(getCodingAgentTrigger()).toHaveAttribute('aria-expanded', 'true');
    expect(getComboTrigger()).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('cb-landing-combo-panel')).toBeNull();
    expect(document.getElementById('cb-landing-agent-panel')).toBeInTheDocument();

    await userEvent.click(getComboTrigger());
    expect(screen.getByLabelText('公开主页 URL')).toHaveValue('https://example.com/creator');
    expect(screen.getByLabelText(/我是账号本人或已获授权/)).toBeChecked();
    expect(screen.getByRole('textbox', { name: /代表内容/ })).toHaveValue(
      '这是一段足够长的代表内容，切换入口之后也不应该丢失。',
    );
    expect(sessionStorage.getItem(CREATION_INTAKE_STORAGE_KEY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('复制 Coding Agent 任务成功时只写剪贴板并更新状态', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { fetchMock } = renderPageWithoutFetch();

    await userEvent.click(getCodingAgentTrigger());
    await userEvent.click(screen.getByRole('button', { name: '复制创建任务' }));

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]?.[0]).toContain('请帮我用 Combo 创建一个 KOL Agent');
    expect(writeText.mock.calls[0]?.[0]).toContain('先列出你计划读取的本地');
    expect(await screen.findByRole('status')).toHaveTextContent(
      '任务已复制。把它发给你的 Coding Agent 即可。',
    );
    expect(screen.getByRole('button', { name: '重新复制任务' })).toBeInTheDocument();
    expect(sessionStorage.getItem(CREATION_INTAKE_STORAGE_KEY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('复制 Coding Agent 任务失败时给出可恢复的 alert，仍不发请求', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard blocked'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { fetchMock } = renderPageWithoutFetch();

    await userEvent.click(getCodingAgentTrigger());
    await userEvent.click(screen.getByRole('button', { name: '复制创建任务' }));

    expect(writeText).toHaveBeenCalledOnce();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '没有成功写入剪贴板，请展开任务并手动复制。',
    );
    expect(screen.getByText('查看将复制的完整任务')).toBeInTheDocument();
    expect(sessionStorage.getItem(CREATION_INTAKE_STORAGE_KEY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Combo 资料仅写入 sessionStorage，并明确登录绑定账号后才上传', async () => {
    const { fetchMock } = renderPageWithoutFetch();

    await userEvent.click(getComboTrigger());
    await userEvent.type(
      screen.getByLabelText('公开主页 URL'),
      'https://example.com/creator#works',
    );
    await userEvent.click(screen.getByLabelText(/我是账号本人或已获授权/));
    await userEvent.click(screen.getByRole('button', { name: '准备这份资料' }));

    expect(await screen.findByText('资料已准备好')).toBeInTheDocument();
    expect(screen.getByText(/现在仍只保存在这个浏览器会话中/)).toBeInTheDocument();
    const cached = JSON.parse(sessionStorage.getItem(CREATION_INTAKE_STORAGE_KEY) ?? '{}') as {
      profileUrl?: string;
      mode?: string;
    };
    expect(cached).toMatchObject({
      profileUrl: 'https://example.com/creator',
      mode: 'kol_profile',
    });
    expect(screen.getByRole('link', { name: '登录并继续创建' })).toHaveAttribute('href', '/tasks');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL、授权和代表内容校验都会标记对应字段为 aria-invalid', async () => {
    const { fetchMock } = renderPageWithoutFetch();
    await userEvent.click(getComboTrigger());

    const profileUrl = screen.getByLabelText('公开主页 URL');
    await userEvent.type(profileUrl, 'ftp://example.com/creator');
    await userEvent.click(screen.getByRole('button', { name: '准备这份资料' }));
    expect(await screen.findByText('请粘贴一个公开的 http(s) 主页链接。')).toHaveAttribute(
      'id',
      'cb-landing-form-error',
    );
    expect(profileUrl).toHaveAttribute('aria-invalid', 'true');
    expect(profileUrl).toHaveAttribute('aria-describedby', 'cb-landing-form-error');

    await userEvent.clear(profileUrl);
    await userEvent.type(profileUrl, 'https://example.com/creator');
    expect(profileUrl).toHaveAttribute('aria-invalid', 'false');
    await userEvent.click(screen.getByRole('button', { name: '准备这份资料' }));
    const consent = screen.getByLabelText(/我是账号本人或已获授权/);
    expect(await screen.findByText('请先确认你有权使用这份公开内容。')).toBeInTheDocument();
    expect(consent).toHaveAttribute('aria-invalid', 'true');
    expect(consent).toHaveAttribute('aria-describedby', 'cb-landing-form-error');

    await userEvent.click(consent);
    await userEvent.click(screen.getByText('可选：补充一段代表内容'));
    const sample = screen.getByRole('textbox', { name: /代表内容/ });
    await userEvent.type(sample, '内容太短');
    await userEvent.click(screen.getByRole('button', { name: '准备这份资料' }));
    expect(await screen.findByText('代表内容至少写 20 个字，或者先留空。')).toBeInTheDocument();
    expect(sample).toHaveAttribute('aria-invalid', 'true');
    expect(sample).toHaveAttribute('aria-describedby', 'cb-landing-form-error');

    expect(sessionStorage.getItem(CREATION_INTAKE_STORAGE_KEY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('刷新 Landing 会恢复准备态并自动展开 Combo 入口', () => {
    saveLandingDraft({
      profileUrl: 'https://example.com/creator',
      consent: true,
      sampleText: '这是一段足够长的代表内容，用于恢复当前浏览器中的准备状态。',
    });
    const { fetchMock } = renderPageWithoutFetch();

    expect(getComboTrigger()).toHaveAttribute('aria-expanded', 'true');
    expect(getCodingAgentTrigger()).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('cb-landing-combo-panel')).toBeInTheDocument();
    expect(screen.getByText('资料已准备好')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/creator')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '准备这份资料' })).toBeNull();
    expect(screen.getByRole('link', { name: '登录并继续创建' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Agent 示例 tab 支持点击和键盘切换，并可比较普通回答与这个 Agent', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const { fetchMock } = renderPageWithoutFetch();

    const styleTab = screen.getByRole('tab', { name: '穿搭' });
    const contentTab = screen.getByRole('tab', { name: '内容' });
    const reflectionTab = screen.getByRole('tab', { name: '复盘' });

    await userEvent.click(contentTab);
    expect(contentTab).toHaveAttribute('aria-selected', 'true');
    expect(styleTab).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'cb-demo-tab-content');
    expect(screen.getByText('从“买得少”切入，而不是“买得便宜”')).toBeInTheDocument();
    expect(screen.queryByText('奶油色针织衫 + 深灰直筒裤')).toBeNull();

    expect(screen.getByRole('button', { name: '这个 Agent' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: '普通回答' }));
    expect(screen.getByRole('button', { name: '普通回答' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.getByText('可以从省钱技巧、平价单品推荐和搭配方法几个角度展开这条内容。'),
    ).toBeInTheDocument();
    expect(screen.queryByText('从“买得少”切入，而不是“买得便宜”')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '这个 Agent' }));
    expect(screen.getByText('从“买得少”切入，而不是“买得便宜”')).toBeInTheDocument();

    contentTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(reflectionTab).toHaveAttribute('aria-selected', 'true');
    expect(reflectionTab).toHaveFocus();
    expect(screen.getByText('先区分“消耗来源”和“成长缺口”')).toBeInTheDocument();

    await userEvent.keyboard('{Home}');
    expect(styleTab).toHaveAttribute('aria-selected', 'true');
    expect(styleTab).toHaveFocus();
    expect(screen.getByText('奶油色针织衫 + 深灰直筒裤')).toBeInTheDocument();

    expect(sessionStorage.getItem(CREATION_INTAKE_STORAGE_KEY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
