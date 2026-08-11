export interface ChatPageOptions {
  nonce: string;
  agentName: string;
}

export function renderChatPage(options: ChatPageOptions): string {
  const agentName = escapeHtml(options.agentName);
  const nonce = escapeHtml(options.nonce);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${agentName}</title>
  <style nonce="${nonce}">
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #f5f4ef; color: #1d1d1f; display: grid; place-items: center; }
    main { width: min(760px, 100vw); height: min(840px, 100vh); background: #fff; display: grid; grid-template-rows: auto 1fr auto; border: 1px solid #e5e2d8; box-shadow: 0 20px 60px rgba(45,40,25,.10); }
    header { padding: 18px 22px; border-bottom: 1px solid #ece9e1; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #b7b7b7; flex: 0 0 auto; }
    .dot.online { background: #23a35a; box-shadow: 0 0 0 4px rgba(35,163,90,.12); }
    h1 { font-size: 16px; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .subtle { color: #77736b; font-size: 12px; }
    button { border: 0; border-radius: 10px; padding: 10px 14px; font: inherit; cursor: pointer; background: #eeeae0; color: #27251f; }
    button.primary { background: #171713; color: #fff; min-width: 76px; }
    button:disabled { cursor: not-allowed; opacity: .45; }
    #messages { overflow: auto; padding: 24px; display: flex; flex-direction: column; gap: 14px; }
    .empty { margin: auto; max-width: 400px; text-align: center; color: #77736b; line-height: 1.6; }
    .message { max-width: 82%; padding: 12px 14px; border-radius: 14px; white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
    .user { align-self: flex-end; background: #171713; color: #fff; border-bottom-right-radius: 4px; }
    .agent { align-self: flex-start; background: #f1efe9; border-bottom-left-radius: 4px; }
    .notice { align-self: center; color: #a03e2e; background: #fff3ef; max-width: 92%; text-align: center; font-size: 13px; }
    .typing { color: #77736b; font-size: 13px; align-self: flex-start; padding: 4px 2px; }
    form { border-top: 1px solid #ece9e1; padding: 14px; display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: end; }
    textarea { resize: none; width: 100%; min-height: 48px; max-height: 160px; padding: 13px 14px; border: 1px solid #d8d4ca; border-radius: 12px; font: inherit; line-height: 1.4; outline: none; }
    textarea:focus { border-color: #77736b; box-shadow: 0 0 0 3px rgba(40,40,35,.07); }
    .actions { display: flex; gap: 8px; }
    #retry, #stop { display: none; }
    @media (max-width: 760px) { main { height: 100vh; border: 0; box-shadow: none; } .message { max-width: 90%; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="identity"><span id="status-dot" class="dot"></span><div><h1>${agentName}</h1><div id="status-text" class="subtle">正在连接</div></div></div>
      <button id="new-chat" type="button">新对话</button>
    </header>
    <section id="messages" aria-live="polite"><div id="empty" class="empty">直接发消息即可开始一段多轮对话。</div></section>
    <form id="composer">
      <textarea id="input" maxlength="4000" placeholder="输入一段文字…" aria-label="消息"></textarea>
      <div class="actions">
        <button id="retry" type="button">重试</button>
        <button id="stop" type="button">停止</button>
        <button id="send" class="primary" type="submit">发送</button>
      </div>
    </form>
  </main>
  <script nonce="${nonce}">
    (() => {
      'use strict';
      const fragment = new URLSearchParams(location.hash.slice(1));
      const capability = fragment.get('access');
      history.replaceState(null, '', '/');

      const messages = document.getElementById('messages');
      let empty = document.getElementById('empty');
      const form = document.getElementById('composer');
      const input = document.getElementById('input');
      const send = document.getElementById('send');
      const retry = document.getElementById('retry');
      const stop = document.getElementById('stop');
      const newChat = document.getElementById('new-chat');
      const statusDot = document.getElementById('status-dot');
      const statusText = document.getElementById('status-text');

      let conversationId = null;
      let conversationStarting = null;
      let conversationGeneration = 0;
      let pending = null;
      let typing = null;

      function setStatus(online, label) {
        statusDot.classList.toggle('online', online);
        statusText.textContent = label;
      }

      function appendMessage(kind, text) {
        empty?.remove();
        const node = document.createElement('div');
        node.className = 'message ' + kind;
        node.textContent = text;
        messages.appendChild(node);
        messages.scrollTop = messages.scrollHeight;
      }

      function showTyping(show) {
        if (show && !typing) {
          typing = document.createElement('div');
          typing.className = 'typing';
          typing.textContent = '正在回答…';
          messages.appendChild(typing);
        } else if (!show && typing) {
          typing.remove();
          typing = null;
        }
        messages.scrollTop = messages.scrollHeight;
      }

      function setBusy(busy) {
        input.disabled = busy;
        send.disabled = busy;
        newChat.disabled = busy;
        stop.style.display = busy ? 'inline-block' : 'none';
        showTyping(busy);
      }

      async function api(path, options = {}) {
        if (!capability) throw new Error('体验链接已失效，请重新启动 Worker。');
        const headers = {
          'Authorization': 'Bearer ' + capability,
          'X-Combo-Creator-Worker': '1',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        };
        const response = await fetch(path, {
          method: options.method || 'GET',
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          const error = new Error(payload?.error?.message || '请求失败。');
          error.retryable = Boolean(payload?.error?.retryable);
          throw error;
        }
        return payload.data;
      }

      async function ensureConversation() {
        if (conversationId) return conversationId;
        if (!conversationStarting) {
          const generation = conversationGeneration;
          const starting = api('/api/conversations', { method: 'POST', body: {} })
            .then((data) => {
              if (conversationGeneration === generation) conversationId = data.conversationId;
              return data.conversationId;
            })
            .finally(() => {
              if (conversationStarting === starting) conversationStarting = null;
            });
          conversationStarting = starting;
        }
        return conversationStarting;
      }

      async function refreshStatus() {
        try {
          const data = await api('/api/status');
          setStatus(Boolean(data.online), data.online ? (data.activeTurns ? '正在回答' : '在线') : '离线');
        } catch {
          setStatus(false, '连接失效');
        }
      }

      async function submitMessage(message, replay = false) {
        if (pending && pending.id !== message.id) return;
        pending = message;
        retry.style.display = 'none';
        if (!replay) appendMessage('user', message.text);
        setBusy(true);
        await refreshStatus();
        try {
          await ensureConversation();
          const result = await api('/api/conversations/' + conversationId + '/messages', {
            method: 'POST',
            body: { messageId: message.id, text: message.text },
          });
          appendMessage('agent', result.text);
          pending = null;
        } catch (error) {
          appendMessage('notice', error instanceof Error ? error.message : '请求失败。');
          if (error && error.retryable) retry.style.display = 'inline-block';
          else pending = null;
        } finally {
          setBusy(false);
          await refreshStatus();
          input.focus();
        }
      }

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = input.value;
        if (!text.trim() || text.length > 4000 || pending) return;
        input.value = '';
        void submitMessage({ id: crypto.randomUUID(), text });
      });

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          form.requestSubmit();
        }
      });

      retry.addEventListener('click', () => {
        if (pending) void submitMessage(pending, true);
      });

      stop.addEventListener('click', async () => {
        if (!conversationId) return;
        stop.disabled = true;
        try {
          await api('/api/conversations/' + conversationId + '/interrupt', { method: 'POST', body: {} });
        } catch (error) {
          appendMessage('notice', error instanceof Error ? error.message : '停止失败。');
        } finally {
          stop.disabled = false;
        }
      });

      newChat.addEventListener('click', async () => {
        conversationGeneration += 1;
        conversationId = null;
        conversationStarting = null;
        pending = null;
        messages.replaceChildren();
        const placeholder = document.createElement('div');
        placeholder.id = 'empty';
        placeholder.className = 'empty';
        placeholder.textContent = '直接发消息即可开始一段多轮对话。';
        messages.appendChild(placeholder);
        empty = placeholder;
        retry.style.display = 'none';
        setBusy(true);
        try { await ensureConversation(); } catch (error) {
          appendMessage('notice', error instanceof Error ? error.message : '无法新建对话。');
        } finally {
          setBusy(false);
          input.focus();
        }
      });

      void (async () => {
        if (!capability) {
          setStatus(false, '链接失效');
          input.disabled = true;
          send.disabled = true;
          appendMessage('notice', '体验链接已失效，请重新启动 Worker。');
          return;
        }
        try {
          await ensureConversation();
          await refreshStatus();
          input.focus();
          setInterval(() => void refreshStatus(), 5000);
        } catch (error) {
          setStatus(false, '无法连接');
          appendMessage('notice', error instanceof Error ? error.message : '无法连接本地 Agent。');
        }
      })();
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
