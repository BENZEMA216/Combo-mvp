// 公开页 mock 数据层。后端目前没有公开能力视图 / 创作者主页接口，这里在前端
// 数据层面 mock：函数签名按真实接口的形状写（异步 + 未命中抛错），后端补上后
// 只需把实现换成 fetch，页面组件不用动。数据是写死的演示 fixture，不发任何请求。

import {
  isPricingComplete,
  isValidReleaseHandle,
  pricingLabel,
  readReleaseDraft,
} from '../release/releaseDraft.js';

/** 公开能力视图（对外只读：无 instructions 等创作者私有字段）。 */
export interface PublicCapabilityView {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  inputs: { fields: PublicInputField[] };
  starterPrompts: string[];
  boundaries: { redLines: string[] };
  /** 当前设备上的发布页草稿预览，不是服务端公开页。 */
  localPreview?: {
    capabilityId: string;
    pricing: string;
  };
}

export interface PublicInputField {
  key: string;
  label: string;
  type: 'string' | 'text' | 'number' | 'enum';
  required: boolean;
}

/** 公开创作者主页聚合（身份区 / 指标带 / 能力网络缩略 / 作品墙）。 */
export interface PublicCreatorProfile {
  slug: string;
  hero: {
    displayName: string;
    avatarUrl: string | null;
    identityTags: string[];
    bio: string;
    social: { following: number; followers: number; likes: number };
  };
  metrics: {
    capabilityCount: number;
    domainCount: number;
    totalInvocations: number;
    hottestTopic: string;
  };
  network: {
    nodes: { capabilityId: string; name: string; size: number; isCenter: boolean }[];
    edges: { source: string; target: string }[];
  };
  works: { capabilityId: string; slug: string; name: string; invocations: number }[];
}

const MOCK_CAPABILITIES: PublicCapabilityView[] = [
  {
    slug: 'cap-wskatc',
    name: '真实长会话能力提取评审',
    tagline: '把一段真实工作会话变成可复用、可试用的能力项。',
    description:
      '基于创作者对真实 session 聚类质量、泛任务过滤和发布边界的连续讨论沉淀而成。' +
      '给它一段候选能力的描述与支撑材料，它会判断这个能力是否独特、利他、可运行，并给出改进建议。',
    inputs: {
      fields: [
        { key: 'candidate_name', label: '候选能力名称', type: 'string', required: true },
        { key: 'evidence', label: '支撑材料（会话摘录）', type: 'text', required: true },
        { key: 'target_audience', label: '目标用户', type: 'string', required: false },
      ],
    },
    starterPrompts: [
      '帮我评审这个候选能力是否值得发布。',
      '这个能力和市面上的通用助手有什么差别？',
      '给出三条让这个能力更聚焦的修改建议。',
    ],
    boundaries: {
      redLines: [
        '只基于提供的材料评审，材料之外的事实按证据不足处理。',
        '不生成、不猜测创作者的私有会话内容。',
        '评审结论仅供参考，发布决定权在创作者。',
      ],
    },
  },
  {
    slug: 'cap-brand-refresh',
    name: 'Figma 到前端的品牌刷新',
    tagline: '把新品牌系统落进已有产品界面，输出结构、状态与实现要点。',
    description:
      '来自一次完整的品牌换代实施记录：设计令牌换代、品牌组件、壳层与登录闸门的逐项迁移。' +
      '给它当前界面截图或描述加上新品牌规范，它会输出可执行的改造清单。',
    inputs: {
      fields: [
        { key: 'brand_spec', label: '新品牌规范（链接或描述）', type: 'text', required: true },
        { key: 'scope', label: '改造范围', type: 'enum', required: false },
      ],
    },
    starterPrompts: ['帮我把这套品牌规范落到现有页面上。', '先只换配色和字体，给我最小改动清单。'],
    boundaries: {
      redLines: [
        '不直接修改设计源文件，只输出实施方案。',
        '配色对比度不达标时会明确指出而不是照做。',
      ],
    },
  },
];

