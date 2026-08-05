// Test 环境的固定 Combo Miniapp 能力夹具。
// 它只用于打通创作者的「结果 -> 调试 -> 定价 -> 发布」体验，不伪装成真实提取结果。
import { randomBytes } from 'node:crypto';
import { CapabilityDefinitionSchema, type CapabilityDefinition } from '@cb/shared';

export const COMBO_MINIAPP_DEMO_KEY = 'combo-miniapp';
export const COMBO_MINIAPP_DEMO_VERSION = 1;
export const COMBO_MINIAPP_DEMO_NAME = 'Combo Miniapp 设计助手';
export const COMBO_MINIAPP_DEMO_MARKER = {
  source: 'test-demo',
  fixture: COMBO_MINIAPP_DEMO_KEY,
  fixtureVersion: COMBO_MINIAPP_DEMO_VERSION,
} as const;

/**
 * 生成与数据库 gen_uuid_v7() 同序的 UUID v7。首次 seed 使用新 ID；后续请求先按受控
 * idempotency + marker 回读原 ID，既保持幂等，也不破坏列表按 UUID v7 倒序分页的约定。
 */
export function newDemoSeedId(nowMs = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(nowMs);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function comboMiniappDefinition(): CapabilityDefinition {
  return CapabilityDefinitionSchema.parse({
    version: 1,
    name: COMBO_MINIAPP_DEMO_NAME,
    summary: '把一段产品想法包装成可交互、可继续修改的 Miniapp。',
    kind: '产品设计',
    instructions: [
      '你是 Combo Miniapp 设计助手。',
      '先理解用户的目标、受众、输入和期望产物，再生成一个自包含、可交互的 HTML Miniapp。',
      '保持任务能力与业务边界不变；视觉层级清楚，默认适配桌面与手机。',
      '用户可以反复提出内容、交互或视觉修改；每次修改都要保留可工作的主路径。',
      '不要输出解释性 JSON 或检查清单作为最终页面，最终产物必须是可以直接体验的界面。',
    ].join('\n'),
    inputs: [
      {
        key: 'productBrief',
        label: '你想做什么 Miniapp？',
        type: 'text',
        required: true,
      },
      {
        key: 'audience',
        label: '谁会使用它？',
        type: 'string',
        required: false,
      },
      {
        key: 'style',
        label: '偏好的视觉方向',
        type: 'enum',
        required: false,
        options: ['编辑感', '极简', '活泼', '专业'],
      },
    ],
    starterPrompts: [
      '把我的产品想法做成一个可以直接操作的 Miniapp',
      '先生成一个清晰的桌面版，再检查手机适配',
      '保留功能不变，帮我重新整理视觉层级和文案',
    ],
    meta: {
      ...COMBO_MINIAPP_DEMO_MARKER,
      editable: true,
      sampleOnly: true,
    },
  });
}
