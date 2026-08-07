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

async function startApp(options: { useCompatibilityMessage?: boolean } = {}) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(AGENT_BUILDER_APP_HTML)?.[1];
  if (!script) throw new Error('Agent Builder App script is missing.');

  const elements = new Map(
    ['stage', 'title', 'summary', 'progress', 'items', 'actions', 'error'].map((id) => [
      id,
      new FakeElement(),
    ]),
  );
  const outbound: JsonRpcMessage[] = [];
  const compatibilityMessage = vi.fn(async () => undefined);
  const toolPayload = {
    stage: 'readiness',
    title: 'Combo 已就绪',
    summary: '等待确认分析范围。',
    progress: [{ label: '确认范围', state: 'current' }],
    items: [],
    actions: [
      {
        label: '确认范围',
        message: '我确认这个分析范围。',
        emphasis: 'primary',
      },
    ],
  };
  let onMessage: ((event: { source: unknown; data: JsonRpcMessage }) => void) | undefined;

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
        const requestId = message.id;
        queueMicrotask(() =>
          onMessage?.({
            source: parent,
            data: { jsonrpc: '2.0', id: requestId, result: {} },
          }),
        );
      }
    },
  };
  const windowObject = {
    parent,
    setTimeout,
    clearTimeout,
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

  return { elements, outbound, compatibilityMessage };
}

describe('Combo Agent Builder MCP App bridge', () => {
  it('pins the reviewed self-contained App HTML', () => {
    expect(createHash('sha256').update(AGENT_BUILDER_APP_HTML).digest('hex')).toBe(
      AGENT_BUILDER_APP_HTML_SHA256,
    );
  });

  it('initializes before receiving tool data and sends actions through ui/message', async () => {
    const app = await startApp();

    expect(app.outbound[0]).toMatchObject({
      method: 'ui/initialize',
      params: {
        appInfo: { name: 'combo-agent-builder', version: '0.5.0' },
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
    await button?.dispatch('click');
    await tick();

    expect(app.outbound[2]).toMatchObject({
      method: 'ui/message',
      params: {
        role: 'user',
        content: [{ type: 'text', text: '我确认这个分析范围。' }],
      },
    });
  });

  it('feature-detects the OpenAI compatibility message helper', async () => {
    const app = await startApp({ useCompatibilityMessage: true });
    const button = app.elements.get('actions')?.children[0];

    await button?.dispatch('click');

    expect(app.compatibilityMessage).toHaveBeenCalledWith({
      prompt: '我确认这个分析范围。',
      scrollToBottom: true,
    });
    expect(app.outbound.filter((message) => message.method === 'ui/message')).toHaveLength(0);
  });
});