const MOCK_CREATORS: PublicCreatorProfile[] = [
  {
    slug: 'gw61jgf0fij4',
    hero: {
      displayName: 'Daniel',
      avatarUrl: null,
      identityTags: ['创作者', '后端工程', '流程设计'],
      bio: '把真实工作会话里的经验提炼成别人能直接用的能力。',
      social: { following: 12, followers: 486, likes: 2130 },
    },
    metrics: {
      capabilityCount: 6,
      domainCount: 3,
      totalInvocations: 1284,
      hottestTopic: '能力提取',
    },
    network: {
      nodes: [
        { capabilityId: 'n1', name: '能力提取评审', size: 6, isCenter: true },
        { capabilityId: 'n2', name: '品牌刷新', size: 4, isCenter: false },
        { capabilityId: 'n3', name: '测试闭环', size: 3, isCenter: false },
        { capabilityId: 'n4', name: '文档人话化', size: 2, isCenter: false },
        { capabilityId: 'n5', name: '发布边界评审', size: 2, isCenter: false },
      ],
      edges: [
        { source: 'n1', target: 'n2' },
        { source: 'n1', target: 'n3' },
        { source: 'n1', target: 'n5' },
        { source: 'n2', target: 'n4' },
      ],
    },
    works: [
      { capabilityId: 'n1', slug: 'cap-wskatc', name: '真实长会话能力提取评审', invocations: 512 },
      {
        capabilityId: 'n2',
        slug: 'cap-brand-refresh',
        name: 'Figma 到前端的品牌刷新',
        invocations: 347,
      },
    ],
  },
];

/** 模拟网络延迟（让骨架屏可见，接近真实接口体感）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchPublicCapability(slug: string): Promise<PublicCapabilityView> {
  await delay(300);
  const hit = MOCK_CAPABILITIES.find((c) => c.slug === slug);
  if (!hit) throw new Error(`公开能力不存在：${slug}`);
  return hit;
}

/**
 * 把完整的本机发布草稿投影成一张可视化公开页。
 * 这个分支不会注册域名，也不会将草稿暴露给其他设备。
 */
export async function fetchLocalReleasePreview(
  slug: string,
  capabilityId: string,
): Promise<PublicCapabilityView> {
  await delay(120);
  const draft = readReleaseDraft(capabilityId);
  if (draft.handle !== slug || !isValidReleaseHandle(draft.handle) || !isPricingComplete(draft)) {
    throw new Error('这台设备上没有找到完整的发布草稿。');
  }

  return {
    slug,
    name: draft.agentName,
    tagline: '把你反复做的工作，变成别人可以直接使用的 Agent。',
    description:
      draft.agentSummary ?? '这是从真实工作上下文中提取，并在 Combo Studio 中调整过的 Agent。',
    inputs: {
      fields: [
        { key: 'goal', label: '这次想完成的任务', type: 'text', required: true },
        { key: 'context', label: '必要的背景或材料', type: 'text', required: false },
        { key: 'expectation', label: '对结果的要求', type: 'text', required: false },
      ],
    },
    starterPrompts: [
      `帮我用「${draft.agentName}」完成一个真实任务。`,
      '先问我必要的背景，再给出可直接使用的结果。',
      '根据我的反馈继续修改，直到结果可用。',
    ],
    boundaries: {
      redLines: [
        '当前页面只是这台设备上的发布效果预览。',
        '定价尚未连接计费系统，预览不会产生费用。',
        '计划公开地址尚未注册，不能在其他设备上访问。',
      ],
    },
    localPreview: {
      capabilityId,
      pricing: pricingLabel(draft),
    },
  };
}

export async function fetchPublicCreator(slug: string): Promise<PublicCreatorProfile> {
  await delay(300);
  const hit = MOCK_CREATORS.find((c) => c.slug === slug);
  if (!hit) throw new Error(`创作者主页不存在：${slug}`);
  return hit;
}
