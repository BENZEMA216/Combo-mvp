// 会话身份 / 登录守卫测试（B-08）——四态收敛核心：
//   fetchMe 按 HTTP status 区分 200/401/其它（绝不把 status 漏到 UI）；
//   loginUrl 带 returnTo（Fix3）；RequireAuth 在 error 态给「重试」（非「去登录」），不伪装成 anon。
import type { ReactElement } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { MeView, ReleaseMetadata } from '@cb/shared';
import { installFetchMock, type FetchMock } from '../test/mockFetch.js';
import {
  fetchMe,
  authEntryUrl,
  loginUrl,
  previewBootstrapUrl,
  goToLogin,
  reconcileMeProbe,
  AuthProvider,
  RequireAuth,
  useAuth,
  AUTH_LOGIN_PATH,
  AUTH_REFRESH_PATH,
  PREVIEW_BOOTSTRAP_PATH,
} from './auth.js';
import { ReleaseMetadataProvider } from './releaseIdentity.js';

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

const ME: MeView = {
  id: 'user-1',
  account: 'Wayne',
  email: 'wayne@example.com',
  roles: ['creator'],
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

/** /me 200 真实响应形态：后端返回轻包络 Envelope<MeView>（{ data, meta }，见 auth-handlers.ts:348）。 */
const ME_ENVELOPE = { data: ME, meta: { traceId: 'trace-me-1' } };

describe('fetchMe — 按 HTTP status 收敛四态（status 只内部用，不渲染 UI）', () => {
  it('200 + 合法 Envelope<MeView> → authed（解包 .data 后按 shared schema 解析）', async () => {
    // 真实后端返回轻包络 { data: MeView, meta }，探针须先解包再校验（裸 MeView 不是后端真实形态）。
    fm = installFetchMock({ status: 200, json: ME_ENVELOPE });
    const probe = await fetchMe();
    expect(probe.status).toBe('authed');
    expect(probe.status === 'authed' && probe.me.account).toBe('Wayne');
    // 同 client.ts：API_PREFIX 前缀 + credentials:'include'。
    expect(fm.calls[0]?.url).toBe('/api/v1/me');
    expect(fm.calls[0]?.credentials).toBe('include');
  });

  it('200 但 body 是裸 MeView（缺 data 包络）→ error（后端真实形态是 Envelope，裸 MeView 不该被当已登录）', async () => {
    fm = installFetchMock({ status: 200, json: ME });
    expect((await fetchMe()).status).toBe('error');
  });

  it('401 → anon（唯一该「去登录」的情形）', async () => {
    fm = installFetchMock({
      status: 401,
      json: {
        error: { userMessage: '请先登录', retriable: false, action: 'escalate', traceId: 't' },
      },
    });
    const probe = await fetchMe();
    expect(probe.status).toBe('anon');
    expect(fm.calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', '/api/v1/me'],
      ['POST', AUTH_REFRESH_PATH],
    ]);
    expect(fm.calls[1]?.credentials).toBe('include');
  });

  it('401 → refresh 2xx → /me 200：自动续期后恢复 authed', async () => {
    fm = installFetchMock([
      { status: 401, json: { error: { userMessage: '会话已过期' } } },
      { status: 204 },
      { status: 200, json: ME_ENVELOPE },
    ]);

    const probe = await fetchMe();

    expect(probe.status).toBe('authed');
    expect(probe.status === 'authed' && probe.me.account).toBe('Wayne');
    expect(fm.calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', '/api/v1/me'],
      ['POST', AUTH_REFRESH_PATH],
      ['GET', '/api/v1/me'],
    ]);
  });

  it('401 → refresh 明确 401：anon，不继续请求 /me', async () => {
    const status = 401;
    fm = installFetchMock([
      { status: 401, json: { error: { userMessage: '会话已过期' } } },
      { status, json: { error: { userMessage: 'refresh token 已失效' } } },
    ]);

    expect((await fetchMe()).status).toBe('anon');
    expect(fm.calls).toHaveLength(2);
  });

  it.each([503, 429, 403, 400])(
    '401 → refresh %s：error 可重试，不把非明确凭据失效当成 anon',
    async (status) => {
      fm = installFetchMock([
        { status: 401, json: { error: { userMessage: '会话已过期' } } },
        { status, json: { error: { userMessage: '续期暂时不可用' } } },
      ]);

      expect((await fetchMe()).status).toBe('error');
      expect(fm.calls).toHaveLength(2);
    },
  );

  it('401 → refresh 网络失败：error 可重试，不把未知状态伪装成 anon', async () => {
    fm = installFetchMock([
      { status: 401, json: { error: { userMessage: '会话已过期' } } },
      { networkError: true },
    ]);

    expect((await fetchMe()).status).toBe('error');
    expect(fm.calls).toHaveLength(2);
  });

  it('401 → refresh 2xx → /me 再次 401：anon，整条链最多三次请求不循环', async () => {
    fm = installFetchMock([
      { status: 401, json: { error: { userMessage: '会话已过期' } } },
      { status: 204 },
      { status: 401, json: { error: { userMessage: '会话确已失效' } } },
    ]);

    expect((await fetchMe()).status).toBe('anon');
    expect(fm.calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', '/api/v1/me'],
      ['POST', AUTH_REFRESH_PATH],
      ['GET', '/api/v1/me'],
    ]);
  });

  it('503 登录服务不可用 → error（绝非伪装成「请先登录」）', async () => {
    fm = installFetchMock({ status: 503, json: { error: { userMessage: '服务不可用' } } });
    expect((await fetchMe()).status).toBe('error');
  });

  it('403 disabled → error（不是 anon）', async () => {
    fm = installFetchMock({ status: 403, json: { error: { userMessage: '账号被禁用' } } });
    expect((await fetchMe()).status).toBe('error');
  });

  it('500 → error', async () => {
    fm = installFetchMock({ status: 500, json: { error: { userMessage: '服务开小差' } } });
    expect((await fetchMe()).status).toBe('error');
  });

  it('网络断 → error（不当成未登录）', async () => {
    fm = installFetchMock({ networkError: true });
    expect((await fetchMe()).status).toBe('error');
  });

  it('200 但 data 内 MeView 缺必填字段 → error（不冒充已登录）', async () => {
    // 包络对了但 data 不是合法 MeView（缺必填字段），仍按 error 收敛。
    fm = installFetchMock({ status: 200, json: { data: { account: 'Wayne' }, meta: {} } });
    expect((await fetchMe()).status).toBe('error');
  });
});

