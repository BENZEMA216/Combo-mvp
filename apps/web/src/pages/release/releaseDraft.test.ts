import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyReleaseDraft,
  isPricingComplete,
  isValidReleaseHandle,
  pricingLabel,
  readReleaseDraft,
  releaseDraftStorageKey,
  releasePath,
  saveReleaseDraft,
} from './releaseDraft.js';

afterEach(() => localStorage.clear());

describe('Agent release draft', () => {
  it('isolates drafts by capability and restores a complete pricing choice', () => {
    const first = {
      ...emptyReleaseDraft('cap-1', '周报助手'),
      pricingModel: 'time-pass' as const,
      priceYuan: 29,
      durationDays: 30 as const,
      handle: 'weekly-agent',
    };
    const second = { ...emptyReleaseDraft('cap-2', '设计助手'), priceYuan: 99 };
    expect(saveReleaseDraft(first)).toBe(true);
    expect(saveReleaseDraft(second)).toBe(true);

    expect(releaseDraftStorageKey('cap-1')).not.toBe(releaseDraftStorageKey('cap-2'));
    expect(readReleaseDraft('cap-1')).toMatchObject({
      agentName: '周报助手',
      pricingModel: 'time-pass',
      priceYuan: 29,
      durationDays: 30,
      handle: 'weekly-agent',
    });
    expect(pricingLabel(first)).toBe('30 天访问 · ¥29.00');
    expect(isPricingComplete(first)).toBe(true);
  });

  it('rejects malformed stored values and invalid public handles', () => {
    localStorage.setItem(releaseDraftStorageKey('cap-1'), '{not-json');
    expect(readReleaseDraft('cap-1', '安全名称')).toMatchObject({
      capabilityId: 'cap-1',
      agentName: '安全名称',
      confirmed: false,
    });
    expect(isValidReleaseHandle('style-helper')).toBe(true);
    expect(isValidReleaseHandle('-style')).toBe(false);
    expect(isValidReleaseHandle('UPPER')).toBe(false);
  });

  it('builds one stable, resumable route per step', () => {
    expect(releasePath('cap/a', 'review')).toBe('/capabilities/cap%2Fa/release/review');
  });

  it('rejects pricing values above the UI limits', () => {
    expect(
      isPricingComplete({
        ...emptyReleaseDraft('cap-price', '价格测试'),
        pricingModel: 'per-use',
        priceYuan: 100_000.01,
      }),
    ).toBe(false);
    expect(
      isPricingComplete({
        ...emptyReleaseDraft('cap-margin', '毛利测试'),
        pricingModel: 'cost-plus',
        marginTarget: 96,
      }),
    ).toBe(false);
  });
});
