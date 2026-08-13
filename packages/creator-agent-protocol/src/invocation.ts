import { z } from 'zod';

export const InvocationStateSchema = z.enum([
  'ACCEPTED',
  'QUEUED',
  'DISPATCH_PENDING',
  'PERSISTED',
  'STARTING',
  'RUNNING',
  'CANCEL_REQUESTED',
  'RECONCILING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'UNCERTAIN',
  'EXPIRED',
]);
export type InvocationState = z.infer<typeof InvocationStateSchema>;

export const TERMINAL_INVOCATION_STATES = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'UNCERTAIN',
  'EXPIRED',
] as const satisfies readonly InvocationState[];

const terminalStateSet = new Set<InvocationState>(TERMINAL_INVOCATION_STATES);

export const InvocationTransitionEvidenceSchema = z
  .object({
    durableFinal: z.boolean().optional(),
    terminalFailureConfirmed: z.boolean().optional(),
    interruptConfirmed: z.boolean().optional(),
    provedNotExecuted: z.boolean().optional(),
    executionEvidenceLost: z.boolean().optional(),
    reconciliationExhausted: z.boolean().optional(),
    queueTtlExpiredBeforeDispatch: z.boolean().optional(),
  })
  .strict();
export type InvocationTransitionEvidence = z.infer<typeof InvocationTransitionEvidenceSchema>;

export const InvocationTransitionSchema = z
  .object({
    from: InvocationStateSchema,
    to: InvocationStateSchema,
    evidence: InvocationTransitionEvidenceSchema,
  })
  .strict();
export type InvocationTransition = z.infer<typeof InvocationTransitionSchema>;

const allowedTransitions: Readonly<Record<InvocationState, ReadonlySet<InvocationState>>> = {
  ACCEPTED: new Set(['QUEUED', 'CANCELLED']),
  QUEUED: new Set(['DISPATCH_PENDING', 'CANCELLED', 'EXPIRED']),
  DISPATCH_PENDING: new Set(['PERSISTED', 'QUEUED']),
  PERSISTED: new Set(['STARTING', 'CANCEL_REQUESTED']),
  STARTING: new Set(['RUNNING', 'RECONCILING']),
  RUNNING: new Set(['SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'RECONCILING']),
  CANCEL_REQUESTED: new Set(['CANCELLED', 'SUCCEEDED', 'FAILED', 'RECONCILING']),
  RECONCILING: new Set(['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN']),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  UNCERTAIN: new Set(),
  EXPIRED: new Set(),
};

export class InvalidInvocationTransitionError extends Error {
  public readonly code = 'INVALID_INVOCATION_TRANSITION';

  public constructor(
    public readonly from: InvocationState,
    public readonly to: InvocationState,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidInvocationTransitionError';
  }
}

export function isTerminalInvocationState(state: InvocationState): boolean {
  return terminalStateSet.has(state);
}

export function transitionInvocationState(transition: InvocationTransition): InvocationState {
  const parsed = InvocationTransitionSchema.parse(transition);
  const { from, to, evidence } = parsed;
  if (!allowedTransitions[from].has(to)) {
    throw new InvalidInvocationTransitionError(from, to, `不允许 ${from} → ${to}`);
  }

  const hasCancellationEvidence = evidence.interruptConfirmed || evidence.provedNotExecuted;
  if (to === 'SUCCEEDED' && !evidence.durableFinal) {
    throw new InvalidInvocationTransitionError(from, to, 'SUCCEEDED 必须有 durable final');
  }
  if (to === 'FAILED' && !evidence.terminalFailureConfirmed) {
    throw new InvalidInvocationTransitionError(from, to, 'FAILED 必须有确定失败证据');
  }
  if (to === 'CANCELLED' && !hasCancellationEvidence) {
    throw new InvalidInvocationTransitionError(from, to, 'CANCELLED 必须有未执行或 interrupt 证据');
  }
  if (to === 'RECONCILING' && !evidence.executionEvidenceLost) {
    throw new InvalidInvocationTransitionError(from, to, 'RECONCILING 必须有执行证据丢失事实');
  }
  if (to === 'UNCERTAIN' && !evidence.reconciliationExhausted) {
    throw new InvalidInvocationTransitionError(from, to, 'UNCERTAIN 必须先耗尽有界 reconciliation');
  }
  if (to === 'EXPIRED' && !evidence.queueTtlExpiredBeforeDispatch) {
    throw new InvalidInvocationTransitionError(
      from,
      to,
      'EXPIRED 必须证明尚未 dispatch 且 queue TTL 已过',
    );
  }
  return to;
}

export const RetryPolicySchema = z.enum([
  'REPLAY_SAME_REQUEST',
  'NEW_INVOCATION_ALLOWED',
  'DO_NOT_AUTO_RETRY',
  'NOT_RETRYABLE',
]);
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const VnextErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'IDEMPOTENCY_CONFLICT',
  'SNAPSHOT_EMPTY',
  'SNAPSHOT_SOURCE_CHANGED',
  'SNAPSHOT_LIMIT_EXCEEDED',
  'SNAPSHOT_PATH_REJECTED',
  'SNAPSHOT_SECRET_DETECTED',
  'AGENT_OFFLINE',
  'AGENT_BUSY',
  'QUEUE_FULL',
  'VERSION_UNAVAILABLE',
  'VERSION_DIGEST_MISMATCH',
  'SNAPSHOT_DIGEST_MISMATCH',
  'CONVERSATION_BUSY',
  'CONVERSATION_EXPIRED',
  'CONVERSATION_CONTEXT_LIMIT',
  'WORKER_OFFLINE_TIMEOUT',
  'MODEL_QUOTA_EXHAUSTED',
  'STALE_LEASE',
  'STALE_FENCE',
  'PROTOCOL_INCOMPATIBLE',
  'EXECUTION_CAPABILITY_INVALID',
  'SANDBOX_ATTESTATION_FAILED',
  'RUNTIME_START_FAILED',
  'TURN_TIMEOUT',
  'TURN_FAILED',
  'CANCEL_NOT_CONFIRMED',
  'EXECUTION_STATE_UNKNOWN',
  'SSE_CURSOR_EXPIRED',
]);
export type VnextErrorCode = z.infer<typeof VnextErrorCodeSchema>;

