import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AgentPackageRequestError,
  approveAgentTransfer,
  getAgentTransfer,
  publicationRequestId,
  publishAgentTransfer,
} from '../../api/agentPackages.js';

/** 私有内容、用户输入和 mutation 回执始终绑定账号与精确上传请求。 */
export function useAgentTransferState(transferId: string, ownerId: string) {
  const client = useQueryClient();
  const queryKey = useMemo(() => ['agent-transfer', ownerId, transferId], [ownerId, transferId]);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const busyRef = useRef(false);
  const activeRef = useRef(false);
  const [now, setNow] = useState(Date.now());
  const [codeEntry, setCodeEntry] = useState<{ identity: string; text: string } | null>(null);
  const [confirmedIdentity, setConfirmedIdentity] = useState<string | null>(null);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getAgentTransfer(transferId, signal),
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
    refetchInterval: (current) => {
      const transfer = current.state.data?.transfer;
      return !busy &&
        !uncertain &&
        current.state.status !== 'error' &&
        transfer?.phase === 'approved' &&
        now < Date.parse(transfer.expiresAt)
        ? 3000
        : false;
    },
  });
  useEffect(() => {
    activeRef.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      activeRef.current = false;
      clearInterval(timer);
    };
  }, []);
  const view = query.data;
  const identity = view
    ? JSON.stringify([
        view.draftFingerprint,
        view.packageDigest,
        view.transfer.verificationCode,
        view.transfer.expiresAt,
      ])
    : '';
  const code = codeEntry?.identity === identity ? codeEntry.text : '';
  const confirmed = identity !== '' && confirmedIdentity === identity;
  const expired = view ? now >= Date.parse(view.transfer.expiresAt) : false;
  const blocked = busy || uncertain || query.isFetching || query.isError;

  async function refresh(): Promise<void> {
    if (busyRef.current || query.isFetching) return;
    setConfirmedIdentity(null);
    const result = await query.refetch();
    if (!activeRef.current || result.isError) return;
    // 只有成功查询能解除未知结果锁；失败查询不能冒充 mutation 失败。
    setUncertain(false);
    setActionError(null);
  }

  async function action(decision: 'approve' | 'reject' | 'publish'): Promise<void> {
    if (!view || busyRef.current || blocked) return;
    const phase = view.transfer.phase;
    if (decision === 'publish') {
      if (phase !== 'uploaded' || !confirmed || !view.review) return;
    } else if (
      phase !== 'pending_approval' ||
      Date.now() >= Date.parse(view.transfer.expiresAt) ||
      code !== view.transfer.verificationCode
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await client.cancelQueries({ queryKey });
      if (!activeRef.current) return;
      const binding = {
        draftFingerprint: view.draftFingerprint,
        packageDigest: view.packageDigest,
      };
      const transfer =
        decision === 'publish'
          ? await publishAgentTransfer(transferId, {
              ...binding,
              requestId: publicationRequestId(
                transferId,
                binding.draftFingerprint,
                binding.packageDigest,
              ),
              confirmPublic: true,
            })
          : await approveAgentTransfer(transferId, {
              ...binding,
              verificationCode: code,
              decision,
            });
      if (!activeRef.current) return;
      await client.cancelQueries({ queryKey });
      if (!activeRef.current) return;
      client.setQueryData(queryKey, { ...view, transfer });
      setCodeEntry(null);
      setConfirmedIdentity(null);
    } catch (error) {
      if (!activeRef.current) return;
      setActionError(error);
      if (error instanceof AgentPackageRequestError && error.outcomeUncertain) {
        setUncertain(true);
        setConfirmedIdentity(null);
      }
    } finally {
      busyRef.current = false;
      if (activeRef.current) setBusy(false);
    }
  }

  return {
    query,
    view,
    identity,
    code,
    confirmed,
    expired,
    busy,
    blocked,
    uncertain,
    actionError,
    refresh,
    action,
    setCode: (text: string) =>
      setCodeEntry({
        identity,
        text: text
          .toUpperCase()
          .replace(/[^A-Z0-9]/gu, '')
          .slice(0, 8),
      }),
    setConfirmed: (value: boolean) => setConfirmedIdentity(value ? identity : null),
  };
}
