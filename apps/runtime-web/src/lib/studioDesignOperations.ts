export const STUDIO_DESIGN_OPERATIONS = [
  {
    id: 'critique',
    label: '检查并修好',
    description: '找出最影响使用的 1–3 个问题',
    instruction:
      '这不是一份评审报告。请静默检查当前页面的任务路径、信息层级、认知负担、反馈和产品辨识度，选出最影响使用的 1–3 个问题并直接修复。保留 Agent 能力合同、真实运行方式、现有 Design Tokens、稳定 data-combo-key 和未被点名的区域。',
    localInstruction:
      '这不是一份评审报告。请只检查当前选中区域内部的层级、可读性、反馈和辨识度，选出最影响使用的 1–2 个问题并直接修复。不得借此重排、换色或重写页面其它区域。',
  },
  {
    id: 'clarify',
    label: '理清重点',
    description: '让输入、主操作和结果一眼可见',
    instruction:
      '请收敛当前页面的视觉和信息层级，让真实输入、唯一主操作、运行状态与结果成为清楚的任务路径。移除重复说明、同权重区块、套娃卡片和无意义装饰，但不要删掉必要功能或改变 Agent 的业务边界。',
    localInstruction:
      '请只理清当前选中区域内部的信息层级，让它的标题、内容与操作关系更直接。可移除该区域内的重复说明和无意义装饰，但不得移动、删除或改写其它页面区域。',
  },
  {
    id: 'harden',
    label: '补全状态',
    description: '检查异常、长内容和小屏使用',
    instruction:
      '请加固当前页面的真实使用状态：空状态、已提交或加载中、错误、成功、长文本、360px 窄屏和键盘操作都要清楚可用。状态必须说明正在发生什么和下一步做什么，不得使用定时器、随机数、mock 或硬编码结果伪造能力执行。',
    localInstruction:
      '请只加固当前选中控件或区域相关的真实状态与可用性：长内容、窄屏、键盘焦点以及适用的空、等待、错误或成功反馈要清楚。不得使用模拟结果，也不得改动其它页面区域。',
  },
  {
    id: 'polish',
    label: '最终润色',
    description: '统一排版、间距、色彩角色与反馈',
    instruction:
      '请对当前页面做一次克制的最终润色：统一字体层级、间距节奏、对齐、色彩角色、边框、圆角、焦点和交互反馈。保留现有视觉身份与功能结构，不增加新的主色、装饰性渐变、发光、套娃卡片或无意义标签。',
    localInstruction:
      '请只润色当前选中区域的字体层级、间距、对齐、色彩角色、边框、圆角、焦点和交互反馈。沿用页面现有视觉身份，不新增主色或装饰，也不改变其它区域。',
  },
] as const;

export type StudioDesignOperationId = (typeof STUDIO_DESIGN_OPERATIONS)[number]['id'];
export type StudioDesignOperation = (typeof STUDIO_DESIGN_OPERATIONS)[number];

const OPERATION_PREFIX = '[COMBO_DESIGN_OPERATION:';
const OPERATION_PATTERN = /^\[COMBO_DESIGN_OPERATION:([a-z-]+)]\n([\s\S]+)$/;

export function buildStudioDesignOperationPrompt(
  operation: StudioDesignOperation,
  scope: 'page' | 'element' = 'page',
): string {
  const instruction = scope === 'element' ? operation.localInstruction : operation.instruction;
  return `${OPERATION_PREFIX}${operation.id}]\n${instruction}`;
}

/** Keep internal operation routing out of the creator-facing conversation. */
export function formatStudioDesignOperationMessage(value: string): string | null {
  const match = value.match(OPERATION_PATTERN);
  if (!match) return null;
  const operation = STUDIO_DESIGN_OPERATIONS.find((item) => item.id === match[1]);
  if (!operation || !match[2]?.trim()) return null;
  return `设计操作「${operation.label}」`;
}
