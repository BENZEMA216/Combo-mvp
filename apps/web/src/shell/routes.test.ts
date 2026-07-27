import { describe, expect, it } from 'vitest';
import { CREATOR_NAV } from './routes.js';

describe('CREATOR_NAV', () => {
  it('keeps the creator journey focused while the market is closed', () => {
    expect(CREATOR_NAV.map(({ label, path }) => ({ label, path }))).toEqual([
      { label: '上传任务', path: '/tasks' },
      { label: '我的 Agent', path: '/capabilities' },
    ]);
    expect(CREATOR_NAV.some((item) => item.path === '/try/market')).toBe(false);
  });
});
