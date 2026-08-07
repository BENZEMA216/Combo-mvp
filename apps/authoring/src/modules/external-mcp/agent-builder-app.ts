export const AGENT_BUILDER_APP_URI = 'ui://combo/agent-builder/v1.html';

export const AGENT_BUILDER_APP_RESOURCE = {
  uri: AGENT_BUILDER_APP_URI,
  name: 'combo-agent-builder',
  title: 'Combo Agent Builder',
  description: 'Render one model-checked Combo Agent Builder stage inside the conversation.',
  mimeType: 'text/html;profile=mcp-app',
} as const;

export const AGENT_BUILDER_APP_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; color: var(--color-text-primary, #182033); background: transparent; }
      main { display: grid; gap: 14px; padding: 16px; border: 1px solid var(--color-border-default, #dce2ec); border-radius: 18px; background: var(--color-background-primary, #fff); }
      header { display: grid; gap: 6px; }
      .eyebrow { color: #3b5ccc; font-size: 12px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
      h1 { margin: 0; font-size: 20px; line-height: 1.25; }
      .summary { margin: 0; color: var(--color-text-secondary, #596579); font-size: 14px; line-height: 1.55; }
      .progress { display: flex; flex-wrap: wrap; gap: 7px; }
      .step { padding: 6px 9px; border-radius: 999px; background: var(--color-background-secondary, #f1f4f8); color: var(--color-text-secondary, #596579); font-size: 12px; }
      .step[data-state="current"] { background: #e8edff; color: #2949b8; font-weight: 700; }
      .step[data-state="done"] { background: #e8f7ef; color: #187044; }
      .items { display: grid; gap: 10px; }
      .item { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--color-border-default, #dce2ec); border-radius: 14px; }
      .item h2 { margin: 0; font-size: 15px; }
      .item p { margin: 0; color: var(--color-text-secondary, #596579); font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
      dl { display: grid; grid-template-columns: minmax(84px, .4fr) 1fr; gap: 6px 10px; margin: 0; font-size: 12px; }
      dt { color: var(--color-text-secondary, #6b7280); }
      dd { margin: 0; overflow-wrap: anywhere; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; }
      button { appearance: none; border: 1px solid var(--color-border-default, #cfd7e4); border-radius: 10px; padding: 9px 12px; background: var(--color-background-primary, #fff); color: inherit; font: inherit; font-size: 13px; font-weight: 680; cursor: pointer; }
      button[data-emphasis="primary"] { border-color: #3b5ccc; background: #3b5ccc; color: #fff; }
      button:disabled { cursor: wait; opacity: .6; }
      .empty { padding: 10px; border-radius: 12px; background: var(--color-background-secondary, #f5f7fa); color: var(--color-text-secondary, #596579); font-size: 13px; }
      .error { color: #a62b2b; font-size: 12px; }
      @media (prefers-color-scheme: dark) {
        body { color: var(--color-text-primary, #edf1f7); }
        main { background: var(--color-background-primary, #151922); border-color: var(--color-border-default, #353d4b); }
        .step[data-state="current"] { background: #25346b; color: #dce4ff; }
        .step[data-state="done"] { background: #173c2b; color: #c6f2d9; }
        button { background: var(--color-background-primary, #151922); border-color: var(--color-border-default, #465064); }
      }
    </style>
  </head>
  <body>
    <main aria-live="polite">
      <header>
        <div class="eyebrow" id="stage">Combo Agent Builder</div>
        <h1 id="title">正在准备展示…</h1>
        <p class="summary" id="summary"></p>
      </header>
      <div class="progress" id="progress"></div>
      <div class="items" id="items"></div>
      <div class="actions" id="actions"></div>
      <div class="error" id="error" hidden></div>
    </main>
    <script>
      (() => {
        const stageLabels = {
          readiness: '就绪与范围', recommendations: 'Agent 建议', production: '生产进度',
          draft: 'Agent 草稿', test: '测试摘要', release: '发布确认'
        };
        const pending = new Map();
        let nextId = 1;

        function request(method, params) {
          const id = nextId++;
          window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
          return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        }

        function text(value) { return typeof value === 'string' ? value : ''; }
        function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
        function el(tag, className, value) {
          const node = document.createElement(tag);
          if (className) node.className = className;
          if (value) node.textContent = value;
          return node;
        }

        async function sendFollowUp(action, button) {
          const error = document.getElementById('error');
          error.hidden = true;
          button.disabled = true;
          try {
            await request('ui/message', {
              role: 'user',
              content: [{ type: 'text', text: action.message }]
            });
          } catch (cause) {
            error.textContent = cause && cause.message ? cause.message : '无法把选择发送回 Codex，请在对话框中输入同样内容。';
            error.hidden = false;
            button.disabled = false;
          }
        }

        function render(payload) {
          if (!payload || typeof payload !== 'object') return;
          document.getElementById('stage').textContent = stageLabels[payload.stage] || 'Combo Agent Builder';
          document.getElementById('title').textContent = text(payload.title) || 'Combo Agent Builder';
          const summary = document.getElementById('summary');
          summary.textContent = text(payload.summary);
          summary.hidden = !summary.textContent;

          const progress = document.getElementById('progress');
          clear(progress);
          for (const step of Array.isArray(payload.progress) ? payload.progress : []) {
            const node = el('span', 'step', text(step.label));
            node.dataset.state = text(step.state) || 'pending';
            progress.appendChild(node);
          }

          const items = document.getElementById('items');
          clear(items);
          const rows = Array.isArray(payload.items) ? payload.items : [];
          if (!rows.length) items.appendChild(el('div', 'empty', '当前没有需要展示的条目。'));
          for (const row of rows) {
            const card = el('section', 'item');
            card.appendChild(el('h2', '', text(row.title) || '未命名条目'));
            if (text(row.summary)) card.appendChild(el('p', '', text(row.summary)));
            const facts = Array.isArray(row.facts) ? row.facts : [];
            if (facts.length) {
              const list = document.createElement('dl');
              for (const fact of facts) {
                list.appendChild(el('dt', '', text(fact.label)));
                list.appendChild(el('dd', '', text(fact.value)));
              }
              card.appendChild(list);
            }
            if (row.action && text(row.action.label) && text(row.action.message)) {
              const button = el('button', '', text(row.action.label));
              button.dataset.emphasis = text(row.action.emphasis) || 'secondary';
              button.addEventListener('click', () => sendFollowUp(row.action, button));
              card.appendChild(button);
            }
            items.appendChild(card);
          }

          const actions = document.getElementById('actions');
          clear(actions);
          for (const action of Array.isArray(payload.actions) ? payload.actions : []) {
            if (!text(action.label) || !text(action.message)) continue;
            const button = el('button', '', text(action.label));
            button.dataset.emphasis = text(action.emphasis) || 'secondary';
            button.addEventListener('click', () => sendFollowUp(action, button));
            actions.appendChild(button);
          }
        }

        window.addEventListener('message', (event) => {
          if (event.source !== window.parent) return;
          const message = event.data;
          if (!message || message.jsonrpc !== '2.0') return;
          if (message.id !== undefined && pending.has(message.id)) {
            const waiter = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) waiter.reject(new Error(message.error.message || 'Host rejected the action.'));
            else waiter.resolve(message.result || {});
            return;
          }
          if (message.method === 'ui/notifications/tool-result') {
            render(message.params && message.params.structuredContent);
          }
          if (message.method === 'ui/notifications/tool-input') {
            render(message.params && (message.params.arguments || message.params));
          }
        }, { passive: true });

        if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput);
        else if (window.openai && window.openai.toolInput) render(window.openai.toolInput);
      })();
    </script>
  </body>
</html>`;

export function agentBuilderAppResourceContents() {
  return {
    contents: [
      {
        uri: AGENT_BUILDER_APP_URI,
        mimeType: AGENT_BUILDER_APP_RESOURCE.mimeType,
        text: AGENT_BUILDER_APP_HTML,
        _meta: { ui: { prefersBorder: true } },
      },
    ],
  };
}
