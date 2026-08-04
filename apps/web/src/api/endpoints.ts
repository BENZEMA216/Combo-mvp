// 业务端点封装：任务域 + 能力项域（对齐 apps/authoring 的 15 端点里前端消费的部分）。
// 类型一律取 @cb/shared 契约真源，页面只 import 这里、不散落裸 fetch。
import {
  API_PREFIX,
  SSE_ROUTES,
  type CapabilityView,
  type CreateTaskResult,
  type PageMeta,
  type PublishResult,
  type TaskView,
} from '@cb/shared';
import { sanitizeTrialReturnTo } from '../safeReturnTo.js';
import { apiGet, apiGetEnvelope, apiPost } from './client.js';

/** 游标分页的一页（meta.page 缺失时按「单页到底」兜底，不崩列表）。 */
export interface Page<T> {
  items: T[];
  page: PageMeta;
}

const FALLBACK_PAGE: PageMeta = { nextCursor: null, hasMore: false, limit: 20, order: 'desc' };

async function getPage<T>(
  path: string,
  query: Record<string, string | number | undefined>,
): Promise<Page<T>> {
  const { data, meta } = await apiGetEnvelope<T[]>(path, { query });
  return { items: data, page: meta?.page ?? FALLBACK_PAGE };
}

// ---------- 任务 ----------

export interface ListQuery {
  cursor?: string;
  limit?: number;
}

/**
 * 建上传任务。幂等键在这里生成（后端 CreateTaskBody 要求 8-128 字符）；
 * 双击防重靠调用方在途禁用——每次调用都是「新建一个任务」的语义。
 */
export function createTask(description?: string): Promise<CreateTaskResult> {
  return apiPost<CreateTaskResult>('/tasks', {
    idempotencyKey: crypto.randomUUID(),
    ...(description ? { description } : {}),
  });
}

export function listTasks(query: ListQuery = {}): Promise<Page<TaskView>> {
  return getPage<TaskView>('/tasks', { cursor: query.cursor, limit: query.limit });
}

export function getTask(taskId: string): Promise<TaskView> {
  return apiGet<TaskView>(`/tasks/${encodeURIComponent(taskId)}`);
}

export function retryTask(taskId: string): Promise<TaskView> {
  return apiPost<TaskView>(`/tasks/${encodeURIComponent(taskId)}/retry`);
}

/** 任务进度 SSE 端点（相对路径，同源 Cookie 鉴权）。 */
export function taskEventsUrl(taskId: string): string {
  return SSE_ROUTES.taskEvents(taskId);
}

/**
 * 本机助手一条命令（配对码只在建任务响应里明文出现一次）。
 * GET /connect/script?code=<配对码> 下发内嵌配对码的脚本，`| sh` 直跑。
 */
export function connectCommand(pairingCode: string, origin?: string): string {
  const base = origin ?? window.location.origin;
  return `curl -fsSL "${base}${API_PREFIX}/connect/script?code=${encodeURIComponent(pairingCode)}" | sh`;
}

// ---------- 能力项 ----------

export interface ListCapabilitiesQuery extends ListQuery {
  /** 只看某个任务提取出的能力项。 */
  taskId?: string;
}

export function listCapabilities(query: ListCapabilitiesQuery = {}): Promise<Page<CapabilityView>> {
  return getPage<CapabilityView>('/capabilities', {
    taskId: query.taskId,
    cursor: query.cursor,
    limit: query.limit,
  });
}

/** 单个 Agent：定价发布中心与深链恢复使用稳定 capabilityId 读取。 */
export function getCapability(capabilityId: string): Promise<CapabilityView> {
  return apiGet<CapabilityView>(`/capabilities/${encodeURIComponent(capabilityId)}`);
}

export function publishCapability(capabilityId: string): Promise<PublishResult> {
  return apiPost<PublishResult>(`/capabilities/${encodeURIComponent(capabilityId)}/publish`);
}

export function unpublishCapability(capabilityId: string): Promise<PublishResult> {
  return apiPost<PublishResult>(`/capabilities/${encodeURIComponent(capabilityId)}/unpublish`);
}

/** UI Studio 为 Agent 创建或恢复的设计会话。 */
export interface StudioSessionResult {
  session: {
    id: string;
  };
}

/**
 * 从 Agent 管理页进入 UI Studio。
 * 该端点只接收稳定的 capabilityId；服务端负责创建或恢复对应设计会话。
 */
export function createStudioSession(capabilityId: string): Promise<StudioSessionResult> {
  return apiPost<StudioSessionResult>('/runtime/studio/sessions', { capabilityId });
}

/**
 * 试用端（runtime-web）入口：生产部署在同域 /try/ 子路径（vite base '/try/'，dev 端口 5174 同 base）。
 * /try/c/:id 会为该能力开一局试用会话。
 */
export function trialUrl(capabilityId: string, returnTo?: string): string {
  const path = `/try/c/${encodeURIComponent(capabilityId)}`;
  const safeReturnTo = sanitizeTrialReturnTo(returnTo);
  return safeReturnTo ? `${path}?returnTo=${encodeURIComponent(safeReturnTo)}` : path;
}
