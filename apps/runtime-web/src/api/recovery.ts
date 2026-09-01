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
const RECOVERY_TERMINAL_POLL_INTERVAL_MS = 1_000;
const RECOVERY_TERMINAL_WAIT_MS = 5 * 60_000;

interface RecoveryResumeOptions {
  signal?: AbortSignal;
  terminalPollIntervalMs?: number;
  terminalWaitMs?: number;
}

interface RecoveryResumeContext {
  signal: AbortSignal;
}

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

export async function getPendingUsageRecovery(
  usageId: string,
  signal?: AbortSignal,
): Promise<PendingUsageRecoveryView> {
  return parseExact(
    await apiGet<unknown>(`/runtime/pending-usage-recoveries/${encodeURIComponent(usageId)}`, {
      signal,
    }),
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
  action: (recovery: PendingUsageRecoveryView, context: RecoveryResumeContext) => Promise<void>,
  options: RecoveryResumeOptions,
): Promise<void> {
  const terminalPollIntervalMs =
    options.terminalPollIntervalMs ?? RECOVERY_TERMINAL_POLL_INTERVAL_MS;
  const terminalWaitMs = options.terminalWaitMs ?? RECOVERY_TERMINAL_WAIT_MS;
  const aborted = (): Error => new Error('原任务恢复已取消，服务端恢复状态保持不变。');
  const timedOut = (): Error => new Error('原任务恢复超时，服务端恢复状态保持不变。');
  const abortable = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : aborted();
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(signal.reason instanceof Error ? signal.reason : aborted());
      };
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      operation.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  };
  const waitToPoll = async (signal: AbortSignal): Promise<void> => {
    if (terminalPollIntervalMs <= 0) return;
    await abortable(
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, terminalPollIntervalMs);
      }),
      signal,
    );
  };
  const execute = async (): Promise<void> => {
    const controller = new AbortController();
    const cancel = () => controller.abort(aborted());
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = window.setTimeout(() => controller.abort(timedOut()), terminalWaitMs);
    try {
      // The one lock-owned deadline covers the authoritative preflight, POST, and terminal poll.
      let recovery: PendingUsageRecoveryView;
      try {
        recovery = await abortable(
          getPendingUsageRecovery(usageId, controller.signal),
          controller.signal,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return;
        throw error;
      }
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error ? controller.signal.reason : aborted();
      }
      await abortable(action(recovery, { signal: controller.signal }), controller.signal);
      for (;;) {
        try {
          await abortable(getPendingUsageRecovery(usageId, controller.signal), controller.signal);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return;
          throw new Error('无法确认原任务终态，服务端恢复状态保持不变。', {
            cause: error,
          });
        }
        await waitToPoll(controller.signal);
      }
    } finally {
      window.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', cancel);
    }
  };
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) {
    throw new Error('当前浏览器无法安全协调多标签恢复，请关闭其他标签后换用新版浏览器。');
  }
  await locks.request(
    `combo:recovery-resume:${usageId}`,
    { mode: 'exclusive', signal: options.signal },
    execute,
  );
}

/**
 * React StrictMode shares the in-process promise; tabs serialize through Web Locks until server
 * terminal, re-reading exact recovery under that lock. Lost responses remain retryable with the
 * same usageId after the owning tab exits or the bounded terminal confirmation fails.
 */
export async function coordinateRecoveryResume(
  usageId: string,
  action: (recovery: PendingUsageRecoveryView, context: RecoveryResumeContext) => Promise<void>,
  options: RecoveryResumeOptions = {},
): Promise<void> {
  const existing = inProcessResumes.get(usageId);
  if (existing) return existing;
  const operation = underBrowserResumeLock(usageId, action, options).finally(() => {
    if (inProcessResumes.get(usageId) === operation) inProcessResumes.delete(usageId);
  });
  inProcessResumes.set(usageId, operation);
  return operation;
}