describe('loginUrl — 带 returnTo（Fix3，开放重定向防护在后端）', () => {
  it('无 returnTo → 裸登录路径', () => {
    expect(loginUrl()).toBe(AUTH_LOGIN_PATH);
  });

  it('有 returnTo（同站相对路径）→ ?returnTo=<encoded>', () => {
    const taskReturn = '/tasks/01982e62-6d6e-7f4d-8fe8-b55f62720b5b?tab=history';
    expect(loginUrl(taskReturn)).toBe(
      `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(taskReturn)}`,
    );
  });

  it('returnTo 为绝对 http(s):// URL → 丢弃,回裸登录路径(开放重定向防护)', () => {
    expect(loginUrl('https://evil.example.com/phish')).toBe(AUTH_LOGIN_PATH);
    expect(loginUrl('http://evil.example.com')).toBe(AUTH_LOGIN_PATH);
  });

  it('returnTo 为协议相对 // URL → 丢弃,回裸登录路径', () => {
    expect(loginUrl('//evil.example.com/phish')).toBe(AUTH_LOGIN_PATH);
  });

  it('returnTo 非 / 开头(相对片段)→ 丢弃,回裸登录路径', () => {
    expect(loginUrl('tasks/01982e62')).toBe(AUTH_LOGIN_PATH);
  });

  it.each([
    '/%5cevil.example/phish',
    '/%2f%2fevil.example/phish',
    '/%252f%252fevil.example/phish',
    '/tasks/%0aLocation:https://evil.example',
  ])('多重编码、反斜杠或控制字符 %s 不进入登录 URL', (returnTo) => {
    expect(loginUrl(returnTo)).toBe(AUTH_LOGIN_PATH);
  });

  it('首页/保护页一次跳转直达 OIDC 后端入口，并完整保留 path + query', () => {
    window.history.replaceState({}, '', '/tasks/task-42?tab=logs&from=home');
    const navigate = vi.fn<(url: string) => void>();

    goToLogin(window.location.pathname + window.location.search, navigate);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent('/tasks/task-42?tab=logs&from=home')}`,
    );
  });
});

describe('Preview auth entry', () => {
  it('uses the protected bootstrap and preserves a safe task return', () => {
    const taskReturn = '/tasks/01982e62-6d6e-7f4d-8fe8-b55f62720b5b?tab=history';
    expect(previewBootstrapUrl(taskReturn)).toBe(
      `${PREVIEW_BOOTSTRAP_PATH}?returnTo=${encodeURIComponent(taskReturn)}`,
    );
    expect(authEntryUrl('preview', taskReturn)).toBe(previewBootstrapUrl(taskReturn));
    expect(authEntryUrl('production', taskReturn)).toBe(loginUrl(taskReturn));
  });

  it('drops hostile Preview bootstrap returns', () => {
    expect(previewBootstrapUrl('//evil.example/phish')).toBe(PREVIEW_BOOTSTRAP_PATH);
    expect(previewBootstrapUrl('/%252f%252fevil.example/phish')).toBe(PREVIEW_BOOTSTRAP_PATH);
  });
});

describe('reconcileMeProbe — 已认证会话只被明确 401 撤销', () => {
  const authed = { status: 'authed', me: ME } as const;

  it('短暂 error 保留上一次 authed 身份', () => {
    expect(reconcileMeProbe(authed, { status: 'error' })).toBe(authed);
  });

  it('明确 401/anon 覆盖旧身份，进入重新认证', () => {
    expect(reconcileMeProbe(authed, { status: 'anon' })).toEqual({ status: 'anon' });
  });

  it('初次探针 error 仍是 error，不伪造已登录态', () => {
    expect(reconcileMeProbe(undefined, { status: 'error' })).toEqual({ status: 'error' });
  });
});

function ProtectedProbe(): ReactElement {
  const { status, me, refetch } = useAuth();
  return (
    <div>
      <p>受保护内容</p>
      <output data-testid="auth-session">{`${status}:${me?.account ?? 'none'}`}</output>
      <button type="button" onClick={refetch}>
        刷新登录态
      </button>
    </div>
  );
}

const PREVIEW_METADATA: ReleaseMetadata = {
  schemaVersion: 1,
  environment: 'preview',
  sourceSha: 'a'.repeat(40),
  releaseId: `release-${'a'.repeat(40)}`,
  builtAt: '2026-07-25T00:00:00.000Z',
  releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
  webAssetManifest: `sha256:${'c'.repeat(64)}`,
};

function renderGuard(metadata?: ReleaseMetadata) {
  // 每次新建 QueryClient（retry:false，禁缓存跨用例串味）。
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const guard = (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter>
          <Routes>
            <Route element={<RequireAuth />}>
              <Route path="*" element={<ProtectedProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
  render(
    metadata ? (
      <ReleaseMetadataProvider metadata={metadata}>{guard}</ReleaseMetadataProvider>
    ) : (
      guard
    ),
  );
  return { queryClient: qc };
}

describe('RequireAuth — error 态给「重试」（非「去登录」），不裸露状态码', () => {
  it('503 → 错误闸门：人话 + 「重试」按钮，无「去登录」、无 HTTP/状态码', async () => {
    fm = installFetchMock({ status: 503, json: { error: { userMessage: 'x' } } });
    renderGuard();
    expect(await screen.findByText('暂时无法确认登录状态，请稍后重试。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去登录' })).toBeNull();
    expect(screen.queryByText(/503|500|403/)).toBeNull();
    expect(screen.queryByText('受保护内容')).toBeNull();
  });

  it('「重试」重拉 /me：第二次 200 → 放行受保护内容（非整页跳登录）', async () => {
    fm = installFetchMock([
      { status: 503, json: { error: { userMessage: 'x' } } },
      { status: 200, json: ME_ENVELOPE },
    ]);
    renderGuard();
    await screen.findByText('暂时无法确认登录状态，请稍后重试。');
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('受保护内容')).toBeInTheDocument();
  });

  it('401 → 登录闸门「去登录」（与 error 态分流）', async () => {
    fm = installFetchMock({
      status: 401,
      json: { error: { userMessage: '请先登录' } },
    });
    renderGuard();
    expect(await screen.findByText('请先登录后进入创作者中心。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去登录' })).toBeInTheDocument();
    const gate = screen.getByRole('alert');
    expect(gate.querySelectorAll('.cb-brand-wordmark')).toHaveLength(1);
    expect(gate.querySelector('.cb-brand-mark')).toBeNull();
  });

  it('Preview 的 refresh 凭据失效后只提供受访问闸保护的会话恢复入口', async () => {
    fm = installFetchMock([
      { status: 401, json: { error: { userMessage: '会话已过期' } } },
      { status: 401, json: { error: { userMessage: 'refresh token 已失效' } } },
    ]);
    renderGuard(PREVIEW_METADATA);

    expect(await screen.findByText('预览会话已失效，请恢复后继续。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '恢复预览会话' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去登录' })).toBeNull();
    expect(fm.calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', '/api/v1/me'],
      ['POST', AUTH_REFRESH_PATH],
    ]);
  });

  it('200 + 真实 Envelope<MeView> → 放行 <Outlet/>（authed 用户真能进受保护应用）', async () => {
    // 用后端真实包络形态 { data: ME, meta } 跑通：守卫解包后认定 authed → 渲染 <Outlet/>。
    // 这是本次 P1 回归核心断言：真实登录用户必须能穿过守卫,绝不被错误闸门永久挡住。
    fm = installFetchMock({ status: 200, json: ME_ENVELOPE });
    renderGuard();
    expect(await screen.findByText('受保护内容')).toBeInTheDocument();
    // 反向确认：没有错误闸门、没有登录闸门。
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.queryByRole('button', { name: '去登录' })).toBeNull();
  });

  it('已登录后 /me 短暂 503：保留内容与账号，不切到错误/重新登录闸门', async () => {
    fm = installFetchMock([
      { status: 200, json: ME_ENVELOPE },
      { status: 503, json: { error: { userMessage: '服务短暂不可用' } } },
    ]);
    const { queryClient } = renderGuard();
    expect(await screen.findByTestId('auth-session')).toHaveTextContent('authed:Wayne');

    await userEvent.click(screen.getByRole('button', { name: '刷新登录态' }));
    await waitFor(() => {
      expect(fm?.calls).toHaveLength(2);
      expect(queryClient.getQueryState(['me'])?.fetchStatus).toBe('idle');
    });

    expect(screen.getByTestId('auth-session')).toHaveTextContent('authed:Wayne');
    expect(screen.getByText('受保护内容')).toBeInTheDocument();
    expect(screen.queryByText('暂时无法确认登录状态，请稍后重试。')).toBeNull();
    expect(screen.queryByRole('button', { name: '去登录' })).toBeNull();
  });

  it('已登录后 /me 401 且 refresh 503：保留旧身份，不被上游短暂故障踢出', async () => {
    fm = installFetchMock([
      { status: 200, json: ME_ENVELOPE },
      { status: 401, json: { error: { userMessage: 'access token 已过期' } } },
      { status: 503, json: { error: { userMessage: 'Logto 暂时不可用' } } },
    ]);
    const { queryClient } = renderGuard();
    expect(await screen.findByTestId('auth-session')).toHaveTextContent('authed:Wayne');

    await userEvent.click(screen.getByRole('button', { name: '刷新登录态' }));
    await waitFor(() => {
      expect(fm?.calls).toHaveLength(3);
      expect(queryClient.getQueryState(['me'])?.fetchStatus).toBe('idle');
    });

    expect(screen.getByTestId('auth-session')).toHaveTextContent('authed:Wayne');
    expect(screen.getByText('受保护内容')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去登录' })).toBeNull();
  });

  it('已登录后 /me 明确 401：清空旧身份并进入重新认证', async () => {
    fm = installFetchMock([
      { status: 200, json: ME_ENVELOPE },
      { status: 401, json: { error: { userMessage: '会话已过期' } } },
      { status: 401, json: { error: { userMessage: 'refresh token 已失效' } } },
    ]);
    const { queryClient } = renderGuard();
    expect(await screen.findByTestId('auth-session')).toHaveTextContent('authed:Wayne');

    await userEvent.click(screen.getByRole('button', { name: '刷新登录态' }));
    await waitFor(() => {
      expect(fm?.calls).toHaveLength(3);
      expect(queryClient.getQueryState(['me'])?.fetchStatus).toBe('idle');
      expect(queryClient.getQueryData(['me'])).toEqual({ status: 'anon' });
    });

    expect(await screen.findByText('请先登录后进入创作者中心。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去登录' })).toBeInTheDocument();
    expect(screen.queryByText('受保护内容')).toBeNull();
  });
});
