import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderPage } from '../../test/renderWithProviders.js';
import { emptyReleaseDraft, saveReleaseDraft } from '../release/releaseDraft.js';
import { PublicCapabilityPage } from './PublicCapabilityPage.js';

afterEach(() => window.localStorage.clear());

describe('PublicCapabilityPage', () => {
  it('本机发布预览的真实试用入口带回发布完成页，不把用户丢出发布流程', async () => {
    const capabilityId = '018f47ea-bc32-7a3d-8f6e-2f90c7b01d43';
    expect(
      saveReleaseDraft({
        ...emptyReleaseDraft(capabilityId, '周报助手'),
        pricingModel: 'per-use',
        priceYuan: 9.9,
        handle: 'weekly-agent',
        currentStep: 'success',
        confirmed: true,
      }),
    ).toBe(true);

    renderPage(<PublicCapabilityPage />, {
      route: `/a/weekly-agent?preview=${capabilityId}`,
      path: '/a/:slug',
    });

    expect(await screen.findByRole('heading', { name: '周报助手' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '登录后真实试用' })).toHaveAttribute(
      'href',
      `/try/c/${capabilityId}?returnTo=%2Fcapabilities%2F018f47ea-bc32-7a3d-8f6e-2f90c7b01d43%2Frelease%2Fsuccess`,
    );
    expect(screen.getByRole('link', { name: '返回发布结果' })).toHaveAttribute(
      'href',
      `/capabilities/${capabilityId}/release/success`,
    );
  });
});
