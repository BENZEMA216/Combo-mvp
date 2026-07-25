export const DESIGN_VISUAL_PROFILE_IDS = [
  'calm-editorial',
  'soft-utility',
  'gentle-story',
] as const;

export type DesignVisualProfileId = (typeof DESIGN_VISUAL_PROFILE_IDS)[number];

export interface DesignVisualTokens {
  canvas: string;
  surface: string;
  surfaceMuted: string;
  ink: string;
  inkMuted: string;
  accent: string;
  accentSoft: string;
  success: string;
  warning: string;
  danger: string;
  border: string;
  focus: string;
  headingFont: string;
  bodyFont: string;
  monoFont: string;
  radiusSmall: string;
  radiusMedium: string;
  radiusLarge: string;
  shadow: string;
  spacingUnit: string;
}

export interface DesignVisualProfile {
  id: DesignVisualProfileId;
  name: string;
  suitedFor: readonly string[];
  signature: string;
  tokens: DesignVisualTokens;
  bannedPatterns: readonly string[];
  selfCheck: readonly string[];
}

/**
 * Three deliberately bounded visual contracts. Platform state colors keep one
 * meaning across all profiles; personality comes from material, typography and
 * one signature, not from randomly recoloring controls.
 */
export const DESIGN_VISUAL_PROFILES: Readonly<Record<DesignVisualProfileId, DesignVisualProfile>> =
  {
    'calm-editorial': {
      id: 'calm-editorial',
      name: 'Calm Editorial',
      suitedFor: ['研究与分析报告', '审计与评审', '知识文档', '专业方案与简报'],
      signature: '暖纸画布上的细墨色分隔线，并只在标题或章节序号旁使用一条短陶土红竖线。',
      tokens: {
        canvas: '#F7F4ED',
        surface: '#FFFDF8',
        surfaceMuted: '#F1ECE2',
        ink: '#1F1D18',
        inkMuted: '#69645B',
        accent: '#A64F35',
        accentSoft: '#F1DDD4',
        success: '#2F6B4F',
        warning: '#946A24',
        danger: '#9A4038',
        border: '#D8D1C5',
        focus: '#315F7D',
        headingFont: '"Songti SC", "Noto Serif CJK SC", Georgia, serif',
        bodyFont: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        monoFont: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        radiusSmall: '4px',
        radiusMedium: '8px',
        radiusLarge: '12px',
        shadow: '0 10px 28px rgba(42, 35, 28, 0.06)',
        spacingUnit: '8px',
      },
      bannedPatterns: [
        '纯黑或纯白作为大面积背景',
        '渐变、霓虹、玻璃拟态或发光描边',
        '把报告强行排成 KPI Dashboard 或 Bento 卡片墙',
        '粗重阴影、超过 12px 的普遍圆角或大段全粗体',
        '用多个强调色区分普通内容',
      ],
      selfCheck: [
        '标题、正文、说明文字只靠字号、字重和留白建立三级层级',
        '主操作只使用 accent；成功、等待、失败只使用固定语义色',
        '正文行长在桌面端不超过 76 个中文字符，移动端无横向滚动',
        '签名竖线只出现于一个关键标题或章节标记，不重复装饰',
      ],
    },
    'soft-utility': {
      id: 'soft-utility',
      name: 'Soft Utility',
      suitedFor: ['任务工具', '表单与工作流', '自动化助手', '巡检、计划与跟踪'],
      signature:
        '核心任务放在一张双层软边工作卡中：外层承载上下文，内层只承载输入、主操作与真实状态。',
      tokens: {
        canvas: '#F3F0EA',
        surface: '#FCFAF6',
        surfaceMuted: '#ECE7DE',
        ink: '#20201D',
        inkMuted: '#6C6962',
        accent: '#B5573B',
        accentSoft: '#F3DED5',
        success: '#2F6B4F',
        warning: '#946A24',
        danger: '#9A4038',
        border: '#D8D2C8',
        focus: '#315F7D',
        headingFont: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        bodyFont: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        monoFont: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        radiusSmall: '8px',
        radiusMedium: '14px',
        radiusLarge: '20px',
        shadow: '0 14px 34px rgba(45, 38, 31, 0.08)',
        spacingUnit: '8px',
      },
      bannedPatterns: [
        '把整个页面拆成等权 Bento 卡片',
        '大面积渐变、漂浮彩色 blob 或玻璃拟态',
        '每个按钮都使用填充色或胶囊形',
        '用装饰性动画代替运行状态',
        '在页面里伪造进度、结果、耗时或模型状态',
      ],
      selfCheck: [
        '首屏能在五秒内识别输入、唯一主操作和结果承载区',
        '普通信息使用中性色；只有主操作与平台语义状态有颜色',
        '等待态保持表单和上下文可见，不遮挡整个页面',
        '双层工作卡只出现一次，其余区域使用平面分组与细边框',
      ],
    },
    'gentle-story': {
      id: 'gentle-story',
      name: 'Gentle Story',
      suitedFor: ['创作者与 KOL 内容', '生活方式与穿搭', '个人成长叙事', '社交卡片与故事型交付'],
      signature:
        '每个主要章节使用一个小号衬线序号签，配一块 accentSoft 淡陶土纸片作为唯一叙事标记。',
      tokens: {
        canvas: '#FFF7F0',
        surface: '#FFFCF8',
        surfaceMuted: '#F5EDE5',
        ink: '#2A2420',
        inkMuted: '#756B65',
        accent: '#B45540',
        accentSoft: '#F7DDD3',
        success: '#2F6B4F',
        warning: '#946A24',
        danger: '#9A4038',
        border: '#E6D8CE',
        focus: '#315F7D',
        headingFont: '"Songti SC", "Noto Serif CJK SC", Georgia, serif',
        bodyFont: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        monoFont: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        radiusSmall: '8px',
        radiusMedium: '14px',
        radiusLarge: '18px',
        shadow: '0 12px 30px rgba(77, 56, 43, 0.07)',
        spacingUnit: '8px',
      },
      bannedPatterns: [
        '同时使用三种以上 pastel 强调色',
        '用 emoji、贴纸、手绘涂鸦堆砌可爱感',
        '糖果渐变、玻璃拟态、荧光色或高饱和大色块',
        '把专业信息改写成营销口号或虚构用户故事',
        '所有卡片都使用超大圆角和悬浮阴影',
      ],
      selfCheck: [
        '故事感来自章节节奏、标题排版和真实内容，不来自装饰堆叠',
        '序号签与淡陶土纸片只承担章节定位，不承担成功或失败状态',
        '主操作仍只使用 accent；语义状态色与其他 profile 完全一致',
        '移动端保持内容顺序、完整文本和至少 44px 的主要触控目标',
      ],
    },
  };

