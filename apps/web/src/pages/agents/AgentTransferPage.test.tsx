import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderPage } from '../../test/renderWithProviders.js';
import { AgentTransferPage } from './AgentTransferPage.js';
import type { AgentTransferView, TransferPhase } from '../../api/agentPackages.js';
vi.mock('../../shell/auth.js', () => ({ useAuth: () => ({ me: { id: 'synthetic-owner' } }) }));

const ID = '11111111-1111-4111-8111-111111111111';
const RELEASE = `release.agent-package.${'a'.repeat(32)}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const FINGERPRINT = `sha256:${'c'.repeat(64)}`;
const shareUrl = `${window.location.origin}/agents/${RELEASE}`;
const fetcher = vi.fn<typeof fetch>();
function view(phase: TransferPhase, expired = false): AgentTransferView {
  const result: AgentTransferView = {
    name: 'method-agent',
    draftFingerprint: FINGERPRINT,
    packageDigest: DIGEST,
    transfer: {
      protocol: 'combo.agent-transfer/1',
      transferId: ID,
      phase,
      approvalUrl: `${window.location.origin}/agent-transfers/${ID}`,
      verificationCode: 'AB12CD34',
      expiresAt: new Date(Date.now() + (expired ? -60_000 : 600_000)).toISOString(),
    },
  };
  if (phase === 'uploaded' || phase === 'published') {
    result.transfer.saved = {
      draftId: 'draft-id',
      revision: 1,
      draftFingerprint: FINGERPRINT,
      packageDigest: DIGEST,
    };
    result.review = {
      manifestText: JSON.stringify({
        protocol: 'combo.agent-package/1',
        name: 'method-agent',
        description: '方法',
      }),
      packageDigest: DIGEST,
      files: [
        { path: 'AGENT.md', text: '# 可复用 Agent\n<img src="x" onerror="steal()">' },
        { path: 'skills/method/SKILL.md', text: '# Method\n核对证据再回答' },
      ],
    };
  }
  if (phase === 'published')
    result.transfer.release = {
      releaseId: RELEASE,
      packageDigest: DIGEST,
      shareUrl,
      acquirePrompt: '获取后核对摘要，在当前任务中使用；尚未安装或运行。',
    };
  return result;
}
function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: {} }), { status });
}
function mount(id = ID) {
  return renderPage(<AgentTransferPage />, {
    route: `/agent-transfers/${id}`,
    path: '/agent-transfers/:transferId',
  });
}
const posts = () => fetcher.mock.calls.filter((call) => call[1]?.method === 'POST');
beforeEach(() => {
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Agent transfer explicit approval and publication', () => {
  it('preserves a leading-zero code and refuses submission if it expires after entry', async () => {
    const pending = view('pending_approval');
    pending.transfer.verificationCode = '00AB1234';
    fetcher.mockResolvedValue(response(pending));
    const user = userEvent.setup();
    mount();
    await user.type(await screen.findByLabelText('原对话中的 8 位确认码'), '00ab1234');
    expect(screen.getByLabelText('原对话中的 8 位确认码')).toHaveValue('00AB1234');
    const approve = screen.getByRole('button', { name: '确认并允许保存' });
    expect(approve).toBeEnabled();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(pending.transfer.expiresAt) + 1);
    await user.click(approve);
    expect(posts()).toHaveLength(0);
  });
  it('prepares and cancels sharing locally with fresh consent and focus on review return', async () => {
    fetcher.mockResolvedValue(response(view('uploaded')));
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: '准备分享' }));
    await user.click(screen.getByRole('button', { name: '检查完整内容' }));
    expect(screen.getByText(/<img src="x"/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回 Agent' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '检查完整内容' })).toHaveFocus());
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '暂不公开' }));
    expect(screen.getByRole('heading', { name: '先留给自己。' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '准备分享' }));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(posts()).toHaveLength(0);
  });
  it.each(['pending_approval', 'uploaded'] as const)(
    'locks unknown %s mutations through failed refresh and only unlocks after a successful GET',
    async (phase) => {
      const original = view(phase);
      fetcher
        .mockResolvedValueOnce(response(original))
        .mockRejectedValueOnce(new TypeError('lost after commit'))
        .mockRejectedValueOnce(new TypeError('still offline'))
        .mockResolvedValueOnce(response(original));
      const user = userEvent.setup();
      mount();
      const approve = phase === 'pending_approval';
      if (approve)
        await user.type(await screen.findByLabelText('原对话中的 8 位确认码'), 'AB12CD34');
      else {
        await user.click(await screen.findByRole('button', { name: '准备分享' }));
        await user.click(screen.getByRole('checkbox'));
      }
      const label = approve ? '确认并允许保存' : '确认公开';
      await user.click(screen.getByRole('button', { name: label }));
      await screen.findByText(/结果未知不代表失败/u);
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: label }));
      expect(posts()).toHaveLength(1);
      await user.click(screen.getByRole('button', { name: '刷新状态' }));
      expect(
        await screen.findByText('上次操作的结果仍未知。先成功查询状态，再继续。'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: label })).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(posts()).toHaveLength(1);
      await user.click(screen.getByRole('button', { name: '刷新状态' }));
      await screen.findByRole('button', { name: label });
      expect(screen.queryByText(/结果未知不代表失败/u)).toBeNull();
      if (!approve) {
        expect(screen.getByRole('checkbox')).not.toBeChecked();
        expect(screen.getByRole('button', { name: label })).toBeDisabled();
      }
      expect(posts()).toHaveLength(1);
    },
  );
  it('only polls an approved request and observes upload without sending another operation', async () => {
    fetcher
      .mockResolvedValueOnce(response(view('approved')))
      .mockResolvedValueOnce(response(view('uploaded')));
    mount();
    expect(await screen.findByRole('heading', { name: '已允许保存。' })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: '先留给自己。' }, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(posts()).toHaveLength(0);
  });
  it('does nothing on GET and sends only approval after the user matches the Codex code', async () => {
    fetcher
      .mockResolvedValueOnce(response(view('pending_approval')))
      .mockResolvedValueOnce(response(view('approved').transfer));
    const user = userEvent.setup();
    mount();
    const approve = await screen.findByRole('button', { name: '确认并允许保存' });
    expect(approve).toBeDisabled();
    expect(posts()).toHaveLength(0);
    await user.type(screen.getByLabelText('原对话中的 8 位确认码'), 'BAD00000');
    expect(approve).toBeDisabled();
    await user.clear(screen.getByLabelText('原对话中的 8 位确认码'));
    await user.type(screen.getByLabelText('原对话中的 8 位确认码'), 'ab12cd34');
    await user.click(approve);
    expect(await screen.findByRole('heading', { name: '已允许保存。' })).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.[0]).toBe(`/api/v1/agent-package-transfers/${ID}/approval`);
    expect(JSON.parse(posts()[0]?.[1]?.body as string)).toEqual({
      decision: 'approve',
      verificationCode: 'AB12CD34',
      draftFingerprint: FINGERPRINT,
      packageDigest: DIGEST,
    });
    expect(screen.queryByRole('button', { name: '确认公开' })).toBeNull();
  });
  it('requires an explicit matched-code rejection and ends the request', async () => {
    fetcher
      .mockResolvedValueOnce(response(view('pending_approval')))
      .mockResolvedValueOnce(response(view('rejected').transfer));
    const user = userEvent.setup();
    mount();
    await user.type(await screen.findByLabelText('原对话中的 8 位确认码'), 'AB12CD34');
    await user.click(screen.getByText('核对版本与请求'));
    await user.click(screen.getByRole('button', { name: '拒绝此次上传' }));
    expect(await screen.findByRole('heading', { name: '已拒绝此次保存。' })).toBeInTheDocument();
    expect(JSON.parse(posts()[0]?.[1]?.body as string).decision).toBe('reject');
  });
  it('cannot approve an expired request', async () => {
    fetcher.mockResolvedValue(response(view('pending_approval', true)));
    mount();
    expect(await screen.findByRole('button', { name: '确认并允许保存' })).toBeDisabled();
    expect(screen.getByText('确认码已过期。请回到原对话重新发起保存。')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it('shows exact plain text and keeps publication separate from refresh even after upload TTL', async () => {
    const uploaded = view('uploaded', true);
    fetcher.mockImplementation(async () => response(uploaded));
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: '查看完整方法' }));
    expect(screen.getByText(/<img src="x" onerror="steal\(\)">/u)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    await user.click(screen.getByRole('button', { name: '返回 Agent' }));
    await user.click(screen.getByRole('button', { name: '准备分享' }));
    expect(screen.getByRole('button', { name: '确认公开' })).toBeDisabled();
    expect(screen.getByText('来源未核验')).toBeInTheDocument();
    expect(screen.getByText('覆盖可能不完整')).toBeInTheDocument();
    expect(screen.getByText('尚未试运行')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(posts()).toHaveLength(0);
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: '确认公开' })).toBeEnabled();
  });
  it('reuses the persisted publication request after a lost response and page remount', async () => {
    fetcher
      .mockResolvedValueOnce(response(view('uploaded')))
      .mockRejectedValueOnce(new TypeError('lost after commit'));
    const user = userEvent.setup();
    const first = mount();
    await user.click(await screen.findByRole('button', { name: '准备分享' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '确认公开' }));
    expect(await screen.findByText(/结果未知不代表失败/u)).toBeInTheDocument();
    const firstBody = JSON.parse(posts()[0]?.[1]?.body as string);
    first.unmount();
    fetcher
      .mockResolvedValueOnce(response(view('uploaded')))
      .mockResolvedValueOnce(response(view('published').transfer));
    mount();
    await user.click(await screen.findByRole('button', { name: '准备分享' }));
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();
    expect(posts()).toHaveLength(1);
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: '确认公开' }));
    expect(await screen.findByRole('heading', { name: '现在，可以分享了。' })).toBeInTheDocument();
    expect(JSON.parse(posts()[1]?.[1]?.body as string)).toEqual(firstBody);
    expect(firstBody).toMatchObject({
      draftFingerprint: FINGERPRINT,
      packageDigest: DIGEST,
      confirmPublic: true,
    });
    expect(screen.getByRole('link', { name: shareUrl })).toHaveAttribute('href', shareUrl);
  });
  it('refreshes a committed unknown result without a second publication POST', async () => {
    fetcher
      .mockResolvedValueOnce(response(view('uploaded')))
      .mockRejectedValueOnce(new Error('lost'))
      .mockResolvedValueOnce(response(view('published')));
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: '准备分享' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '确认公开' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(await screen.findByRole('heading', { name: '现在，可以分享了。' })).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
  });
  it('rejects a published response for another exact pair without showing a success card or link', async () => {
    const wrong = view('published').transfer;
    wrong.saved = {
      ...wrong.saved!,
      draftFingerprint: `sha256:${'e'.repeat(64)}`,
      packageDigest: `sha256:${'d'.repeat(64)}`,
    };
    wrong.release = { ...wrong.release!, packageDigest: `sha256:${'d'.repeat(64)}` };
    fetcher
      .mockResolvedValueOnce(response(view('uploaded')))
      .mockResolvedValueOnce(response(wrong));
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: '准备分享' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '确认公开' }));
    expect(await screen.findByText(/结果未知不代表失败/u)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '现在，可以分享了。' })).toBeNull();
    expect(screen.queryByRole('link', { name: shareUrl })).toBeNull();
    expect(screen.getByText(DIGEST)).toBeInTheDocument();
    expect(screen.queryByText(wrong.saved.packageDigest)).toBeNull();
  });
  it('does not send publication when safe request storage is unavailable', async () => {
    fetcher.mockResolvedValue(response(view('uploaded')));
    const setItem = vi
      .spyOn(Object.getPrototypeOf(sessionStorage) as Storage, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });
    expect(sessionStorage.setItem).toBe(setItem);
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: '准备分享' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '确认公开' }));
    expect(await screen.findByText(/因此尚未发送/u)).toBeInTheDocument();
    expect(setItem).toHaveBeenCalledOnce();
    expect(posts()).toHaveLength(0);
  });
  it.each(['pending_approval', 'uploaded'] as const)(
    'invalidates old confirmation when a refresh changes the immutable pair in %s',
    async (phase) => {
      const changed = view(phase);
      changed.draftFingerprint = `sha256:${'e'.repeat(64)}`;
      if (changed.transfer.saved)
        changed.transfer.saved.draftFingerprint = changed.draftFingerprint;
      fetcher.mockResolvedValueOnce(response(view(phase))).mockResolvedValueOnce(response(changed));
      const user = userEvent.setup();
      mount();
      if (phase === 'uploaded') {
        await user.click(await screen.findByRole('button', { name: '准备分享' }));
        await user.click(screen.getByRole('checkbox'));
      } else await user.type(await screen.findByLabelText('原对话中的 8 位确认码'), 'AB12CD34');
      const label = phase === 'uploaded' ? '确认公开' : '确认并允许保存';
      expect(screen.getByRole('button', { name: label })).toBeEnabled();
      await user.click(screen.getByRole('button', { name: '刷新状态' }));
      await screen.findByText(changed.draftFingerprint);
      if (phase === 'uploaded') {
        expect(screen.queryByRole('checkbox')).toBeNull();
        await user.click(screen.getByRole('button', { name: '准备分享' }));
        expect(screen.getByRole('button', { name: label })).toBeDisabled();
        expect(screen.getByRole('checkbox')).not.toBeChecked();
      } else {
        expect(screen.getByRole('button', { name: label })).toBeDisabled();
        expect(screen.getByLabelText('原对话中的 8 位确认码')).toHaveValue('');
      }
      expect(posts()).toHaveLength(0);
    },
  );
  it('deduplicates rapid clicks while publication is in flight', async () => {
    let finish: (value: Response) => void = () => {};
    fetcher.mockResolvedValueOnce(response(view('uploaded'))).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: '准备分享' }));
    await user.click(screen.getByRole('checkbox'));
    await user.dblClick(screen.getByRole('button', { name: '确认公开' }));
    expect(posts()).toHaveLength(1);
    finish(response(view('published').transfer));
    expect(await screen.findByRole('heading', { name: '现在，可以分享了。' })).toBeInTheDocument();
  });
  it.each([404, 503])('shows safe HTTP %s without enabling actions', async (status) => {
    fetcher.mockResolvedValue(response({ secret: 'private-details' }, status));
    mount();
    expect(await screen.findByRole('alert')).not.toHaveTextContent('private-details');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(posts()).toHaveLength(0);
  });
  it('rejects malformed transfer links locally', () => {
    mount('invalid');
    expect(screen.getByRole('heading', { name: '这个上传链接不正确' })).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
