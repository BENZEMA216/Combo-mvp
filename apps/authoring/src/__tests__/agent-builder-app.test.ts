import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_BUILDER_APP_HTML,
  AGENT_BUILDER_APP_HTML_SHA256,
} from '../modules/external-mcp/agent-builder-app.js';

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  private readonly listeners = new Map<string, () => unknown>();

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }

  addEventListener(type: string, listener: () => unknown): void {
    this.listeners.set(type, listener);
  }

  async dispatch(type: string): Promise<void> {
    await this.listeners.get(type)?.();
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function startApp(
  options: {
    actionResponse?: 'success' | 'reject' | 'timeout';
    manualRequestTimeouts?: boolean;
    useCompatibilityMessage?: boolean;
  } = {},
) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(AGENT_BUILDER_APP_HTML)?.[1];
  if (!script) throw new Error('Agent Builder App script is missing.');

  const elements = new Map(
    ['stage', 'title', 'summary', 'progress', 'items', 'actions', 'action-status', 'error'].map(
      (id) => [id, new FakeElement()],
    ),
  );
  const outbound: JsonRpcMessage[] = [];
  const compatibilityMessage = vi.fn(async () => undefined);
  const toolPayload = {
    stage: 'readiness',
    title: 'Combo 已就绪',
    summary: '等待确认分析范围。',
    progress: [{ label: '确认范围', state: 'current' }],
    items: [
      {
        title: '建议 Agent',
        summary: '检查整张卡的 action 锁。',
        action: {
          label: '查看建议',
          message: '请展示这个建议。',
          emphasis: 'secondary',
        },
      },
    ],
    actions: [
      {
        label: '确认范围',
        message: '我确认这个分析范围。',
        emphasis: 'primary',
      },
      {
        label: '调整范围',
        message: '我需要调整分析范围。',
        emphasis: 'secondary',
      },
    ],
  };
  let onMessage: ((event: { source: unknown; data: JsonRpcMessage }) => void) | undefined;
  let nextManualTimeoutId = 1;
  const manualTimeouts = new Map<number, () => void>();

  function appSetTimeout(callback: () => void, delay?: number) {
    if (options.manualRequestTimeouts && delay === 8000) {
      const id = nextManualTimeoutId++;
      manualTimeouts.set(id, callback);
      return id;
    }
    return setTimeout(callback, delay);
  }

  function appClearTimeout(handle: ReturnType<typeof setTimeout> | number) {
    if (typeof handle === 'number' && manualTimeouts.delete(handle)) return;
    clearTimeout(handle);
  }

  const parent = {
    postMessage(message: JsonRpcMessage) {
      outbound.push(message);
      if (message.method === 'ui/initialize' && message.id !== undefined) {
        const requestId = message.id;
        queueMicrotask(() =>
          onMessage?.({
            source: parent,
            data: options.useCompatibilityMessage
              ? {
                  jsonrpc: '2.0',
                  id: requestId,
                  error: { code: -32601, message: 'Method not found' },
                }
              : {
                  jsonrpc: '2.0',
                  id: requestId,
                  result: {
                    protocolVersion: '2026-01-26',
                    hostInfo: { name: 'test-host', version: '1.0.0' },
                    hostCapabilities: {},
                    hostContext: {},
                  },
                },
          }),
        );
      }
      if (message.method === 'ui/notifications/initialized') {
        queueMicrotask(() =>
          onMessage?.({
            source: parent,
            data: {
              jsonrpc: '2.0',
              method: 'ui/notifications/tool-input',
              params: { arguments: { stage: 'readiness' } },
            },
          }),
        );
        queueMicrotask(() =>
          onMessage?.({
            source: parent,
            data: {
              jsonrpc: '2.0',
              method: 'ui/notifications/tool-result',
              params: {
                structuredContent: toolPayload,
              },
            },
          }),
        );
      }
      if (message.method === 'ui/message' && message.id !== undefined) {
        if (options.actionResponse === 'timeout') return;
        const requestId = message.id;
        queueMicrotask(() =>
          onMessage?.({
            source: parent,
            data:
              options.actionResponse === 'reject'
                ? {
                    jsonrpc: '2.0',
                    id: requestId,
                    error: { code: -32600, message: 'Host rejected this action.' },
                  }
                : { jsonrpc: '2.0', id: requestId, result: {} },
          }),
        );
      }
    },
  };
  const windowObject = {
    parent,
    setTimeout: appSetTimeout,
    clearTimeout: appClearTimeout,
    openai: options.useCompatibilityMessage
      ? { toolOutput: toolPayload, sendFollowUpMessage: compatibilityMessage }
      : undefined,
    addEventListener(
      type: string,
      listener: (event: { source: unknown; data: JsonRpcMessage }) => void,
    ) {
      if (type === 'message') onMessage = listener;
    },
  };
  const documentObject = {
    getElementById(id: string) {
      return elements.get(id);
    },
    createElement() {
      return new FakeElement();
    },
    documentElement: new FakeElement(),
  };

  runInNewContext(script, {
    window: windowObject,
    parent,
    document: documentObject,
    Map,
    Promise,
    Error,
  });
  await tick();
  await tick();

  return {
    elements,
    outbound,
    compatibilityMessage,
    deliverHostMessage(message: JsonRpcMessage) {
      if (!onMessage) throw new Error('Agent Builder App message listener is missing.');
      onMessage({ source: parent, data: message });
    },
    expireRequestTimeouts() {
      for (const [id, callback] of [...manualTimeouts]) {
        manualTimeouts.delete(id);
        callback();
      }
    },
  };
}