export interface DesignVisualProfileContext {
  capabilityName?: string;
  tagline?: string;
  description?: string;
  inputLabels?: readonly string[];
  /** 当前 Capability 的 kind；只对 text/structured/checklist 做稳定加权，其余值不猜测。 */
  outputType?: string;
  taskText?: string;
  /** Internal policy/test escape hatch; the normal product flow recommends automatically. */
  explicitProfile?: DesignVisualProfileId;
}

export const DESIGN_STUDIO_BOOTSTRAP_MARKER = '[COMBO_AUTO_UI_BOOTSTRAP]';

const PROFILE_SIGNALS: Readonly<Record<DesignVisualProfileId, readonly RegExp[]>> = {
  'calm-editorial': [
    /报告|文档|研究|分析|审计|评审|简报|方案|洞察|知识|专业|克制|editorial|report|audit|research/i,
    /对比|诊断|总结|复盘|评估|策略|说明书|白皮书/i,
  ],
  'soft-utility': [
    /工具|助手|表单|工作台|任务|流程|自动化|巡检|计划|追踪|清单|操作台|控制台/i,
    /workflow|automation|utility|dashboard|planner|tracker|checklist/i,
  ],
  'gentle-story': [
    /小红书|社交|博主|KOL|穿搭|生活方式|个人成长|重启人生|叙事|故事|创作者/i,
    /温柔|亲和|可爱|杂志感|story|lifestyle|creator|social|fashion/i,
  ],
};

const VISUAL_LANGUAGE_TERMS =
  /视觉(?:语言|体系|设计)?|设计语言|UI\s*风格|风格|主题|配色(?:体系|方案)?|look\s*and\s*feel|theme|style/i;
const VISUAL_DIRECTION_TERMS =
  /可爱|温柔|亲和|克制|专业|编辑感|杂志(?:感|风)|故事感|叙事感|生活方式|极简|简约|沉稳|活泼|柔和|深色|浅色|明亮|暗色|editorial|utility|story|lifestyle/i;
const GENERIC_STYLE_DIRECTION = /[A-Za-z0-9\u3400-\u9fff-]{1,16}风(?:格)?/i;
const WHOLE_PAGE_SCOPE =
  /整体|整个页面|全页面|整页|全局|全站|全套|全面|重新设计|重新包装|重做|换一套|统一(?:一下|成|为)?/i;
const CHANGE_INTENT = /改成|改得|换成|切换|调整|变成|采用|重塑|重新设计|统一/i;
const LOCAL_ELEMENT_SCOPE =
  /按钮|输入框|表单|标题|副标题|文案|间距|边距|字号|字重|图标|卡片|组件|区块|导航|页脚|这一处|这块|这个元素|单个|某个/i;
const PRESERVES_VISUAL_LANGUAGE =
  /(?:保持|沿用)(?:现在|当前|原有|现有)?(?:的)?(?:风格|配色|视觉(?:语言|体系)?|设计语言)|不(?:要)?(?:改|改变|换|更换|切换)(?:现在|当前|原有|现有)?(?:的)?(?:风格|配色|视觉(?:语言|体系)?|设计语言)|(?:现在|当前|原有|现有)(?:的)?(?:风格|配色|视觉(?:语言|体系)?|设计语言)(?:保持|维持)?不变/i;

