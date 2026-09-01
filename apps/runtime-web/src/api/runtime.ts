// 试用端 API：端点函数 + React Query hooks。类型全来自 @cb/shared 试用域契约。
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  HostedKnowledgeAgentDescriptorSchema,
  RechargeRequiredBodySchema,
  StartHostedKnowledgeAgentResultSchema,
  type ArtifactView,
  type HostedKnowledgeAgentDescriptor,
  type MessageView,
  type RechargeRequiredBody,
  type SessionDetail,
  type SessionMode,
  type SessionView,
  type StartHostedKnowledgeAgentResult,
} from '@cb/shared';
import { ApiError, apiDelete, apiGet, apiGetText, apiPatch, apiPost } from './client.js';

/** GET /runtime/capabilities 列表项（runtime 侧 TrialCapabilityItem，shared 未收录，这里对齐声明）。 */
export interface TrialCapability {
  id: string;
  name: string;
  summary: string;
  kind: string;
  published: boolean;
  /** 是否本人创作（前端区分「我的 / 已发布」分组）。 */
  owned: boolean;
  createdAt: string;
}

export function useCapabilities() {
  return useQuery({
    queryKey: ['capabilities'],
    queryFn: () => apiGet<TrialCapability[]>('/runtime/capabilities'),
  });
}

export async function getHostedKnowledgeAgentDescriptor(): Promise<HostedKnowledgeAgentDescriptor> {
  return HostedKnowledgeAgentDescriptorSchema.parse(
    await apiGet<unknown>('/runtime/agents/combo-knowledge'),
  );
}

export function useHostedKnowledgeAgentDescriptor() {
  return useQuery({
    queryKey: ['hosted-agent', 'combo-knowledge'],
    queryFn: getHostedKnowledgeAgentDescriptor,
    retry: false,
  });
}

export async function startHostedKnowledgeAgent(): Promise<StartHostedKnowledgeAgentResult> {
  return StartHostedKnowledgeAgentResultSchema.parse(
    await apiPost<unknown>('/runtime/agents/combo-knowledge/start', {}),
  );
}

export function useStartHostedKnowledgeAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: startHostedKnowledgeAgent,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function sessionsPath(capabilityId?: string, mode?: SessionMode): string {
  const params = new URLSearchParams();
  if (capabilityId) params.set('capabilityId', capabilityId);
  if (mode) params.set('mode', mode);
  const query = params.toString();
  return `/runtime/sessions${query ? `?${query}` : ''}`;
}

/** 我的会话列表；给 capabilityId 时只取该能力下的会话（对话页侧栏按能力隔离）。 */
export function useSessions(
  capabilityId?: string,
  options?: { enabled?: boolean; mode?: SessionMode },
) {
  return useQuery({
    queryKey: ['sessions', capabilityId ?? null, options?.mode ?? null],
    queryFn: () => apiGet<SessionView[]>(sessionsPath(capabilityId, options?.mode)),
    enabled: options?.enabled ?? true,
  });
}

export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: ['session', id],
    queryFn: () => apiGet<SessionDetail>(`/runtime/sessions/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (capabilityId: string) =>
      apiPost<SessionView>('/runtime/sessions', { capabilityId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export interface UpdateSessionTitleInput {
  sessionId: string;
  title: string;
}

export function updateSessionTitle(input: UpdateSessionTitleInput): Promise<SessionView> {
  return apiPatch<SessionView>(`/runtime/sessions/${input.sessionId}`, { title: input.title });
}

export function archiveSession(sessionId: string): Promise<SessionView> {
  return apiDelete<SessionView>(`/runtime/sessions/${sessionId}`);
}

/** 改名/归档后，列表与当条详情都不能留旧缓存。 */
export function invalidateSessionMutation(queryClient: QueryClient, sessionId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
}

export function useUpdateSessionTitle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: updateSessionTitle,
    onSuccess: (session) => invalidateSessionMutation(qc, session.id),
  });
}

export function useArchiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: archiveSession,
    onSuccess: (session) => invalidateSessionMutation(qc, session.id),
  });
}

export type RechargeRequired = RechargeRequiredBody;

/** 只识别 runtime 明确定义的 402 结构，避免把普通网关错误误当作充值提示。 */
export function readRechargeRequired(
  error: unknown,
  expectedUsageId: string,
): RechargeRequired | null {
  if (!(error instanceof ApiError) || error.status !== 402) return null;
  const parsed = RechargeRequiredBodySchema.safeParse(error.responseBody);
  if (!parsed.success) return null;
  const recoveryUsageId = parsed.data.recoveryUsageId;
  return recoveryUsageId === undefined
    ? parsed.data.rechargeIntentId === expectedUsageId
      ? parsed.data
      : null
    : recoveryUsageId === expectedUsageId
      ? parsed.data
      : null;
}

export interface SendSessionMessageResult {
  message: MessageView;
  /** true 表示 usageId 已存在，服务端没有再次启动 Agent 或扣费。 */
  replayed: boolean;
}

/** 发消息：202 即返回（user 消息已落库，生成在后端异步跑，进展经 /stream 订阅）。 */
export function sendSessionMessage(
  sessionId: string,
  text: string,
  usageId: string,
): Promise<SendSessionMessageResult> {
  return apiPost<SendSessionMessageResult>(`/runtime/sessions/${sessionId}/messages`, {
    text,
    usageId,
  });
}

/** 打断当前轮（无进行中的轮 → interrupted=false，幂等）。 */
export function interruptSession(sessionId: string): Promise<{ interrupted: boolean }> {
  return apiPost<{ interrupted: boolean }>(`/runtime/sessions/${sessionId}/interrupt`);
}

/** 产物内容回读（裸文本；updatedAt 进 key，产物更新后自动拉新版）。 */
export function useArtifactContent(artifact: ArtifactView | null) {
  const id = artifact?.id;
  return useQuery({
    queryKey: ['artifact-content', id, artifact?.updatedAt],
    queryFn: () => apiGetText(`/runtime/artifacts/${id}/content`),
    enabled: Boolean(id),
  });
}
