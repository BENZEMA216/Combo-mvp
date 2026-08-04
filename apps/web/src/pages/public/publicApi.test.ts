import { afterEach, describe, expect, it } from 'vitest';
import { emptyReleaseDraft, saveReleaseDraft } from '../release/releaseDraft.js';
import { fetchLocalReleasePreview } from './publicApi.js';

afterEach(() => localStorage.clear());

describe('local release preview', () => {
  it('projects a complete same-device release draft into a public-page preview', async () => {
    expect(
      saveReleaseDraft({
        ...emptyReleaseDraft('cap-weekly', '周报助手'),
        agentSummary: '把一周的工作素材整理成可直接发送的周报。',
        pricingModel: 'per-use',
        priceYuan: 9.9,
        handle: 'weekly-agent',
        currentStep: 'review',
      }),
    ).toBe(true);

    await expect(fetchLocalReleasePreview('weekly-agent', 'cap-weekly')).resolves.toMatchObject({
      slug: 'weekly-agent',
      name: '周报助手',
      description: '把一周的工作素材整理成可直接发送的周报。',
      localPreview: {
        capabilityId: 'cap-weekly',
        pricing: '单次 ¥9.90',
      },
    });
  });

  it('rejects a slug that does not belong to the stored capability draft', async () => {
    expect(
      saveReleaseDraft({
        ...emptyReleaseDraft('cap-weekly', '周报助手'),
        pricingModel: 'time-pass',
        priceYuan: 29,
        durationDays: 30,
        handle: 'weekly-agent',
      }),
    ).toBe(true);

    await expect(fetchLocalReleasePreview('another-agent', 'cap-weekly')).rejects.toThrow(
      '这台设备上没有找到完整的发布草稿。',
    );
  });
});
