import { describe, expect, it } from 'vitest';
import { renderConnectScript, renderExpiredScript } from '../modules/task/connect-script.js';

describe('本机导入助手品牌', () => {
  it('active 和 expired 脚本只展示 Combo 品牌', () => {
    const active = renderConnectScript({
      base: 'https://buildwithcombo.com',
      pairingCode: '123456',
    });
    const expired = renderExpiredScript();

    for (const script of [active, expired]) {
      expect(script).toContain('[Combo]');
      expect(script).not.toContain('[Agora]');
    }
    expect(active).toContain('Combo 本机助手');
  });
});
