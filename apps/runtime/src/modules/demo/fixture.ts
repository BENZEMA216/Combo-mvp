// Test 环境固定 Miniapp：让没有真实上传结果的评审账号也能完整体验设计、试用与发布链路。
// 页面只把真实任务交给 Runtime；静态内容仅用于解释输入方式，不伪造 Agent 输出。

export const COMBO_MINIAPP_FIXTURE = {
  source: 'test-demo',
  fixture: 'combo-miniapp',
  fixtureVersion: 1,
} as const;

export const COMBO_MINIAPP_DEMO_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Combo Miniapp 设计助手</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #181715;
      --muted: #6f6a62;
      --paper: #fbfaf7;
      --canvas: #f2eee6;
      --line: rgba(24, 23, 21, 0.13);
      --accent: #b75b40;
      --accent-soft: #f3ded5;
      --mint: #dfece3;
      --mint-ink: #315c49;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background:
        linear-gradient(rgba(24, 23, 21, 0.045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(24, 23, 21, 0.045) 1px, transparent 1px),
        var(--canvas);
      background-size: 28px 28px;
    }
    button, textarea { font: inherit; }
    .shell {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 48px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 28px;
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 760; }
    .mark {
      display: grid;
      width: 34px;
      height: 34px;
      place-items: center;
      border-radius: 11px;
      color: #fff;
      background: var(--ink);
      box-shadow: 0 8px 20px rgba(24, 23, 21, 0.15);
    }
    .eyebrow {
      color: var(--accent);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .live {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: rgba(251, 250, 247, 0.76);
      font-size: 12px;
    }
    .live::before {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #63b78e;
      content: "";
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 0.85fr) minmax(420px, 1.15fr);
      overflow: hidden;
      min-height: 650px;
      border: 1px solid var(--line);
      border-radius: 28px;
      background: var(--paper);
      box-shadow: 0 24px 70px rgba(39, 34, 27, 0.1);
    }
    .intro {
      display: flex;
      flex-direction: column;
      padding: clamp(34px, 5vw, 72px);
      border-right: 1px solid var(--line);
    }
    h1 {
      max-width: 560px;
      margin: 18px 0 22px;
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-size: clamp(42px, 5vw, 72px);
      font-weight: 500;
      letter-spacing: -0.045em;
      line-height: 0.98;
    }
    .lead {
      max-width: 480px;
      margin: 0;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.75;
    }
    .steps {
      display: grid;
      gap: 1px;
      margin-top: auto;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--line);
      overflow: hidden;
    }
    .step {
      display: grid;
      grid-template-columns: 36px 1fr;
      gap: 12px;
      padding: 16px;
      background: var(--paper);
    }
    .step b { font-size: 13px; }
    .step p { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
    .number {
      display: grid;
      width: 30px;
      height: 30px;
      place-items: center;
      border-radius: 10px;
      color: var(--accent);
      background: var(--accent-soft);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
    }
    .workspace {
      display: flex;
      flex-direction: column;
      gap: 20px;
      padding: clamp(28px, 4vw, 56px);
      background: rgba(255, 255, 255, 0.42);
    }
    .workspace-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .workspace h2 { margin: 0; font-size: 22px; }
    .workspace-head p { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
    .badge {
      padding: 7px 10px;
      border-radius: 999px;
      color: var(--mint-ink);
      background: var(--mint);
      font-size: 12px;
      white-space: nowrap;
    }
    .card {
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: rgba(251, 250, 247, 0.92);
      box-shadow: 0 12px 30px rgba(39, 34, 27, 0.06);
    }
    label { display: block; margin-bottom: 10px; font-size: 13px; font-weight: 700; }
    textarea {
      width: 100%;
      min-height: 142px;
      resize: vertical;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 14px;
      outline: none;
      color: var(--ink);
      background: #fff;
      line-height: 1.65;
      transition: border-color 160ms ease, box-shadow 160ms ease;
    }
    textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
    .suggestions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 18px; }
    .suggestion {
      padding: 8px 11px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: transparent;
      cursor: pointer;
    }
    .suggestion:hover { color: var(--ink); border-color: rgba(24, 23, 21, 0.32); }
    .run {
      display: flex;
      width: 100%;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 14px 18px;
      border: 0;
      border-radius: 14px;
      color: #fff;
      background: var(--accent);
      box-shadow: 0 10px 22px rgba(183, 91, 64, 0.24);
      cursor: pointer;
      font-weight: 730;
    }
    .run:hover { background: #a84f37; }
    .run:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 3px; }
    .hint { min-height: 18px; margin: 10px 0 0; color: var(--accent); font-size: 12px; }
    .preview {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .preview article {
      min-height: 116px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: #fff;
    }
    .preview small { color: var(--muted); }
    .preview strong { display: block; margin: 18px 0 6px; font-size: 17px; }
    .preview p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
    @media (max-width: 850px) {
      .hero { grid-template-columns: 1fr; }
      .intro { min-height: 520px; border-right: 0; border-bottom: 1px solid var(--line); }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 20px, 1180px); padding-top: 14px; }
      .hero { border-radius: 20px; }
      .intro, .workspace { padding: 26px 20px; }
      .preview { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand"><span class="mark">Co</span><span>Combo.</span></div>
      <span class="live">Agent 已就绪</span>
    </header>
    <section class="hero">
      <div class="intro">
        <span class="eyebrow">Combo · Miniapp Design Agent</span>
        <h1>把产品想法，变成可以真实使用的 Miniapp。</h1>
        <p class="lead">告诉我目标用户、核心任务与必须保留的工作流。我会调用真实 Agent，把想法包装成可交互、可继续修改的页面。</p>
        <div class="steps" aria-label="使用步骤">
          <div class="step"><span class="number">01</span><div><b>说清产品与工作流</b><p>一句话也可以，补充用户、输入和输出会让首版更贴近使用场景。</p></div></div>
          <div class="step"><span class="number">02</span><div><b>生成可交互 Miniapp</b><p>任务会交给 Combo Runtime，页面、交互与结果会出现在工作区。</p></div></div>
          <div class="step"><span class="number">03</span><div><b>对话式持续修改</b><p>继续描述反馈，页面结构、视觉和交互会保留每一次有效 revision。</p></div></div>
        </div>
      </div>
      <div class="workspace">
        <div class="workspace-head">
          <div><h2>开始设计一个 Miniapp</h2><p>首版会在当前会话中生成，并可继续迭代。</p></div>
          <span class="badge">可反复修改</span>
        </div>
        <form class="card" id="agent-form">
          <label for="goal">你想把哪段工作流包装成 Miniapp？</label>
          <textarea id="goal" name="goal" placeholder="例如：把每周项目复盘流程做成一个任务助手。用户输入本周进展和卡点，页面输出风险、优先级与下一步行动。" required></textarea>
          <div class="suggestions" aria-label="快捷输入">
            <button class="suggestion" type="button" data-prompt="把每周项目复盘工作流包装成任务助手：输入进展与卡点，输出风险、优先级和下一步行动。">任务助手</button>
            <button class="suggestion" type="button" data-prompt="把我的内容策划流程做成工作台：输入主题和受众，输出选题角度、内容结构与发布检查清单。">内容工作台</button>
            <button class="suggestion" type="button" data-prompt="优化当前 Miniapp 的信息层级、关键交互和移动端体验，同时保持 Agent 能力边界不变。">优化已有页面</button>
          </div>
          <button class="run" type="submit" data-combo-key="run-primary"><span>运行这个 Agent</span><span aria-hidden="true">→</span></button>
          <p class="hint" id="form-hint" role="status" aria-live="polite"></p>
        </form>
        <div class="preview" aria-label="你将获得">
          <article><small>01 · 可用</small><strong>不是截图，而是真实界面</strong><p>关键按钮会调用 Agent，产物可以在同一工作区中继续操作。</p></article>
          <article><small>02 · 迭代</small><strong>对话与页面同步更新</strong><p>保留上下文，在同一会话中持续打磨结构、交互与视觉。</p></article>
        </div>
      </div>
    </section>
  </main>
  <script>
    const form = document.querySelector('#agent-form');
    const goal = document.querySelector('#goal');
    const hint = document.querySelector('#form-hint');
    document.querySelectorAll('[data-prompt]').forEach((button) => {
      button.addEventListener('click', () => {
        goal.value = button.dataset.prompt || '';
        goal.focus();
        hint.textContent = '';
      });
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const prompt = goal.value.trim();
      if (!prompt) {
        hint.textContent = '请先描述一个真实任务。';
        goal.focus();
        return;
      }
      hint.textContent = '任务已交给 Agent，正在工作区生成结果。';
      window.parent.postMessage({ type: 'combo:run', version: 1, prompt }, '*');
    });
  </script>
</body>
</html>`;