export interface VnextErrorClassification {
  code: VnextErrorCode;
  httpStatus: number;
  retryPolicy: RetryPolicy;
  publicMessage: string;
}

const classification = <T extends VnextErrorClassification>(entry: T): T => entry;

export const VNEXT_ERROR_CLASSIFICATION: Readonly<
  Record<VnextErrorCode, VnextErrorClassification>
> = {
  INVALID_INPUT: classification({
    code: 'INVALID_INPUT',
    httpStatus: 400,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: '输入不符合要求。',
  }),
  UNAUTHORIZED: classification({
    code: 'UNAUTHORIZED',
    httpStatus: 401,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: '请先登录。',
  }),
  FORBIDDEN: classification({
    code: 'FORBIDDEN',
    httpStatus: 403,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: '你没有权限执行这个操作。',
  }),
  RATE_LIMITED: classification({
    code: 'RATE_LIMITED',
    httpStatus: 429,
    retryPolicy: 'REPLAY_SAME_REQUEST',
    publicMessage: '请求过于频繁，请按提示稍后重试。',
  }),
  IDEMPOTENCY_CONFLICT: classification({
    code: 'IDEMPOTENCY_CONFLICT',
    httpStatus: 409,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: '同一请求标识绑定了不同内容。',
  }),
  SNAPSHOT_EMPTY: classification({
    code: 'SNAPSHOT_EMPTY',
    httpStatus: 400,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: '没有可发布的文件。',
  }),
  SNAPSHOT_SOURCE_CHANGED: classification({
    code: 'SNAPSHOT_SOURCE_CHANGED',
    httpStatus: 409,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: 'Project 在封存期间发生变化，请重新预览。',
  }),
  SNAPSHOT_LIMIT_EXCEEDED: classification({
    code: 'SNAPSHOT_LIMIT_EXCEEDED',
    httpStatus: 413,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: '发布内容超过 Alpha 限额。',
  }),
  SNAPSHOT_PATH_REJECTED: classification({
    code: 'SNAPSHOT_PATH_REJECTED',
    httpStatus: 400,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: 'Project 包含不允许发布的路径或文件类型。',
  }),
  SNAPSHOT_SECRET_DETECTED: classification({
    code: 'SNAPSHOT_SECRET_DETECTED',
    httpStatus: 400,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: 'Project 包含疑似敏感凭据，已停止发布。',
  }),
  AGENT_OFFLINE: classification({
    code: 'AGENT_OFFLINE',
    httpStatus: 503,
    retryPolicy: 'REPLAY_SAME_REQUEST',
    publicMessage: '创作者的 Agent 当前离线，请稍后再试。',
  }),
  AGENT_BUSY: classification({
    code: 'AGENT_BUSY',
    httpStatus: 429,
    retryPolicy: 'REPLAY_SAME_REQUEST',
    publicMessage: 'Agent 当前繁忙，请稍后再试。',
  }),
  QUEUE_FULL: classification({
    code: 'QUEUE_FULL',
    httpStatus: 429,
    retryPolicy: 'REPLAY_SAME_REQUEST',
    publicMessage: 'Agent 等待队列已满，请稍后再试。',
  }),
  VERSION_UNAVAILABLE: classification({
    code: 'VERSION_UNAVAILABLE',
    httpStatus: 409,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: '当前 Agent 版本不可用。',
  }),
  VERSION_DIGEST_MISMATCH: classification({
    code: 'VERSION_DIGEST_MISMATCH',
    httpStatus: 409,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: 'Agent 版本校验失败，已停止运行。',
  }),
  SNAPSHOT_DIGEST_MISMATCH: classification({
    code: 'SNAPSHOT_DIGEST_MISMATCH',
    httpStatus: 409,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: 'Context 校验失败，已停止运行。',
  }),
  CONVERSATION_BUSY: classification({
    code: 'CONVERSATION_BUSY',
    httpStatus: 409,
    retryPolicy: 'REPLAY_SAME_REQUEST',
    publicMessage: '上一轮仍在处理中。',
  }),
  CONVERSATION_EXPIRED: classification({
    code: 'CONVERSATION_EXPIRED',
    httpStatus: 410,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: '这段对话已结束，请创建新对话。',
  }),
  CONVERSATION_CONTEXT_LIMIT: classification({
    code: 'CONVERSATION_CONTEXT_LIMIT',
    httpStatus: 409,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: '这段对话已达到上下文上限，请创建新对话。',
  }),
  WORKER_OFFLINE_TIMEOUT: classification({
    code: 'WORKER_OFFLINE_TIMEOUT',
    httpStatus: 504,
    retryPolicy: 'NEW_INVOCATION_ALLOWED',
    publicMessage: '等待 Creator Worker 超时，可以创建新的请求。',
  }),
  MODEL_QUOTA_EXHAUSTED: classification({
    code: 'MODEL_QUOTA_EXHAUSTED',
    httpStatus: 503,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: 'Creator 的模型额度暂不可用。',
  }),
  STALE_LEASE: classification({
    code: 'STALE_LEASE',
    httpStatus: 409,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: 'Worker 租约已失效。',
  }),
  STALE_FENCE: classification({
    code: 'STALE_FENCE',
    httpStatus: 409,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: 'Worker 执行身份已失效。',
  }),
  PROTOCOL_INCOMPATIBLE: classification({
    code: 'PROTOCOL_INCOMPATIBLE',
    httpStatus: 409,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: 'Worker 版本与服务不兼容。',
  }),
  EXECUTION_CAPABILITY_INVALID: classification({
    code: 'EXECUTION_CAPABILITY_INVALID',
    httpStatus: 409,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: '本次运行授权校验失败。',
  }),
  SANDBOX_ATTESTATION_FAILED: classification({
    code: 'SANDBOX_ATTESTATION_FAILED',
    httpStatus: 409,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: '安全运行环境校验失败。',
  }),
  RUNTIME_START_FAILED: classification({
    code: 'RUNTIME_START_FAILED',
    httpStatus: 503,
    retryPolicy: 'NEW_INVOCATION_ALLOWED',
    publicMessage: '运行环境启动失败，可以创建新的请求。',
  }),
  TURN_TIMEOUT: classification({
    code: 'TURN_TIMEOUT',
    httpStatus: 504,
    retryPolicy: 'NEW_INVOCATION_ALLOWED',
    publicMessage: '本次回答超时，可以创建新的请求。',
  }),
  TURN_FAILED: classification({
    code: 'TURN_FAILED',
    httpStatus: 502,
    retryPolicy: 'NEW_INVOCATION_ALLOWED',
    publicMessage: '本次回答失败，可以创建新的请求。',
  }),
  CANCEL_NOT_CONFIRMED: classification({
    code: 'CANCEL_NOT_CONFIRMED',
    httpStatus: 409,
    retryPolicy: 'DO_NOT_AUTO_RETRY',
    publicMessage: '停止状态无法确认，系统不会自动重复执行。',
  }),
  EXECUTION_STATE_UNKNOWN: classification({
    code: 'EXECUTION_STATE_UNKNOWN',
    httpStatus: 409,
    retryPolicy: 'DO_NOT_AUTO_RETRY',
    publicMessage: '运行状态无法确认，系统不会自动重复执行。',
  }),
  SSE_CURSOR_EXPIRED: classification({
    code: 'SSE_CURSOR_EXPIRED',
    httpStatus: 410,
    retryPolicy: 'NOT_RETRYABLE',
    publicMessage: '事件游标已过期，请重新加载完整对话。',
  }),
};

export const VnextErrorResponseSchema = z
  .object({
    code: VnextErrorCodeSchema,
    retryPolicy: RetryPolicySchema,
    message: z.string().min(1).max(512),
    requestId: z.string().min(8).max(128),
  })
  .strict()
  .superRefine((response, context) => {
    if (VNEXT_ERROR_CLASSIFICATION[response.code].retryPolicy !== response.retryPolicy) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retryPolicy'],
        message: 'retryPolicy 与冻结错误分类不一致',
      });
    }
  });
export type VnextErrorResponse = z.infer<typeof VnextErrorResponseSchema>;

export function errorResponseFor(code: VnextErrorCode, requestId: string): VnextErrorResponse {
  const entry = VNEXT_ERROR_CLASSIFICATION[code];
  return VnextErrorResponseSchema.parse({
    code,
    retryPolicy: entry.retryPolicy,
    message: entry.publicMessage,
    requestId,
  });
}