/**
 * A full profile is a page-level decision, not a per-message decoration.
 * Local requests such as “把按钮改得更圆” must keep the existing language.
 */
export function requestsWholeVisualRestyle(taskText: string | null | undefined): boolean {
  const text = taskText?.trim() ?? '';
  if (!text) return false;
  if (text.includes(DESIGN_STUDIO_BOOTSTRAP_MARKER)) return true;
  if (PRESERVES_VISUAL_LANGUAGE.test(text)) return false;

  const hasLocalTarget = LOCAL_ELEMENT_SCOPE.test(text);
  const hasWholePageScope = WHOLE_PAGE_SCOPE.test(text);
  const hasVisualLanguage = VISUAL_LANGUAGE_TERMS.test(text);
  const hasVisualDirection = VISUAL_DIRECTION_TERMS.test(text);
  const hasGenericStyleDirection = GENERIC_STYLE_DIRECTION.test(text);
  const hasChangeIntent = CHANGE_INTENT.test(text);

  if (hasLocalTarget && !hasWholePageScope) return false;
  if (hasWholePageScope) {
    return (
      hasVisualDirection || (hasChangeIntent && (hasVisualLanguage || hasGenericStyleDirection))
    );
  }
  return (
    !hasLocalTarget &&
    (hasVisualDirection || (hasChangeIntent && (hasVisualLanguage || hasGenericStyleDirection)))
  );
}

function signalScore(text: string, profile: DesignVisualProfileId): number {
  return PROFILE_SIGNALS[profile].reduce((score, signal) => {
    const flags = signal.flags.includes('g') ? signal.flags : `${signal.flags}g`;
    return score + (text.match(new RegExp(signal.source, flags))?.length ?? 0);
  }, 0);
}

/**
 * Recommend the first-page baseline without asking the user to choose.
 * Only frozen capability metadata participates; generated bootstrap copy and
 * later user requests must not bias the baseline profile.
 * Ties intentionally fall back to Calm Editorial.
 */
export function recommendDesignVisualProfile(
  context: DesignVisualProfileContext = {},
): DesignVisualProfile {
  if (context.explicitProfile) return DESIGN_VISUAL_PROFILES[context.explicitProfile];

  const capabilityText = [
    context.capabilityName,
    context.tagline,
    context.description,
    ...(context.inputLabels ?? []),
  ]
    .filter(Boolean)
    .join('\n');
  const scores: Record<DesignVisualProfileId, number> = {
    'calm-editorial': signalScore(capabilityText, 'calm-editorial'),
    'soft-utility': signalScore(capabilityText, 'soft-utility'),
    'gentle-story': signalScore(capabilityText, 'gentle-story'),
  };

  const hasCapabilitySignal = DESIGN_VISUAL_PROFILE_IDS.some((id) => scores[id] > 0);
  if (context.outputType === 'text' && !hasCapabilitySignal) scores['calm-editorial'] += 1;
  if (context.outputType === 'structured' || context.outputType === 'checklist') {
    scores['soft-utility'] += 1;
  }

  let selected: DesignVisualProfileId = 'calm-editorial';
  for (const id of DESIGN_VISUAL_PROFILE_IDS) {
    if (scores[id] > scores[selected]) selected = id;
  }
  return DESIGN_VISUAL_PROFILES[selected];
}

function tokenLines(tokens: DesignVisualTokens): string[] {
  return Object.entries(tokens).map(([key, value]) => `- ${key}: ${value}`);
}

/** Render a concrete, copy-safe contract for the model's internal CSS work. */
export function designVisualProfilePrompt(profile: DesignVisualProfile): string {
  return [
    '# 本轮 Artifact 视觉合同（必须落实，用户无需选择）',
    `Profile：${profile.name}（${profile.id}）`,
    `适用：${profile.suitedFor.join('、')}`,
    `唯一视觉签名：${profile.signature}`,
    '',
    '## 精确 Design Tokens',
    ...tokenLines(profile.tokens),
    '',
    '以上 token 必须定义为 :root CSS 变量并复用；不得自行新增第二套主色、状态色、间距基线或圆角体系。',
    '字体必须采用上述 CJK-first 系统回退栈，不得依赖需要私有鉴权的字体或资源。',
    '',
    '## 禁止模式',
    ...profile.bannedPatterns.map((item) => `- ${item}`),
    '',
    '## 提交前静默自检',
    ...profile.selfCheck.map((item) => `- ${item}`),
    '- 所有展示内容来自用户真实输入或真实 Runtime；无 mock、样例结果或虚构数据。',
    '- 页面保留 combo:run bridge、稳定 data-combo-key、键盘焦点和可读对比度。',
    '- 正文、按钮文字与其背景的对比度至少为 4.5:1，焦点轮廓必须持续可见。',
    '',
    '在调用 upsert_artifact 前逐项自检；不要把 profile 名称、token 表或自检清单展示给终端用户。',
  ].join('\n');
}
