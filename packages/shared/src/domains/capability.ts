// 能力项域：提取产出的可运行体。发布是它身上的标记，不是任务状态。
// CapabilityDefinition 是生产端与试用端之间唯一的契约缝：
// 生产端（提取流水线）把它写进 MinIO，试用端按 storage_key 读出并注入 agent。
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from '../core/ids.js';

// ---------- 对外视图（库里那行轻量索引）----------
export const CapabilityViewSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  name: z.string(),
  summary: z.string(),
  kind: z.string(),
  published: z.boolean(),
  publishedAt: IsoDateTimeSchema.optional(),
  shareToken: z.string().optional(),
  createdAt: IsoDateTimeSchema,
});
export type CapabilityView = z.infer<typeof CapabilityViewSchema>;

// ---------- 可运行定义（MinIO 里的完整对象）----------
/**
 * 试用开场表单的一个输入字段（提取时由 LLM 建议）。
 * type：string 单行文本 / text 多行文本 / number 数字 / enum 从 options 里单选。
 */
export const CapabilityInputFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['string', 'text', 'number', 'enum']),
  required: z.boolean().default(false),
  /** 仅 type=enum 时使用的候选项。 */
  options: z.array(z.string().min(1)).optional(),
});
export type CapabilityInputField = z.infer<typeof CapabilityInputFieldSchema>;

/**
 * 能力项的完整可运行定义。version 字段留给格式演进：试用端遇到不认识的版本
 * 直接报「能力格式过新，请升级」而不是猜着解析。
 */
export const CapabilityDefinitionSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  summary: z.string(),
  kind: z.string(),
  /** 注入试用 agent 的系统提示词：这个能力「怎么干活」的全部知识。 */
  instructions: z.string().min(1),
  /** 试用开场表单字段（可为空：表单退化为只有一个自由输入框）。 */
  inputs: z.array(CapabilityInputFieldSchema).default([]),
  /** 开场提示语（试用页一键填入的起手句）。 */
  starterPrompts: z.array(z.string().min(1)).default([]),
  /** 附加元信息（提取时的统计、示例等），结构随需要演进。 */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;

/** 创作者审阅能力时读取的完整不可变定义与摘要，Codex 组装 Agent 前使用。 */
export const CapabilityDetailSchema = z
  .object({
    capability: CapabilityViewSchema,
    definition: CapabilityDefinitionSchema,
    definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CapabilityDetail = z.infer<typeof CapabilityDetailSchema>;

// ---------- 发布 ----------
export const PublishResultSchema = z.object({
  id: IdSchema,
  published: z.boolean(),
  publishedAt: IsoDateTimeSchema.optional(),
  shareToken: z.string().optional(),
});
export type PublishResult = z.infer<typeof PublishResultSchema>;
