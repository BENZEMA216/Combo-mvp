import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { installFetchMock, type FetchMock } from '../test/mockFetch.js';
import { LoginPage, maskLoginEmail } from './LoginPage.js';

let fetchMock: FetchMock | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
  vi.restoreAllMocks();
});

const USER = {
  id: 'user-1',
  account: 'creator-testabcd',
  email: 'Alice@example.com',
  roles: ['creator'],
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: '2026-01-01T00:01:00.000Z',
};

const challengeAccepted = {
  status: 202,
  json: {
    data: { accepted: true, expiresInSeconds: 300, resendAfterSeconds: 60 },
    meta: { traceId: 'trace-challenge' },
  },
};

function deferredResponse() {
  let resolve!: (value: { status: number; json: unknown }) => void;
  const promise = new Promise<{ status: number; json: unknown }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderLogin(
  navigateAfterLogin = vi.fn<(path: string) => void>(),
  initialEntry = '/login?returnTo=%2Ftasks%2Ftask-1',
) {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LoginPage navigateAfterLogin={navigateAfterLogin} />
    </MemoryRouter>,
  );
  return navigateAfterLogin;
}

describe('LoginPage two-step email OTP flow', () => {
  it('redirects an existing session after the initial /me probe without showing the form', async () => {
    fetchMock = installFetchMock({
      status: 200,
      json: { data: USER, meta: { traceId: 'trace-existing-session' } },
    });
    const navigate = renderLogin();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tasks/task-1'));
    expect(fetchMock.calls.map(({ url }) => url)).toEqual(['/api/v1/me']);
    expect(screen.queryByRole('textbox', { name: '邮箱' })).toBeNull();
  });

  it('shows a terminal disabled state and switches accounts only through idempotent logout', async () => {
    fetchMock = installFetchMock([
      {
        status: 403,
        json: {
          error: {
            userMessage: '当前账号已停用。',
            retriable: false,
            action: 'escalate',
            traceId: 'trace-disabled',
          },
        },
      },
      {
        status: 200,
        json: { data: { loggedOut: true }, meta: { traceId: 'trace-disabled-logout' } },
      },
    ]);
    renderLogin();
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { name: '当前账号已停用' })).toBeInTheDocument();
    const disabledAlert = screen.getByRole('alert');
    expect(disabledAlert).toHaveFocus();
    expect(disabledAlert).toHaveTextContent('停用状态不能通过重试解除');
    expect(screen.queryByRole('button', { name: '重新检查登录状态' })).toBeNull();
    expect(fetchMock.calls.map(({ url }) => url)).toEqual(['/api/v1/me']);

    await user.click(screen.getByRole('button', { name: '清除当前登录并使用其他邮箱' }));
    expect(await screen.findByRole('textbox', { name: '邮箱' })).toHaveFocus();
    expect(fetchMock.calls.map(({ method, url }) => [method, url])).toEqual([
      ['GET', '/api/v1/me'],
      ['POST', '/api/v1/auth/logout'],
    ]);
  });

  it('completes the keyboard-accessible flow, preserves leading zeroes and uses no browser storage', async () => {
    fetchMock = installFetchMock([
      { status: 401, json: {} },
      challengeAccepted,
      {
        status: 200,
        json: {
          data: { user: USER, returnTo: '/tasks/task-1' },
          meta: { traceId: 'trace-login' },
        },
      },
    ]);
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    const navigate = renderLogin();
    const user = userEvent.setup();

    const emailInput = await screen.findByRole('textbox', { name: '邮箱' });
    expect(emailInput).toHaveFocus();
    expect(emailInput).toHaveAttribute('autocomplete', 'email');
    expect(emailInput).toHaveAttribute('type', 'email');

    await user.type(emailInput, 'Alice@example.com');
    await user.keyboard('{Enter}');

    const codeInput = await screen.findByRole('textbox', { name: '六位验证码' });
    expect(codeInput).toHaveFocus();
    expect(codeInput).toHaveAttribute('inputmode', 'numeric');
    expect(codeInput).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByText('Al***e@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /60 秒后可重发/ })).toBeDisabled();

    await user.type(codeInput, '00a4271');
    expect(codeInput).toHaveValue('004271');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tasks/task-1'));
    expect(fetchMock.calls.map(({ method, url }) => [method, url])).toEqual([
      ['GET', '/api/v1/me'],
      ['POST', '/api/v1/auth/email/challenges'],
      ['POST', '/api/v1/auth/email/verifications'],
    ]);
    expect(fetchMock.calls[2]?.body).toEqual({
      email: 'Alice@example.com',
      code: '004271',
      returnTo: '/tasks/task-1',
    });
    expect(storageSpy).not.toHaveBeenCalled();
  });

  it('moves focus to the first invalid field and does not send malformed input', async () => {
    fetchMock = installFetchMock({ status: 401, json: {} });
    renderLogin();
    const user = userEvent.setup();
    const emailInput = await screen.findByRole('textbox', { name: '邮箱' });

    await user.type(emailInput, 'not-an-email ');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('请输入完整邮箱地址，且不要包含空格。')).toBeInTheDocument();
    expect(emailInput).toHaveFocus();
    expect(emailInput).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock.calls).toHaveLength(1);
  });

  it('clears the one-time code when the user changes the email step', async () => {
    fetchMock = installFetchMock([{ status: 401, json: {} }, challengeAccepted, challengeAccepted]);
    renderLogin();
    const user = userEvent.setup();

    await user.type(await screen.findByRole('textbox', { name: '邮箱' }), 'Alice@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    await user.type(await screen.findByRole('textbox', { name: '六位验证码' }), '123456');
    await user.click(screen.getByRole('button', { name: '修改邮箱' }));

    expect(await screen.findByRole('textbox', { name: '邮箱' })).toHaveValue('Alice@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    expect(await screen.findByRole('textbox', { name: '六位验证码' })).toHaveValue('');
  });

  it('locks email changes for the full duration of a deferred resend', async () => {
    const resend = deferredResponse();
    fetchMock = installFetchMock([
      { status: 401, json: {} },
      challengeAccepted,
      { deferred: resend.promise },
    ]);
    renderLogin();
    const user = userEvent.setup();

    await user.type(await screen.findByRole('textbox', { name: '邮箱' }), 'old@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));

    await screen.findByRole('button', { name: /秒后可重发/ });
    const afterCooldown = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockReturnValue(afterCooldown);
    const resendButton = await screen.findByRole('button', { name: '重新发送验证码' });
    await user.click(resendButton);
    await waitFor(() => expect(screen.getByRole('button', { name: '修改邮箱' })).toBeDisabled());
    expect(screen.getByText('ol***d@example.com')).toBeInTheDocument();

    await act(async () => {
      resend.resolve(challengeAccepted);
      await resend.promise;
    });

    expect(screen.getByRole('textbox', { name: '六位验证码' })).toBeEnabled();
    expect(screen.getByText('ol***d@example.com')).toBeInTheDocument();
  });

  it('locks email changes for the full duration of a deferred verification', async () => {
    const verification = deferredResponse();
    fetchMock = installFetchMock([
      { status: 401, json: {} },
      challengeAccepted,
      { deferred: verification.promise },
    ]);
    const navigate = renderLogin();
    const user = userEvent.setup();

    await user.type(await screen.findByRole('textbox', { name: '邮箱' }), 'old@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    await user.type(await screen.findByRole('textbox', { name: '六位验证码' }), '123456');
    await user.click(screen.getByRole('button', { name: '验证并登录' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '修改邮箱' })).toBeDisabled());
    await act(async () => {
      verification.resolve({
        status: 200,
        json: {
          data: { user: USER, returnTo: '/tasks/task-1' },
          meta: { traceId: 'trace-deferred-verification' },
        },
      });
      await verification.promise;
    });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tasks/task-1'));
    expect(fetchMock.calls[2]?.body).toMatchObject({ email: 'old@example.com', code: '123456' });
  });

  it('keeps an invalid or expired code on step two with a focused, described error', async () => {
    fetchMock = installFetchMock([
      { status: 401, json: {} },
      challengeAccepted,
      {
        status: 401,
        json: {
          error: {
            userMessage: '验证码无效或已过期，请重新获取。',
            retriable: false,
            action: 'change_input',
            traceId: 'trace-invalid-code',
          },
        },
      },
    ]);
    renderLogin();
    const user = userEvent.setup();

    await user.type(await screen.findByRole('textbox', { name: '邮箱' }), 'Alice@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    const codeInput = await screen.findByRole('textbox', { name: '六位验证码' });
    await user.type(codeInput, '123456');
    await user.click(screen.getByRole('button', { name: '验证并登录' }));

    expect(await screen.findAllByText('验证码无效或已过期，请重新获取。')).not.toHaveLength(0);
    expect(codeInput).toHaveFocus();
    expect(codeInput).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock.calls).toHaveLength(3);
  });

  it('checks /me exactly once after an uncertain verification result instead of resubmitting the code', async () => {
    fetchMock = installFetchMock([
      { status: 401, json: {} },
      challengeAccepted,
      { networkError: true },
      {
        status: 200,
        json: { data: USER, meta: { traceId: 'trace-confirmed-session' } },
      },
    ]);
    const navigate = renderLogin();
    const user = userEvent.setup();

    await user.type(await screen.findByRole('textbox', { name: '邮箱' }), 'Alice@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    await user.type(await screen.findByRole('textbox', { name: '六位验证码' }), '123456');
    await user.click(screen.getByRole('button', { name: '验证并登录' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tasks/task-1'));
    expect(fetchMock.calls.map(({ url }) => url)).toEqual([
      '/api/v1/me',
      '/api/v1/auth/email/challenges',
      '/api/v1/auth/email/verifications',
      '/api/v1/me',
    ]);
  });

  it('probes /me exactly once after a verification 5xx before allowing any code resubmission', async () => {
    fetchMock = installFetchMock([
      { status: 401, json: {} },
      challengeAccepted,
      {
        status: 502,
        json: {
          error: {
            userMessage: '网关暂时没有响应。',
            retriable: true,
            action: 'retry',
            traceId: 'trace-verification-502',
          },
        },
      },
      { status: 401, json: {} },
    ]);
    renderLogin();
    const user = userEvent.setup();

    await user.type(await screen.findByRole('textbox', { name: '邮箱' }), 'Alice@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    await user.type(await screen.findByRole('textbox', { name: '六位验证码' }), '123456');
    await user.click(screen.getByRole('button', { name: '验证并登录' }));

    expect(await screen.findByText('尚未确认登录成功，请再次提交验证码。')).toBeInTheDocument();
    expect(fetchMock.calls.map(({ url }) => url)).toEqual([
      '/api/v1/me',
      '/api/v1/auth/email/challenges',
      '/api/v1/auth/email/verifications',
      '/api/v1/me',
    ]);
    expect(
      fetchMock.calls.filter(({ url }) => url === '/api/v1/auth/email/verifications'),
    ).toHaveLength(1);
  });

  it('honors Retry-After with a visible wait state and no automatic resend', async () => {
    fetchMock = installFetchMock([
      { status: 401, json: {} },
      {
        status: 429,
        headers: { 'retry-after': '2' },
        json: {
          error: {
            userMessage: '操作太频繁了，歇一会儿再试。',
            retriable: true,
            action: 'wait',
            traceId: 'trace-rate-wait',
          },
        },
      },
    ]);
    renderLogin();
    const user = userEvent.setup();

    await user.type(await screen.findByRole('textbox', { name: '邮箱' }), 'Alice@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));

    expect(await screen.findByText(/请求过于频繁，请在 [12] 秒后再试。/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /[12] 秒后可继续/ })).toBeDisabled();
    expect(fetchMock.calls).toHaveLength(2);
  });

  it('shows a manual dependency retry and retains the entered email', async () => {
    fetchMock = installFetchMock([
      { status: 401, json: {} },
      {
        status: 503,
        json: {
          error: {
            userMessage: '邮件服务暂时不可用，请稍后重试。',
            retriable: true,
            action: 'retry',
            traceId: 'trace-mail-503',
          },
        },
      },
      challengeAccepted,
    ]);
    renderLogin();
    const user = userEvent.setup();

    await user.type(await screen.findByRole('textbox', { name: '邮箱' }), 'Alice@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));

    const errors = await screen.findAllByText('邮件服务暂时不可用，请稍后重试。');
    const errorSummary = errors.find((node) => node.closest('[tabindex="-1"]'));
    expect(errorSummary?.closest('[tabindex="-1"]')).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '重新发送验证码' }));

    expect(await screen.findByRole('textbox', { name: '六位验证码' })).toHaveFocus();
    expect(fetchMock.calls[2]?.body).toEqual({ email: 'Alice@example.com' });
  });

  it('sanitizes an unsafe query returnTo before verification', async () => {
    fetchMock = installFetchMock([
      { status: 401, json: {} },
      challengeAccepted,
      {
        status: 200,
        json: {
          data: { user: USER, returnTo: '/tasks' },
          meta: { traceId: 'trace-safe-return' },
        },
      },
    ]);
    const navigate = renderLogin(undefined, '/login?returnTo=https%3A%2F%2Fevil.example%2Fphish');
    const user = userEvent.setup();

    await user.type(await screen.findByRole('textbox', { name: '邮箱' }), 'Alice@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    await user.type(await screen.findByRole('textbox', { name: '六位验证码' }), '123456');
    await user.click(screen.getByRole('button', { name: '验证并登录' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tasks'));
    expect(fetchMock.calls[2]?.body).toEqual({
      email: 'Alice@example.com',
      code: '123456',
      returnTo: '/tasks',
    });
  });
});

describe('maskLoginEmail', () => {
  it('masks the local part without changing the destination domain', () => {
    expect(maskLoginEmail('a@example.com')).toBe('a***@example.com');
    expect(maskLoginEmail('alice@example.com')).toBe('al***e@example.com');
  });
});
