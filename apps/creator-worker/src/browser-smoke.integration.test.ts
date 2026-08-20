import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { CreatorWorker } from './creator-worker.js';
import {
  CodexHostError,
  createHostInterruptedTerminalEvidence,
  createHostTurnTerminalEvidence,
  type CodexHost,
  type HostThread,
  type HostTurnHandle,
  type HostTurnResult,
} from './host-types.js';
import { CreatorWorkerHttpServer } from './http-server.js';

const enabled = process.env.COMBO_BROWSER_E2E === '1';
const CHROME_BINARY = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

class BrowserSmokeHost implements CodexHost {
  private nextThread = 1;
  turnCount = 0;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async createThread(): Promise<HostThread> {
    return {
      id: `browser-thread-${this.nextThread++}`,
      generation: 1,
      workspaceRootsAcknowledged: false,
    };
  }

  startTurn(input: { thread: HostThread; text: string }): HostTurnHandle {
    this.turnCount += 1;
    const threadId = input.thread.id;
    const turnId = `browser-turn-${this.turnCount}`;
    let rejectResult: (error: Error) => void = () => undefined;
    let resolveTerminal!: (evidence: ReturnType<typeof createHostTurnTerminalEvidence>) => void;
    const terminal = new Promise<ReturnType<typeof createHostTurnTerminalEvidence>>((resolve) => {
      resolveTerminal = resolve;
    });
    const result =
      input.text === 'hold'
        ? new Promise<HostTurnResult>((_resolve, reject) => {
            rejectResult = reject;
          })
        : Promise.resolve({ text: `reply:${input.text}` });
    if (input.text !== 'hold') {
      resolveTerminal(
        createHostTurnTerminalEvidence({
          threadId,
          turnId,
          outcome: 'SUCCEEDED',
          errorCode: null,
          terminalStatus: 'completed',
          terminalError: 'NONE',
          outputState: 'USABLE',
          completedAt: 0,
        }),
      );
    }
    return {
      turnId: Promise.resolve(turnId),
      result,
      terminal,
      interrupt: async () => {
        rejectResult(new CodexHostError('HOST_INTERRUPTED', 'interrupted', true));
        resolveTerminal(
          createHostTurnTerminalEvidence({
            threadId,
            turnId,
            outcome: 'CANCELLED',
            errorCode: null,
            terminalStatus: 'interrupted',
            terminalError: 'NONE',
            outputState: 'NOT_APPLICABLE',
            completedAt: 0,
          }),
        );
        return createHostInterruptedTerminalEvidence({
          threadId,
          turnId,
          status: 'interrupted',
          error: null,
          completedAt: 0,
        });
      },
    };
  }
}

describe.runIf(enabled)('Creator Worker browser experience', () => {
  it('coalesces initial conversation creation and can continue after Stop', async () => {
    const host = new BrowserSmokeHost();
    const worker = new CreatorWorker({ host, turnTimeoutMs: 5_000 });
    const http = new CreatorWorkerHttpServer({ worker, agentName: 'Browser smoke Agent' });
    const browser = await chromium.launch({ executablePath: CHROME_BINARY, headless: true });

    try {
      await worker.start();
      const address = await http.start();
      const page = await browser.newPage();
      let conversationRequests = 0;
      await page.route('**/api/conversations', async (route) => {
        conversationRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.continue();
      });
      await page.goto(address.experienceUrl);
      await page.locator('#input').fill('hello');
      await page.locator('#composer').evaluate((form) => {
        (form as HTMLFormElement).requestSubmit();
        (form as HTMLFormElement).requestSubmit();
      });
      await expect.poll(() => page.locator('.agent').last().textContent()).toBe('reply:hello');
      expect(conversationRequests).toBe(1);
      expect(host.turnCount).toBe(1);

      await page.locator('#input').fill('hold');
      await page.locator('#composer').evaluate((form) => (form as HTMLFormElement).requestSubmit());
      await expect.poll(() => page.locator('#stop').isVisible()).toBe(true);
      await page.locator('#stop').click();
      await expect
        .poll(() => page.locator('.notice').last().textContent())
        .toContain('这次回答已停止');
      await expect.poll(() => page.locator('#input').isEnabled()).toBe(true);

      await page.locator('#input').fill('after-stop');
      await page.locator('#composer').evaluate((form) => (form as HTMLFormElement).requestSubmit());
      await expect.poll(() => page.locator('.agent').last().textContent()).toBe('reply:after-stop');
      expect(host.turnCount).toBe(3);
    } finally {
      await browser.close();
      await http.stop();
      await worker.stop();
    }
  }, 30_000);
});
