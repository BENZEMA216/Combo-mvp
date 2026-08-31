// 试用域：会话 / 消息 / 产物的对外形态（runtime 服务的 HTTP 契约）。
// 消息 content 存 pi agent 的原生消息格式；它的严格 schema 校验在 runtime 侧
// （runtime 依赖 pi 包，对齐其类型），共享层只做「是数组」的形状约束透传。
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from '../core/ids.js';
import { CapabilityInputFieldSchema } from './capability.js';
import {
  AgentBindingSchema,
  KnowledgeTurnResultSchema,
  knowledgeBindingsEqual,
} from './knowledge.js';

export const SessionStatusSchema = z.enum(['active', 'closed']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * consume：用户运行 Agent 完成真实任务；studio：创作者反复修改这个 Agent 的 Miniapp。
 * 两种会话复用同一套消息、产物与流式运行时，但提示词与列表入口必须彼此隔离。
 */
export const SessionModeSchema = z.enum(['consume', 'studio']);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const MessageRoleSchema = z.enum(['user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageStatusSchema = z.enum(['completed', 'failed']);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

// ---------- 请求 ----------
export const CreateSessionBodySchema = z.object({ capabilityId: IdSchema }).strict();
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

/** Studio 使用独立端点，避免客户端伪造 mode 把普通试用切进设计提示词。 */
export const CreateStudioSessionBodySchema = z.object({ capabilityId: IdSchema }).strict();
export type CreateStudioSessionBody = z.infer<typeof CreateStudioSessionBodySchema>;

export const SESSION_TITLE_MAX_LENGTH = 60;
export const UpdateSessionBodySchema = z
  .object({
    title: z.string().trim().min(1).max(SESSION_TITLE_MAX_LENGTH),
  })
  .strict();
export type UpdateSessionBody = z.infer<typeof UpdateSessionBodySchema>;

/** 浏览器为一次真实任务生成并在网络重试时复用的幂等标识。 */
export const UsageIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export type UsageId = z.infer<typeof UsageIdSchema>;

export const SendMessageBodySchema = z
  .object({
    text: z.string().min(1).max(20_000),
    usageId: UsageIdSchema,
  })
  .strict();
export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;

const CentsStringSchema = z.string().regex(/^(0|[1-9]\d*)$/);

/** 免费额度耗尽且可用余额不足时，发消息端点返回的 HTTP 402 业务响应。 */
export const RechargeRequiredBodySchema = z
  .object({
    rechargeRequired: z.literal(true),
    /** 与被阻止的 usageId 相同，供充值后继续原任务。 */
    rechargeIntentId: UsageIdSchema,
    balanceCents: CentsStringSchema,
    requiredCents: CentsStringSchema,
  })
  .strict();
export type RechargeRequiredBody = z.infer<typeof RechargeRequiredBodySchema>;

// ---------- 视图 ----------
export const SessionViewSchema = z.object({
  id: IdSchema,
  capabilityId: IdSchema,
  /** 旧客户端可不传；runtime 返回的新响应始终包含。 */
  mode: SessionModeSchema.optional(),
  title: z.string().optional(),
  status: SessionStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const StudioSessionViewSchema = SessionViewSchema.extend({
  mode: z.literal('studio'),
});
export type StudioSessionView = z.infer<typeof StudioSessionViewSchema>;

export const StudioSessionEntrySchema = z.object({
  session: StudioSessionViewSchema,
});
export type StudioSessionEntry = z.infer<typeof StudioSessionEntrySchema>;

export const MessageViewSchema = z.object({
  id: IdSchema,
  seq: z.number().int(),
  /** 同一轮 user / assistant / tool 消息的稳定归组标识；历史消息可能没有。 */
  turnId: IdSchema.optional(),
  role: MessageRoleSchema,
  /** pi 原生分块内容（文本/工具调用/工具结果块数组），严格校验在 runtime 侧。 */
  content: z.array(z.unknown()),
  status: MessageStatusSchema,
  createdAt: IsoDateTimeSchema,
});
export type MessageView = z.infer<typeof MessageViewSchema>;

export const ArtifactViewSchema = z.object({
  id: IdSchema,
  kind: z.string(),
  title: z.string().optional(),
  /** 从 Agent 当前 UI 克隆到新会话的快照来源；普通 revision 不带。 */
  sourceArtifactId: IdSchema.optional(),
  /** 产生这份产物的 Turn；能力 UI 种子副本没有来源 Turn。 */
  sourceTurnId: IdSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ArtifactView = z.infer<typeof ArtifactViewSchema>;

export const ActiveTurnViewSchema = z.object({
  id: IdSchema,
  createdAt: IsoDateTimeSchema,
});
export type ActiveTurnView = z.infer<typeof ActiveTurnViewSchema>;

export const TerminalTurnStatusSchema = z.enum(['completed', 'failed', 'interrupted']);
export type TerminalTurnStatus = z.infer<typeof TerminalTurnStatusSchema>;

/**
 * Turn 的 owner 可见安全诊断码。Runtime 只会返回这个固定集合；数据库中的
 * last_error.message、未知历史 code 和模型/provider 原始错误绝不进入 HTTP 响应。
 */
export const TerminalTurnErrorCodeSchema = z.enum([
  'TURN_ABANDONED',
  'TURN_HISTORY_LOAD_FAILED',
  'TURN_AGENT_UNAVAILABLE',
  'TURN_IDLE_TIMEOUT',
  'TURN_PROMPT_FAILED',
  'TURN_RUNTIME_ERROR',
  'TURN_PERSIST_FAILED',
  'TURN_INTERRUPTED',
  'TURN_SHUTDOWN',
  'TURN_STUDIO_ARTIFACT_MISSING',
  'TURN_FAILED',
]);
export type TerminalTurnErrorCode = z.infer<typeof TerminalTurnErrorCodeSchema>;

export const TerminalTurnViewSchema = z.discriminatedUnion('status', [
  z
    .object({
      id: IdSchema,
      status: z.literal('completed'),
      errorCode: z.null(),
    })
    .strict(),
  z
    .object({
      id: IdSchema,
      status: z.literal('failed'),
      errorCode: TerminalTurnErrorCodeSchema,
    })
    .strict(),
  z
    .object({
      id: IdSchema,
      status: z.literal('interrupted'),
      errorCode: TerminalTurnErrorCodeSchema,
    })
    .strict(),
]);
export type TerminalTurnView = z.infer<typeof TerminalTurnViewSchema>;

/** 会话详情：一次请求把聊天流和画布恢复出来所需的全部。 */
export const SessionDetailSchema = z
  .object({
    session: SessionViewSchema,
    capability: z.object({
      id: IdSchema,
      name: z.string(),
      summary: z.string(),
      kind: z.string(),
      /** 开场表单字段与提示语，来自 MinIO 里的能力定义（定义读不出时为空数组，页面退化为自由输入）。 */
      inputs: z.array(CapabilityInputFieldSchema),
      starterPrompts: z.array(z.string()),
    }),
    messages: z.array(MessageViewSchema),
    artifacts: z.array(ArtifactViewSchema),
    /** PostgreSQL 中仍在运行的 Turn；页面刷新后据此恢复运行态，再由 SSE 补齐事件。 */
    activeTurn: ActiveTurnViewSchema.nullable(),
    /**
     * 最近一次 PostgreSQL 已提交终态。字段保持 optional 以兼容旧 Runtime；新 Runtime
     * 始终返回。只含安全状态与 allowlist code，用于刷新后及时识别失败而非空等超时。
     */
    latestTerminalTurn: TerminalTurnViewSchema.nullable().optional(),
    /**
     * Studio 返回会话内与 Agent 生效 UI 对应的 artifact；consume 返回创建会话时
     * 冻结的 UI 副本 id。没有唯一可确认副本时为 null；字段缺失时前端安全降级。
     */
    currentUiArtifactId: IdSchema.nullable().optional(),
    /** 新 Runtime 明确返回的产品绑定；缺失仅表示滚动期旧 Runtime 响应。 */
    agentBinding: AgentBindingSchema.optional(),
    /** 知识会话的权威回答/引用/计费投影；空会话仍必须返回空数组。 */
    knowledgeResults: z.array(KnowledgeTurnResultSchema).optional(),
  })
  .superRefine((detail, context) => {
    const binding = detail.agentBinding;
    if (binding === undefined) {
      if (detail.knowledgeResults !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['knowledgeResults'],
          message: 'Knowledge results require an explicit knowledge binding',
        });
      }
      return;
    }
    if (binding.productKind === 'legacy_capability') {
      if (detail.knowledgeResults !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['knowledgeResults'],
          message: 'Legacy Sessions cannot expose knowledge results',
        });
      }
      return;
    }

    if (detail.knowledgeResults === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['knowledgeResults'],
        message: 'Knowledge Sessions must return a result collection',
      });
      return;
    }
    if (
      detail.session.mode !== 'consume' ||
      detail.session.capabilityId !== binding.capability.id ||
      detail.capability.id !== binding.capability.id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentBinding', 'capability', 'id'],
        message: 'Knowledge binding must match the consume Session and Capability',
      });
    }
    if (detail.messages.some((message) => message.role !== 'user')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messages'],
        message: 'Knowledge Session messages may expose only user input',
      });
    }

    const receiptIds = new Set<string>();
    const usageIds = new Set<string>();
    const turnIds = new Set<string>();
    const responseMessageIds = new Set<string>();
    const sourceLabels = new Map<string, string>();
    const chunkSources = new Map<string, string>();
    for (const [index, result] of detail.knowledgeResults.entries()) {
      if (!knowledgeBindingsEqual(binding, result.binding)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['knowledgeResults', index, 'binding'],
          message: 'Knowledge result binding must equal the frozen Session binding',
        });
      }
      for (const [field, seen, value] of [
        ['receiptId', receiptIds, result.receiptId],
        ['usageId', usageIds, result.usageId],
        ['turnId', turnIds, result.turnId],
      ] as const) {
        if (seen.has(value)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['knowledgeResults', index, field],
            message: `Knowledge result ${field} must be unique`,
          });
        }
        seen.add(value);
      }
      if (result.answer !== null) {
        if (responseMessageIds.has(result.answer.messageId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['knowledgeResults', index, 'answer', 'messageId'],
            message: 'Knowledge response Message IDs must be unique',
          });
        }
        responseMessageIds.add(result.answer.messageId);
      }
      for (const [citationIndex, citation] of result.citations.entries()) {
        const existingLabel = sourceLabels.get(citation.sourceId);
        if (existingLabel !== undefined && existingLabel !== citation.displayLabel) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['knowledgeResults', index, 'citations', citationIndex, 'displayLabel'],
            message: 'A frozen knowledge source must keep one exact citation label',
          });
        } else {
          sourceLabels.set(citation.sourceId, citation.displayLabel);
        }

        const sourceIdentity = `${citation.sourceId}\u0000${citation.displayLabel}`;
        const existingSource = chunkSources.get(citation.chunkId);
        if (existingSource !== undefined && existingSource !== sourceIdentity) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['knowledgeResults', index, 'citations', citationIndex, 'chunkId'],
            message: 'A frozen knowledge chunk must keep one exact source identity',
          });
        } else {
          chunkSources.set(citation.chunkId, sourceIdentity);
        }
      }
    }
  });
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