function renderedActionButtons(elements: Map<string, FakeElement>): FakeElement[] {
  const itemCard = elements.get('items')?.children[0];
  const itemAction = itemCard?.children[itemCard.children.length - 1];
  return [...(itemAction ? [itemAction] : []), ...(elements.get('actions')?.children ?? [])];
}

describe('Combo Agent Builder MCP App bridge', () => {
  it('pins the reviewed self-contained App HTML', () => {
    expect(createHash('sha256').update(AGENT_BUILDER_APP_HTML).digest('hex')).toBe(
      AGENT_BUILDER_APP_HTML_SHA256,
    );
    expect(AGENT_BUILDER_APP_HTML).toContain("project_share: 'Project Agent 分享'");
    expect(AGENT_BUILDER_APP_HTML).toContain("project_restore: 'Project Agent 恢复'");
  });

  it('locks every card action while sending and keeps them locked while Codex continues', async () => {
    const app = await startApp();

    expect(app.outbound[0]).toMatchObject({
      method: 'ui/initialize',
      params: {
        appInfo: { name: 'combo-agent-builder', version: '0.6.0' },
        appCapabilities: { availableDisplayModes: ['inline'] },
        protocolVersion: '2026-01-26',
      },
    });
    expect(app.outbound[1]).toEqual({
      jsonrpc: '2.0',
      method: 'ui/notifications/initialized',
      params: {},
    });
    expect(app.elements.get('title')?.textContent).toBe('Combo 已就绪');

    const button = app.elements.get('actions')?.children[0];
    expect(button?.textContent).toBe('确认范围');
    const sending = button?.dispatch('click');

    expect(renderedActionButtons(app.elements)).toHaveLength(3);
    expect(renderedActionButtons(app.elements).every((action) => action.disabled)).toBe(true);
    expect(app.elements.get('action-status')).toMatchObject({
      hidden: false,
      textContent: '正在发送“确认范围”到 Codex…',
      dataset: { state: 'sending' },
    });

    await sending;
    await tick();

    expect(app.outbound[2]).toMatchObject({
      method: 'ui/message',
      params: {
        role: 'user',
        content: [{ type: 'text', text: '我确认这个分析范围。' }],
      },
    });
    expect(renderedActionButtons(app.elements).every((action) => action.disabled)).toBe(true);
    expect(app.elements.get('action-status')).toMatchObject({
      hidden: false,
      textContent: '已发送“确认范围”，正在等待 Codex 继续处理…',
      dataset: { state: 'waiting' },
    });
  });

  it('restores every action only after an explicit Host rejection', async () => {
    const app = await startApp({ actionResponse: 'reject' });
    const button = app.elements.get('actions')?.children[0];

    await button?.dispatch('click');

    expect(renderedActionButtons(app.elements).every((action) => !action.disabled)).toBe(true);
    expect(app.elements.get('action-status')).toMatchObject({
      hidden: true,
      textContent: '',
      dataset: { state: 'idle' },
    });
    expect(app.elements.get('error')).toMatchObject({
      hidden: false,
      textContent: 'Host rejected this action.',
    });

    await app.elements.get('actions')?.children[1]?.dispatch('click');

    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(2);
  });

  it('keeps the card locked after an eight-second timeout and never repeats the action', async () => {
    const app = await startApp({ actionResponse: 'timeout', manualRequestTimeouts: true });
    const button = app.elements.get('actions')?.children[0];
    const sending = button?.dispatch('click');

    expect(renderedActionButtons(app.elements).every((action) => action.disabled)).toBe(true);
    app.expireRequestTimeouts();
    await sending;

    expect(renderedActionButtons(app.elements).every((action) => action.disabled)).toBe(true);
    expect(app.elements.get('action-status')).toMatchObject({
      hidden: false,
      textContent: '发送状态不确定。为避免重复执行，本卡片保持锁定；请等待 Codex 回复。',
      dataset: { state: 'uncertain' },
    });
    expect(app.elements.get('error')).toMatchObject({
      hidden: false,
      textContent: '发送结果无法确认。为避免重复执行，请勿再次点击；请等待 Codex 回复。',
    });

    await app.elements.get('actions')?.children[1]?.dispatch('click');

    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(1);
  });

  it('sends only one Host request when another action is triggered while the first is pending', async () => {
    const app = await startApp({ actionResponse: 'timeout', manualRequestTimeouts: true });
    const firstAction = app.elements.get('actions')?.children[0];
    const secondAction = app.elements.get('actions')?.children[1];
    const firstSend = firstAction?.dispatch('click');

    await secondAction?.dispatch('click');

    const actionRequests = app.outbound.filter((message) => message.method === 'ui/message');
    expect(actionRequests).toHaveLength(1);
    expect(actionRequests[0]).toMatchObject({
      params: {
        role: 'user',
        content: [{ type: 'text', text: '我确认这个分析范围。' }],
      },
    });

    app.expireRequestTimeouts();
    await firstSend;
  });

  it.each(['success', 'reject'] as const)(
    'ignores a late Host %s response after entering the uncertain state',
    async (lateResponse) => {
      const app = await startApp({ actionResponse: 'timeout', manualRequestTimeouts: true });
      const firstAction = app.elements.get('actions')?.children[0];
      const sending = firstAction?.dispatch('click');
      const request = app.outbound.find((message) => message.method === 'ui/message');
      const requestId = request?.id;
      if (requestId === undefined) throw new Error('Expected one Host action request.');

      app.expireRequestTimeouts();
      await sending;
      app.deliverHostMessage(
        lateResponse === 'success'
          ? { jsonrpc: '2.0', id: requestId, result: {} }
          : {
              jsonrpc: '2.0',
              id: requestId,
              error: { code: -32600, message: 'Late Host rejection.' },
            },
      );

      expect(renderedActionButtons(app.elements).every((action) => action.disabled)).toBe(true);
      expect(app.elements.get('action-status')).toMatchObject({
        hidden: false,
        textContent: '发送状态不确定。为避免重复执行，本卡片保持锁定；请等待 Codex 回复。',
        dataset: { state: 'uncertain' },
      });
      expect(app.elements.get('error')).toMatchObject({
        hidden: false,
        textContent: '发送结果无法确认。为避免重复执行，请勿再次点击；请等待 Codex 回复。',
      });

      await app.elements.get('actions')?.children[1]?.dispatch('click');

      expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(1);
    },
  );

  it('feature-detects the OpenAI compatibility message helper', async () => {
    const app = await startApp({ useCompatibilityMessage: true });
    const button = app.elements.get('actions')?.children[0];

    await button?.dispatch('click');

    expect(app.compatibilityMessage).toHaveBeenCalledWith({
      prompt: '我确认这个分析范围。',
      scrollToBottom: true,
    });
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(0);
    expect(renderedActionButtons(app.elements).every((action) => action.disabled)).toBe(true);
    expect(app.elements.get('action-status')?.textContent).toBe(
      '已发送“确认范围”，正在等待 Codex 继续处理…',
    );
  });
});
