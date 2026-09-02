import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('Desktop current-conversation evidence public boundary', () => {
  it('loads the signed receipt verifier from its production protocol subpath', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "const api = await import('@cb/creator-agent-protocol/desktop-current-conversation-receipt');",
          'console.log([',
          'typeof api.parseDesktopCurrentConversationRunReceipt,',
          'typeof api.verifyDesktopCurrentConversationRunReceipt,',
          'typeof api.digestDesktopCurrentConversationRunReceipt,',
          'Object.hasOwn(api, "signDesktopCurrentConversationRunReceipt"),',
          '].join(":"));',
        ].join(''),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, NODE_DEBUG: 'esm' },
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('function:function:function:false');
    expect(result.stderr).toContain('/dist/desktop-current-conversation-receipt.js');
  });
});
