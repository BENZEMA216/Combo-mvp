import { describe, expect, it } from 'vitest';
import {
  DESIGN_STUDIO_CRAFT_REPAIR_PROMPT,
  DESIGN_STUDIO_REPAIR_PROMPT,
  designStudioCraftIssues,
  hasDesignStudioPage,
  hasDesignStudioRuntimeBridge,
  hasValidDesignStudioResult,
  isCompleteDesignStudioHtml,
  withDesignStudioInstructions,
} from './design-studio-prompt.js';
import { DESIGN_STUDIO_BOOTSTRAP_MARKER } from './design-visual-profile.js';

describe('withDesignStudioInstructions', () => {
  it('preserves the capability contract and requires a versioned main HTML page', () => {
    const prompt = withDesignStudioInstructions('原能力边界：不可伪造证据。');

    expect(prompt).toContain('原能力边界：不可伪造证据。');
    expect(prompt).toContain('Combo Design Agent');
    expect(prompt).toContain('kind="html"');
    expect(prompt).toContain('省略 artifactId');
    expect(prompt).toContain('新的不可变 revision');
    expect(prompt).toContain('这不是 Landing Page');
    expect(prompt).toContain('data-combo-key');
    expect(prompt).toContain('data-combo-key="run-primary"');
    expect(prompt).not.toContain('textContent 安全注入');
    expect(prompt).toContain("type: 'combo:run'");
    expect(prompt).toContain('version: 1');
    expect(prompt).toContain('保持当前 Miniapp 可见');
    expect(prompt).toContain('不要解释 HTML、bridge、artifactId');
    expect(prompt).toContain('禁止使用 setTimeout、setInterval、Math.random');
    expect(prompt).toContain('# 视觉连续性（普通 Revision）');
    expect(prompt).toContain('只修改用户点名的区域、状态或元素');
    expect(prompt).toContain('Operate 型工作界面');
    expect(prompt).toContain('只选择最影响使用的 1–3 个问题修复');
    expect(prompt).toContain('在本轮作用域内完成相应的 harden 与 polish');
    expect(prompt).not.toContain('Profile：Calm Editorial');
  });

  it('injects the automatically recommended profile for the first bootstrap', () => {
    const prompt = withDesignStudioInstructions('能力边界。', {
      capabilityName: '自动化巡检助手',
      tagline: '把周期任务整理成可执行清单',
      outputType: 'checklist',
      taskText: `${DESIGN_STUDIO_BOOTSTRAP_MARKER}\n请生成首版 Miniapp`,
    });

    expect(prompt).toContain('Profile：Soft Utility（soft-utility）');
    expect(prompt).toContain('accent: #B5573B');
    expect(prompt).toContain('核心任务放在一张双层软边工作卡中');
    expect(prompt).not.toContain('Profile：Gentle Story');
  });

  it('honors an explicit whole-page direction even on the first bootstrap', () => {
    const prompt = withDesignStudioInstructions('能力边界。', {
      capabilityName: '自动化巡检助手',
      outputType: 'checklist',
      taskText: `${DESIGN_STUDIO_BOOTSTRAP_MARKER}\n把整个页面改成蓝紫科技风`,
    });

    expect(prompt).toContain('# 用户定向动态视觉合同');
    expect(prompt).toContain('把整个页面改成蓝紫科技风');
    expect(prompt).not.toContain('Profile：Soft Utility');
  });

  it('uses capability metadata rather than bootstrap template copy for creator and editorial profiles', () => {
    const bootstrapTask = `${DESIGN_STUDIO_BOOTSTRAP_MARKER}
核心任务：生成任务工具。请整理 inputs、主操作与 output。`;
    const creatorPrompt = withDesignStudioInstructions('能力边界。', {
      capabilityName: '穿搭博主内容 Agent',
      tagline: '生成小红书生活方式故事',
      outputType: 'text',
      taskText: bootstrapTask,
    });
    const editorialPrompt = withDesignStudioInstructions('能力边界。', {
      capabilityName: '研究审计报告',
      description: '分析风险并输出专业文档',
      outputType: 'text',
      taskText: bootstrapTask,
    });

    expect(creatorPrompt).toContain('Profile：Gentle Story（gentle-story）');
    expect(editorialPrompt).toContain('Profile：Calm Editorial（calm-editorial）');
    expect(editorialPrompt).not.toContain('Profile：Soft Utility');
  });

  it('keeps the current visual language for an ordinary local revision', () => {
    const prompt = withDesignStudioInstructions('能力边界。', {
      capabilityName: '自动化巡检助手',
      tagline: '把周期任务整理成可执行清单',
      outputType: 'checklist',
      taskText: '让表单和运行状态更清楚，只调整主按钮文案',
    });

    expect(prompt).toContain('# 视觉连续性（普通 Revision）');
    expect(prompt).toContain('沿用当前页面已有的 Design Tokens、Profile 与唯一视觉签名');
    expect(prompt).not.toContain('# 本轮 Artifact 视觉合同');
    expect(prompt).not.toContain('canvas:');
  });

  it('keeps continuity during a page-level layout refactor that preserves the current style', () => {
    const prompt = withDesignStudioInstructions('能力边界。', {
      capabilityName: '自动化巡检助手',
      outputType: 'checklist',
      taskText: '整体重新排版并优化响应式布局，但保持现在风格',
    });

    expect(prompt).toContain('# 视觉连续性（普通 Revision）');
    expect(prompt).not.toContain('# 本轮 Artifact 视觉合同');
  });

  it('uses a dynamic contract for an explicit whole-page visual request', () => {
    const prompt = withDesignStudioInstructions('能力边界。', {
      capabilityName: '严肃审计报告',
      description: '分析风险并输出专业文档',
      outputType: 'text',
      taskText: '把整个页面改成温柔亲和的个人成长故事风格',
    });

    expect(prompt).toContain('# 用户定向动态视觉合同');
    expect(prompt).toContain('把整个页面改成温柔亲和的个人成长故事风格');
    expect(prompt).toContain('success #2F6B4F');
    expect(prompt).toContain('warning #946A24');
    expect(prompt).toContain('danger #9A4038');
    expect(prompt).toContain('focus #315F7D');
    expect(prompt).not.toContain('Profile：Calm Editorial');
    expect(prompt).not.toContain('Profile：Soft Utility');
    expect(prompt).not.toContain('Profile：Gentle Story');
    expect(prompt).not.toContain('#FFF7F0');
    expect(prompt).not.toContain('# 视觉连续性（普通 Revision）');
  });

  it('keeps a generic blue-purple technology direction out of the fixed warm profiles', () => {
    const prompt = withDesignStudioInstructions('能力边界。', {
      capabilityName: '自动化巡检助手',
      outputType: 'checklist',
      taskText: '把整个页面改成蓝紫科技风',
    });

    expect(prompt).toContain('# 用户定向动态视觉合同');
    expect(prompt).toContain('把整个页面改成蓝紫科技风');
    for (const fixedProfile of ['Calm Editorial', 'Soft Utility', 'Gentle Story']) {
      expect(prompt).not.toContain(fixedProfile);
    }
    for (const warmToken of ['#F7F4ED', '#F3F0EA', '#FFF7F0', '#A64F35', '#B5573B', '#B45540']) {
      expect(prompt).not.toContain(warmToken);
    }
  });

  it('requires the versioned Runtime bridge and rejects simulated execution', () => {
    const realBridge = `<!doctype html><html><body><button data-combo-key="run-primary">运行</button><script>
      const prompt = '处理真实任务';
      window.parent.postMessage({ type: 'combo:run', version: 1, prompt }, '*');
    </script></body></html>`;
    const fakeResult = `<!doctype html><html><body><script>
      const prompt = '处理真实任务';
      window.parent.postMessage({ type: 'combo:run', version: 1, prompt }, '*');
      setTimeout(() => document.body.textContent = '成功', 800);
    </script></body></html>`;

    expect(hasDesignStudioRuntimeBridge(realBridge)).toBe(true);
    expect(hasDesignStudioRuntimeBridge(realBridge.replace('version: 1', 'version: 2'))).toBe(
      false,
    );
    expect(hasDesignStudioRuntimeBridge(fakeResult)).toBe(false);
    expect(hasDesignStudioRuntimeBridge('<html><body>没有 bridge</body></html>')).toBe(false);
  });

  it('only accepts a fresh HTML artifact as a completed design result', () => {
    expect(hasDesignStudioPage([{ kind: 'html' }])).toBe(true);
    expect(hasDesignStudioPage([{ kind: 'structured' }, { kind: 'markdown' }])).toBe(false);
    expect(hasDesignStudioPage([])).toBe(false);
  });

  it('requires the fresh main ref, complete document and Runtime bridge as one result', () => {
    const ref = [{ kind: 'html' as const }];
    const validHtml = `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        :root { --space: 1rem; --focus: #315f7d; }
        main { padding: var(--space); }
        button:focus-visible { outline: 2px solid var(--focus); }
        @media (max-width: 40rem) { main { padding: calc(var(--space) / 2); } }
      </style>
    </head><body><main>
      <button data-combo-key="run-primary">运行</button>
      <script>const prompt = '真实输入'; parent.postMessage({type:'combo:run',version:1,prompt}, '*')</script>
    </main></body></html>`;

    expect(hasValidDesignStudioResult(ref, validHtml)).toBe(true);
    expect(hasValidDesignStudioResult([], validHtml)).toBe(false);
    expect(hasValidDesignStudioResult(ref, '<div>fragment</div>')).toBe(false);
    expect(
      hasValidDesignStudioResult(
        ref,
        '<!doctype html><html><body><button data-combo-key="run-primary">运行</button></body></html>',
      ),
    ).toBe(false);

    const legacyHtml = `<!doctype html><html><body>
      <button data-combo-key="run-primary">运行</button>
      <script>const prompt = '真实输入'; parent.postMessage({type:'combo:run',version:1,prompt}, '*')</script>
    </body></html>`;
    expect(hasValidDesignStudioResult(ref, legacyHtml)).toBe(true);
    expect(hasValidDesignStudioResult(ref, legacyHtml, true)).toBe(false);
  });

  it('keeps the deterministic craft floor small and objective', () => {
    const bare = `<!doctype html><html><body>
      <button data-combo-key="run-primary">运行</button>
    </body></html>`;
    expect(designStudioCraftIssues(bare)).toEqual([
      '缺少 viewport meta',
      '缺少实际复用的 :root Design Tokens',
      '缺少可见的键盘焦点样式',
      '缺少响应式布局策略',
    ]);

    const crafted = `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width">
      <style>
        :root { --gap: 1rem; }
        main { display: grid; gap: var(--gap); grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
        button:focus-visible { outline: 2px solid currentColor; }
      </style>
    </head><body></body></html>`;
    expect(designStudioCraftIssues(crafted)).toEqual([]);
  });

  it('accepts common legal syntax variants and ignores detector hints in comments', () => {
    const fluid = `<!doctype html><html><head>
      <meta name=viewport content="width=device-width">
      <style>
        :root[data-theme="light"], html { --gap: 1rem; }
        main { width: 92vw; max-width: 60rem; gap: var(--gap); }
        button:focus-visible { outline: 2px solid currentColor; }
      </style>
    </head><body></body></html>`;
    expect(designStudioCraftIssues(fluid)).toEqual([]);

    const commentsOnly = `<!doctype html><html><head>
      <!-- <meta name="viewport"> -->
      <style>/* :root { --gap: 1rem; } var(--gap) :focus-visible @media */</style>
    </head><body></body></html>`;
    expect(designStudioCraftIssues(commentsOnly)).toEqual([
      '缺少 viewport meta',
      '缺少实际复用的 :root Design Tokens',
      '缺少可见的键盘焦点样式',
      '缺少响应式布局策略',
    ]);
  });

  it('keeps ordinary and scoped repairs inside the original edit boundary', () => {
    expect(DESIGN_STUDIO_REPAIR_PROMPT).toContain('系统自动修复');
    expect(DESIGN_STUDIO_REPAIR_PROMPT).toContain('立即调用 upsert_artifact');
    expect(DESIGN_STUDIO_REPAIR_PROMPT).toContain('省略 artifactId');
    expect(DESIGN_STUDIO_REPAIR_PROMPT).toContain('kind="html"');
    expect(DESIGN_STUDIO_REPAIR_PROMPT).toContain('data-combo-key="run-primary"');
    expect(DESIGN_STUDIO_REPAIR_PROMPT).not.toContain('data-combo-key="result-main"');
    expect(DESIGN_STUDIO_REPAIR_PROMPT).not.toContain('textContent 安全注入');
    expect(DESIGN_STUDIO_REPAIR_PROMPT).toContain("type: 'combo:run'");
    expect(DESIGN_STUDIO_REPAIR_PROMPT).toContain('version: 1');
    expect(DESIGN_STUDIO_REPAIR_PROMPT).toContain('严格保持用户本轮的原始作用域');
    expect(DESIGN_STUDIO_REPAIR_PROMPT).not.toContain('viewport meta');
    expect(DESIGN_STUDIO_REPAIR_PROMPT).not.toContain(':focus-visible');
  });

  it('adds the deterministic craft floor only to bootstrap and page-wide repairs', () => {
    expect(DESIGN_STUDIO_CRAFT_REPAIR_PROMPT).toContain('首版或全页设计操作');
    expect(DESIGN_STUDIO_CRAFT_REPAIR_PROMPT).toContain('viewport meta');
    expect(DESIGN_STUDIO_CRAFT_REPAIR_PROMPT).toContain(':focus-visible');
    expect(DESIGN_STUDIO_CRAFT_REPAIR_PROMPT).not.toContain('严格保持用户本轮的原始作用域');
  });

  it('rejects HTML labels that do not contain a complete document', () => {
    expect(
      isCompleteDesignStudioHtml(
        '<!doctype html><html><head><title>Miniapp</title></head><body>完成</body></html>',
      ),
    ).toBe(true);
    expect(isCompleteDesignStudioHtml('<div>只有片段</div>')).toBe(false);
    expect(isCompleteDesignStudioHtml(null)).toBe(false);
  });
});
