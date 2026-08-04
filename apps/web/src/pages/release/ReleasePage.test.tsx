import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { envelopeBody, makeCapability } from '../../test/fixtures.js';
import { installFetchMock, type FetchMock, type MockResponseSpec } from '../../test/mockFetch.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { emptyReleaseDraft, readReleaseDraft, saveReleaseDraft } from './releaseDraft.js';
import { ReleasePage } from './ReleasePage.js';

let fm: FetchMock | undefined;
const CAPABILITY_ID = '01982e62-6d6e-7f4d-8fe8-b55f62720b5b';
const capability = makeCapability({
  id: CAPABILITY_ID,
  name: '场合穿搭顾问',
  summary: '根据场景、天气与个人偏好给出穿搭建议。',
});

afterEach(() => {
  fm?.restore();
  fm = undefined;
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderRelease(step = 'pricing', navigateToStudio?: (url: string) => void) {
  return renderPage(<ReleasePage navigateToStudio={navigateToStudio} />, {
    route: `/capabilities/${CAPABILITY_ID}/release/${step}`,
    path: '/capabilities/:capabilityId/release/:step',
  });
}

describe('Agent release flow', () => {
  it('walks pricing → naming → real publish → success without hiding the Mixed boundary', async () => {
    fm = installFetchMock([
      {
        status: 200,
        json: envelopeBody(capability),
        match: `/capabilities/${CAPABILITY_ID}`,
      },
      {
        status: 200,
        json: envelopeBody({
          id: CAPABILITY_ID,
          published: true,
          publishedAt: '2026-08-03T08:00:00.000Z',
          shareToken: 'share-style',
        }),
        match: `/capabilities/${CAPABILITY_ID}/publish`,
      },
    ]);
    const user = userEvent.setup();
    renderRelease();

    expect(await screen.findByText('体验说明')).toBeInTheDocument();
    expect(screen.getByText(/定价和自定义域名目前只保存在这台设备/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /单次定价/ }));
    await user.type(screen.getByRole('spinbutton', { name: '每次使用价格' }), '9.9');
    await user.click(screen.getByRole('button', { name: /下一步：命名/ }));

    expect(
      await screen.findByRole('heading', { name: '给 Agent 一个容易分享的名字' }),
    ).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: '自定义子域名' }), 'style-helper');
    await user.click(screen.getByRole('button', { name: /下一步：确认发布/ }));

    expect(
      await screen.findByRole('heading', { name: '确认后开放 Agent 试用' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /定价与域名仍只是本机草稿/ }));
    await user.click(screen.getByRole('button', { name: '开放试用并保存草稿 →' }));

    expect(
      await screen.findByRole('heading', { name: 'Agent 已开放试用，可以继续迭代' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('/try/c/01982e62-6d6e-7f4d-8fe8-b55f62720b5b', { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByText(/style-helper\.buildwithcombo\.com · 尚未注册/)).toBeInTheDocument();
    expect(
      fm.calls.find((call) => call.url.endsWith(`/capabilities/${CAPABILITY_ID}/publish`))?.method,
    ).toBe('POST');
    expect(readReleaseDraft(CAPABILITY_ID)).toMatchObject({
      pricingModel: 'per-use',
      priceYuan: 9.9,
      handle: 'style-helper',
      confirmed: true,
    });
  });

  it('opens Studio with a strict return to the current release step', async () => {
    const navigateToStudio = vi.fn();
    fm = installFetchMock([
      { status: 200, json: envelopeBody(capability), match: `/capabilities/${CAPABILITY_ID}` },
      {
        status: 201,
        json: envelopeBody({ session: { id: 'studio-1' } }),
        match: '/runtime/studio/sessions',
      },
    ]);
    saveReleaseDraft({
      ...emptyReleaseDraft(CAPABILITY_ID, capability.name),
      pricingModel: 'per-use',
      priceYuan: 9.9,
      handle: 'style-helper',
      currentStep: 'review',
    });
    renderRelease('review', navigateToStudio);
    await userEvent.click(await screen.findByRole('button', { name: '继续调整 UI' }));

    await waitFor(() => expect(navigateToStudio).toHaveBeenCalledOnce());
    expect(navigateToStudio).toHaveBeenCalledWith(
      `/try/session/studio-1?mode=studio&returnTo=${encodeURIComponent(
        `/capabilities/${CAPABILITY_ID}/release/review`,
      )}`,
    );
  });

  it('never presents an unconfirmed browser draft as a published success', async () => {
    fm = installFetchMock({
      status: 200,
      json: envelopeBody(capability),
      match: `/capabilities/${CAPABILITY_ID}`,
    });
    renderRelease('success');
    expect(
      await screen.findByRole('heading', { name: '你的设置还在，不需要重新填写' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Agent 已开放试用，可以继续迭代')).toBeNull();
  });

  it('keeps a failed publish on review and never confirms the local draft', async () => {
    fm = installFetchMock([
      {
        status: 200,
        json: envelopeBody(capability),
        match: `/capabilities/${CAPABILITY_ID}`,
      },
      {
        status: 503,
        json: { error: { code: 'SERVICE_UNAVAILABLE', message: '发布服务暂时不可用' } },
        match: `/capabilities/${CAPABILITY_ID}/publish`,
      },
    ]);
    saveReleaseDraft({
      ...emptyReleaseDraft(CAPABILITY_ID, capability.name),
      pricingModel: 'per-use',
      priceYuan: 9.9,
      handle: 'style-helper',
      currentStep: 'review',
    });
    const user = userEvent.setup();
    renderRelease('review');

    await user.click(await screen.findByRole('checkbox', { name: /定价与域名仍只是本机草稿/ }));
    await user.click(screen.getByRole('button', { name: '开放试用并保存草稿 →' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '确认后开放 Agent 试用' })).toBeInTheDocument();
    expect(screen.queryByText('Agent 已开放试用，可以继续迭代')).toBeNull();
    expect(readReleaseDraft(CAPABILITY_ID).confirmed).toBe(false);
  });

  it('saves the completed draft before calling the publish API', async () => {
    let resolvePublish!: (spec: MockResponseSpec) => void;
    const deferred = new Promise<MockResponseSpec>((resolve) => {
      resolvePublish = resolve;
    });
    fm = installFetchMock([
      {
        status: 200,
        json: envelopeBody(capability),
        match: `/capabilities/${CAPABILITY_ID}`,
      },
      {
        deferred,
        match: `/capabilities/${CAPABILITY_ID}/publish`,
      },
    ]);
    saveReleaseDraft({
      ...emptyReleaseDraft(CAPABILITY_ID, capability.name),
      pricingModel: 'per-use',
      priceYuan: 9.9,
      handle: 'style-helper',
      currentStep: 'review',
    });
    const user = userEvent.setup();
    renderRelease('review');

    await user.click(await screen.findByRole('checkbox', { name: /定价与域名仍只是本机草稿/ }));
    await user.click(screen.getByRole('button', { name: '开放试用并保存草稿 →' }));

    await waitFor(() => expect(fm?.calls.some((call) => call.url.endsWith('/publish'))).toBe(true));
    expect(readReleaseDraft(CAPABILITY_ID)).toMatchObject({
      currentStep: 'success',
      confirmed: true,
    });

    resolvePublish({
      status: 200,
      json: envelopeBody({
        id: CAPABILITY_ID,
        published: true,
        publishedAt: '2026-08-03T08:00:00.000Z',
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Agent 已开放试用，可以继续迭代' }),
    ).toBeInTheDocument();
  });

  it('redirects an incomplete review deep-link to the earliest missing step', async () => {
    fm = installFetchMock({
      status: 200,
      json: envelopeBody(capability),
      match: `/capabilities/${CAPABILITY_ID}`,
    });
    renderRelease('review');

    expect(
      await screen.findByRole('heading', { name: '这个 Agent 如何收费？' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '确认后开放 Agent 试用' })).toBeNull();
  });

  it('在本机草稿无法保存时不调用真实发布', async () => {
    fm = installFetchMock({
      status: 200,
      json: envelopeBody(capability),
      match: `/capabilities/${CAPABILITY_ID}`,
    });
    saveReleaseDraft({
      ...emptyReleaseDraft(CAPABILITY_ID, capability.name),
      pricingModel: 'per-use',
      priceYuan: 9.9,
      handle: 'style-helper',
      currentStep: 'review',
    });
    const user = userEvent.setup();
    renderRelease('review');
    await screen.findByRole('heading', { name: '确认后开放 Agent 试用' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    await user.click(screen.getByRole('checkbox', { name: /定价与域名仍只是本机草稿/ }));
    await user.click(screen.getByRole('button', { name: '开放试用并保存草稿 →' }));

    expect(await screen.findByText(/没有保存成功/)).toBeInTheDocument();
    expect(fm.calls.some((call) => call.url.endsWith('/publish'))).toBe(false);
  });

  it('已发布 Agent 显示管理语义，并可真实暂停公开试用', async () => {
    const publishedCapability = makeCapability({
      ...capability,
      published: true,
      publishedAt: '2026-08-03T08:00:00.000Z',
    });
    fm = installFetchMock([
      {
        status: 200,
        json: envelopeBody(publishedCapability),
        match: `/capabilities/${CAPABILITY_ID}`,
      },
      {
        status: 200,
        json: envelopeBody({ id: CAPABILITY_ID, published: false }),
        match: `/capabilities/${CAPABILITY_ID}/unpublish`,
      },
      {
        status: 200,
        json: envelopeBody({
          id: CAPABILITY_ID,
          published: true,
          publishedAt: '2026-08-03T09:00:00.000Z',
        }),
        match: `/capabilities/${CAPABILITY_ID}/publish`,
      },
    ]);
    saveReleaseDraft({
      ...emptyReleaseDraft(CAPABILITY_ID, capability.name),
      pricingModel: 'per-use',
      priceYuan: 9.9,
      handle: 'style-helper',
      currentStep: 'success',
      confirmed: true,
    });
    const user = userEvent.setup();
    renderRelease('success');

    await user.click(await screen.findByRole('button', { name: '暂停公开试用' }));

    expect(
      await screen.findByText('公开试用已暂停。定价和命名草稿已保留，修改后可以再次开放。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '确认后开放 Agent 试用' })).toBeInTheDocument();
    expect(readReleaseDraft(CAPABILITY_ID)).toMatchObject({
      currentStep: 'review',
      confirmed: false,
    });
    expect(
      fm.calls.find((call) => call.url.endsWith(`/capabilities/${CAPABILITY_ID}/unpublish`))
        ?.method,
    ).toBe('POST');

    await user.click(screen.getByRole('checkbox', { name: /定价与域名仍只是本机草稿/ }));
    await user.click(screen.getByRole('button', { name: '开放试用并保存草稿 →' }));

    expect(
      await screen.findByRole('heading', { name: 'Agent 已开放试用，可以继续迭代' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('公开试用已暂停。定价和命名草稿已保留，修改后可以再次开放。'),
    ).toBeNull();
  });

  it('已发布 Agent 只保存设置，不把管理动作描述成首次开放', async () => {
    const publishedCapability = makeCapability({
      ...capability,
      published: true,
      publishedAt: '2026-08-03T08:00:00.000Z',
    });
    fm = installFetchMock({
      status: 200,
      json: envelopeBody(publishedCapability),
      match: `/capabilities/${CAPABILITY_ID}`,
    });
    saveReleaseDraft({
      ...emptyReleaseDraft(CAPABILITY_ID, capability.name),
      pricingModel: 'per-use',
      priceYuan: 9.9,
      handle: 'style-helper',
      currentStep: 'review',
    });
    const user = userEvent.setup();
    renderRelease('review');

    expect(await screen.findByRole('heading', { name: '检查并保存发布设置' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /我确认只保存这台设备上的/ }));
    await user.click(screen.getByRole('button', { name: '保存发布草稿 →' }));

    expect(await screen.findByRole('heading', { name: '发布设置已保存' })).toBeInTheDocument();
    expect(screen.getByText(/Agent 继续保持开放/)).toBeInTheDocument();
    expect(screen.queryByText('Agent 已开放试用，可以继续迭代')).toBeNull();
    expect(fm.calls.some((call) => call.url.endsWith('/publish'))).toBe(false);
    expect(
      fm.calls.filter((call) => call.url.endsWith(`/capabilities/${CAPABILITY_ID}`)),
    ).toHaveLength(2);
  });

  it('已发布缓存过期时以服务端状态为准并执行真实发布', async () => {
    const cachedPublished = makeCapability({
      ...capability,
      published: true,
      publishedAt: '2026-08-03T08:00:00.000Z',
    });
    const refreshedUnpublished = makeCapability({
      ...capability,
      published: false,
    });
    fm = installFetchMock([
      {
        status: 200,
        json: envelopeBody(cachedPublished),
        match: `/capabilities/${CAPABILITY_ID}`,
      },
      {
        status: 200,
        json: envelopeBody(refreshedUnpublished),
        match: `/capabilities/${CAPABILITY_ID}`,
      },
      {
        status: 200,
        json: envelopeBody({
          id: CAPABILITY_ID,
          published: true,
          publishedAt: '2026-08-03T09:00:00.000Z',
        }),
        match: `/capabilities/${CAPABILITY_ID}/publish`,
      },
    ]);
    saveReleaseDraft({
      ...emptyReleaseDraft(CAPABILITY_ID, capability.name),
      pricingModel: 'per-use',
      priceYuan: 9.9,
      handle: 'style-helper',
      currentStep: 'review',
    });
    const user = userEvent.setup();
    renderRelease('review');

    await user.click(await screen.findByRole('checkbox', { name: /我确认只保存这台设备上的/ }));
    await user.click(screen.getByRole('button', { name: '保存发布草稿 →' }));

    expect(
      await screen.findByRole('heading', { name: 'Agent 已开放试用，可以继续迭代' }),
    ).toBeInTheDocument();
    expect(
      fm.calls.find((call) => call.url.endsWith(`/capabilities/${CAPABILITY_ID}/publish`))?.method,
    ).toBe('POST');
  });

  it('无法向服务端确认已发布状态时留在确认页且不保存成功态', async () => {
    const cachedPublished = makeCapability({
      ...capability,
      published: true,
      publishedAt: '2026-08-03T08:00:00.000Z',
    });
    fm = installFetchMock([
      {
        status: 200,
        json: envelopeBody(cachedPublished),
        match: `/capabilities/${CAPABILITY_ID}`,
      },
      {
        status: 503,
        json: { error: { code: 'SERVICE_UNAVAILABLE', message: '状态服务暂时不可用' } },
        match: `/capabilities/${CAPABILITY_ID}`,
      },
    ]);
    saveReleaseDraft({
      ...emptyReleaseDraft(CAPABILITY_ID, capability.name),
      pricingModel: 'per-use',
      priceYuan: 9.9,
      handle: 'style-helper',
      currentStep: 'review',
    });
    const user = userEvent.setup();
    renderRelease('review');

    await user.click(await screen.findByRole('checkbox', { name: /我确认只保存这台设备上的/ }));
    await user.click(screen.getByRole('button', { name: '保存发布草稿 →' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/暂时无法确认 Agent 的公开状态/);
    expect(screen.getByRole('heading', { name: '检查并保存发布设置' })).toBeInTheDocument();
    expect(readReleaseDraft(CAPABILITY_ID).confirmed).toBe(false);
    expect(fm.calls.some((call) => call.url.endsWith('/publish'))).toBe(false);
  });

  it('暂停公开试用失败时在完成页显示可见错误', async () => {
    const publishedCapability = makeCapability({
      ...capability,
      published: true,
      publishedAt: '2026-08-03T08:00:00.000Z',
    });
    fm = installFetchMock([
      {
        status: 200,
        json: envelopeBody(publishedCapability),
        match: `/capabilities/${CAPABILITY_ID}`,
      },
      {
        status: 503,
        json: { error: { code: 'SERVICE_UNAVAILABLE', message: '暂停服务暂时不可用' } },
        match: `/capabilities/${CAPABILITY_ID}/unpublish`,
      },
    ]);
    saveReleaseDraft({
      ...emptyReleaseDraft(CAPABILITY_ID, capability.name),
      pricingModel: 'per-use',
      priceYuan: 9.9,
      handle: 'style-helper',
      currentStep: 'success',
      confirmed: true,
    });
    renderRelease('success');

    await userEvent.click(await screen.findByRole('button', { name: '暂停公开试用' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('服务开小差了，请稍后重试。');
    expect(
      screen.getByRole('heading', { name: 'Agent 已开放试用，可以继续迭代' }),
    ).toBeInTheDocument();
  });
});
