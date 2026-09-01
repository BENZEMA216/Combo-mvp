import {
  AbandonPendingUsageRecoveryResultSchema,
  PendingUsageRecoveryExactResultSchema,
  PendingUsageRecoveryListResultSchema,
  knowledgeBindingsEqual,
  type AbandonPendingUsageRecoveryResult,
  type KnowledgeAgentBinding,
  type PendingUsageRecoveryView,
} from '@cb/shared';

import { apiGet, apiPost } from './client.js';
import { ApiError } from './client.js';

const inProcessResumes = new Map<string, Promise<void>>();

function recoveryProtocolError(): Error {
  return new Error('待恢复任务与服务端状态不一致，请刷新页面后重试。');
}

function parseList(value: unknown): PendingUsageRecoveryView[] {
  const parsed = PendingUsageRecoveryListResultSchema.safeParse(value);
  if (!parsed.success) throw recoveryProtocolError();
  return parsed.data.recoveries;
}

function parseExact(value: unknown): PendingUsageRecoveryView {
  const parsed = PendingUsageRecoveryExactResultSchema.safeParse(value);
  if (!parsed.success) throw recoveryProtocolError();
  return parsed.data.recovery;
}

export async function listPendingUsageRecoveries(
  sessionId?: string,
): Promise<PendingUsageRecoveryView[]> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  return parseList(await apiGet<unknown>(`/runtime/pending-usage-recoveries${query}`));
}

export async function getPendingUsageRecovery(usageId: string): Promise<PendingUsageRecoveryView> {
  return parseExact(
    await apiGet<unknown>(`/runtime/pending-usage-recoveries/${encodeURIComponent(usageId)}`),
  );
}

export async function abandonPendingUsageRecovery(
  usageId: string,
): Promise<AbandonPendingUsageRecoveryResult> {
  const value = await apiPost<unknown>(
    `/runtime/pending-usage-recoveries/${encodeURIComponent(usageId)}/abandon`,
  );
  const parsed = AbandonPendingUsageRecoveryResultSchema.safeParse(value);
  if (!parsed.success) throw recoveryProtocolError();
  return parsed.data;
}

function exactRecoveryEqual(
  listed: PendingUsageRecoveryView,
  exact: PendingUsageRecoveryView,
): boolean {
  return JSON.stringify(listed) === JSON.stringify(exact);
}

/** List discovers server state after any browser restart; exact GET prevents stale list payment. */
export async function resolvePendingRecoveryForSession(
  sessionId: string,
): Promise<PendingUsageRecoveryView | null> {
  const listed = await listPendingUsageRecoveries(sessionId);
  if (listed.length === 0) return null;
  if (listed.length !== 1 || listed[0]!.sessionId !== sessionId) throw recoveryProtocolError();
  const exact = await getPendingUsageRecovery(listed[0]!.usageId);
  if (!exactRecoveryEqual(listed[0]!, exact)) throw recoveryProtocolError();
  return exact;
}

/** The fixed hosted entry exposes at most one server-owned recovery and never trusts list data. */
export async function resolveHostedPendingRecovery(): Promise<PendingUsageRecoveryView | null> {
  const listed = await listPendingUsageRecoveries();
  if (listed.length === 0) return null;
  if (listed.length !== 1) throw recoveryProtocolError();
  const exact = await getPendingUsageRecovery(listed[0]!.usageId);
  if (!exactRecoveryEqual(listed[0]!, exact)) throw recoveryProtocolError();
  return exact;
}

export function pendingRecoveryMatchesBinding(
  recovery: PendingUsageRecoveryView,
  sessionId: string,
  binding: KnowledgeAgentBinding,
): boolean {
  return (
    recovery.sessionId === sessionId &&
    recovery.capabilityId === binding.capability.id &&
    knowledgeBindingsEqual(recovery.binding, binding)
  );
}

async function underBrowserResumeLock(
  usageId: string,
  action: (recovery: PendingUsageRecoveryView) => Promise<void>,
): Promise<void> {
  const execute = async (): Promise<void> => {
    // Re-read inside the cross-tab lock. If another tab already accepted the same usage, the
    // server row is gone and this tab performs no business POST. Browser storage is never truth.
    let recovery: PendingUsageRecoveryView;
    try {
      recovery = await getPendingUsageRecovery(usageId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
    await action(recovery);
  };
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) {
    throw new Error('当前浏览器无法安全协调多标签恢复，请关闭其他标签后换用新版浏览器。');
  }
  await locks.request(`combo:recovery-resume:${usageId}`, { mode: 'exclusive' }, execute);
}

/**
 * React StrictMode shares the in-process promise; tabs serialize through Web Locks and re-read the
 * exact server recovery under that lock. Lost responses remain retryable with the same usageId.
 */
export async function coordinateRecoveryResume(
  usageId: string,
  action: (recovery: PendingUsageRecoveryView) => Promise<void>,
): Promise<void> {
  const existing = inProcessResumes.get(usageId);
  if (existing) return existing;
  const operation = underBrowserResumeLock(usageId, action).finally(() => {
    if (inProcessResumes.get(usageId) === operation) inProcessResumes.delete(usageId);
  });
  inProcessResumes.set(usageId, operation);
  return operation;
}
