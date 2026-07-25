import { describe, expect, it } from 'vitest';
import {
  DESIGN_VISUAL_PROFILES,
  DESIGN_STUDIO_BOOTSTRAP_MARKER,
  designVisualProfilePrompt,
  recommendDesignVisualProfile,
  requestsWholeVisualRestyle,
} from './design-visual-profile.js';

describe('recommendDesignVisualProfile', () => {
  it('uses Calm Editorial as the no-choice default', () => {
    expect(recommendDesignVisualProfile().id).toBe('calm-editorial');
    expect(recommendDesignVisualProfile({ capabilityName: '未知能力' }).id).toBe('calm-editorial');
  });

  it('maps utility and creator semantics to bounded profiles', () => {
    expect(
      recommendDesignVisualProfile({
        capabilityName: 'AVM 周期自动化巡检',
        tagline: '整理任务并跟踪执行',
        outputType: 'checklist',
      }).id,
    ).toBe('soft-utility');

    expect(
      recommendDesignVisualProfile({
        capabilityName: '穿搭博主内容 Agent',
        tagline: '生成小红书生活方式故事',
        outputType: 'text',
      }).id,
    ).toBe('gentle-story');

    expect(
      recommendDesignVisualProfile({
        capabilityName: '重启人生',
        outputType: 'text',
      }).id,
    ).toBe('gentle-story');
  });

  it('does not let transient task copy override frozen capability semantics', () => {
    expect(
      recommendDesignVisualProfile({
        capabilityName: '严肃审计报告',
        description: '分析风险并输出专业文档',
        outputType: 'text',
        taskText: '这次改成温柔亲和的个人成长故事卡片',
      }).id,
    ).toBe('calm-editorial');
  });

  it('accepts an explicit internal profile without exposing a picker', () => {
    expect(
      recommendDesignVisualProfile({
        capabilityName: '研究报告',
        explicitProfile: 'soft-utility',
      }).id,
    ).toBe('soft-utility');
  });
});

describe('requestsWholeVisualRestyle', () => {
  it('enables a full profile for bootstrap and explicit page-level restyles', () => {
    expect(requestsWholeVisualRestyle(`${DESIGN_STUDIO_BOOTSTRAP_MARKER}\n生成首版`)).toBe(true);
    expect(requestsWholeVisualRestyle('把整个页面改成温柔亲和的故事风格')).toBe(true);
    expect(requestsWholeVisualRestyle('整体换一套更克制的视觉语言')).toBe(true);
    expect(requestsWholeVisualRestyle('把整个页面改成蓝紫科技风')).toBe(true);
    expect(requestsWholeVisualRestyle('把全页面改成赛博朋克风')).toBe(true);
  });

  it('keeps the current profile for local revisions', () => {
    expect(requestsWholeVisualRestyle('让表单和运行状态更清楚')).toBe(false);
    expect(requestsWholeVisualRestyle('把主按钮改得更可爱一些')).toBe(false);
    expect(requestsWholeVisualRestyle('只调整标题字号与上下间距')).toBe(false);
  });

  it('does not confuse layout work or an explicit preserve request with a visual restyle', () => {
    expect(requestsWholeVisualRestyle('整体重新排版并调整响应式布局')).toBe(false);
    expect(requestsWholeVisualRestyle('整体重新排版，但保持现在风格')).toBe(false);
  });
});

describe('designVisualProfilePrompt', () => {
  it.each([
    ['calm-editorial', '#F7F4ED', '暖纸画布'],
    ['soft-utility', '#F3F0EA', '双层软边工作卡'],
    ['gentle-story', '#FFF7F0', '衬线序号签'],
  ] as const)(
    'renders exact tokens, one signature and safety checks for %s',
    (id, canvas, signature) => {
      const prompt = designVisualProfilePrompt(DESIGN_VISUAL_PROFILES[id]);

      expect(prompt).toContain(`canvas: ${canvas}`);
      expect(prompt).toContain(`唯一视觉签名：`);
      expect(prompt).toContain(signature);
      expect(prompt).toContain('不得自行新增第二套主色');
      expect(prompt).toContain('所有展示内容来自用户真实输入或真实 Runtime');
      expect(prompt).toContain('combo:run bridge');
      expect(prompt).not.toContain('result-main');
      expect(prompt).toContain('不要把 profile 名称、token 表或自检清单展示给终端用户');
    },
  );

  it('keeps semantic state colors stable across every profile', () => {
    const profiles = Object.values(DESIGN_VISUAL_PROFILES);
    const semanticKeys = ['success', 'warning', 'danger', 'focus'] as const;

    for (const key of semanticKeys) {
      expect(new Set(profiles.map((profile) => profile.tokens[key])).size).toBe(1);
    }
  });
});
