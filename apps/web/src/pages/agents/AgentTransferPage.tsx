import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import {
  AgentPackageRequestError,
  TRANSFER_ID_PATTERN,
  approveAgentTransfer,
  getAgentTransfer,
  publicationRequestId,
  publishAgentTransfer,
  type AgentTransferReceipt,
  type TransferPhase,
} from '../../api/agentPackages.js';
import { CopyButton } from '../../components/CopyButton.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import { useAuth } from '../../shell/auth.js';
import {
  AgentPackageContents,
  AgentPackageEvidence,
  AgentPackageMessage,
} from './AgentReleasePage.js';
import './agentPackages.css';

const PHASE_LABELS: Record<TransferPhase, string> = {
  pending_approval: '等待你核对',
  approved: '等待 Codex 上传',
  uploaded: '已私有保存，尚未公开',
  published: '已按链接公开',
  rejected: '已拒绝此次上传',
};

function TransferContent({
  transferId,
  ownerId,
}: {
  transferId: string;
  ownerId: string;
}): ReactElement {
  const client = useQueryClient();
  const queryKey = useMemo(() => ['agent-transfer', ownerId, transferId], [ownerId, transferId]);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getAgentTransfer(transferId, signal),
    retry: false,
    refetchOnWindowFocus: false,
    // 最后一个订阅卸载即回收私有内容；已消费的 signal 同时取消旧账号的 GET。
    gcTime: 0,
  });
  const [codeEntry, setCodeEntry] = useState<{ identity: string; text: string } | null>(null);
  const [confirmedIdentity, setConfirmedIdentity] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const activeRef = useRef(false);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  const [actionError, setActionError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useDocumentTitle(
    query.data ? `${query.data.name} · 上传与发布 · Combo` : 'Agent 上传与发布 · Combo',
  );
  const view = query.data;
  const identity = view
    ? JSON.stringify([
        view.draftFingerprint,
        view.packageDigest,
        view.transfer.verificationCode,
        view.transfer.expiresAt,
      ])
    : '';
  // 确认绑定到屏幕上那一份内容；刷新若返回不同身份，不继承旧输入或勾选。
  const code = codeEntry?.identity === identity ? codeEntry.text : '';
  const confirmed = identity !== '' && confirmedIdentity === identity;
  const phase = view?.transfer.phase;
  const expired = view ? now >= Date.parse(view.transfer.expiresAt) : false;

  async function action(decision: 'approve' | 'reject' | 'publish'): Promise<void> {
    if (!view || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      let transfer: AgentTransferReceipt;
      const binding = {
        draftFingerprint: view.draftFingerprint,
        packageDigest: view.packageDigest,
      };
      if (decision === 'publish') {
        if (phase !== 'uploaded' || !confirmed || !view.review) return;
        const requestId = publicationRequestId(
          transferId,
          binding.draftFingerprint,
          binding.packageDigest,
        );
        transfer = await publishAgentTransfer(transferId, {
          ...binding,
          requestId,
          confirmPublic: true,
        });
        if (transfer.phase !== 'published')
          throw new AgentPackageRequestError('发布结果尚未确认，请刷新状态。', true);
      } else {
        if (phase !== 'pending_approval' || expired || code !== view.transfer.verificationCode)
          return;
        transfer = await approveAgentTransfer(transferId, {
          ...binding,
          verificationCode: code,
          decision,
        });
        if (transfer.phase !== (decision === 'approve' ? 'approved' : 'rejected'))
          throw new AgentPackageRequestError('确认结果尚未明确，请刷新状态。', true);
      }
      if (!activeRef.current) return;
      await client.cancelQueries({ queryKey });
      if (!activeRef.current) return;
      client.setQueryData(queryKey, { ...view, transfer });
      setCodeEntry(null);
      setConfirmedIdentity(null);
    } catch (error) {
      if (activeRef.current) setActionError(error);
    } finally {
      busyRef.current = false;
      if (activeRef.current) setBusy(false);
    }
  }

  if (query.isPending)
    return (
      <article className="cb-agent-page">
        <p role="status">正在读取上传请求…</p>
      </article>
    );
  if (query.isError || !view)
    return (
      <article className="cb-agent-page">
        <h1>暂时无法读取上传请求</h1>
        <AgentPackageMessage error={query.error} />
        <button type="button" onClick={() => void query.refetch()}>
          刷新状态
        </button>
      </article>
    );
  const transfer = view.transfer;
  const pairMatches = code === transfer.verificationCode;
  return (
    <article className="cb-agent-page">
      <header className="cb-agent-header">
        <p className="cb-agent-kicker">FROM YOUR CODEX TASK</p>
        <h1>{view.name}</h1>
        <p className="cb-agent-description">先私有保存，再由你决定是否分享。</p>
        <div className="cb-agent-status">
          <span>{PHASE_LABELS[transfer.phase]}</span>
          <button
            type="button"
            disabled={busy || query.isFetching}
            onClick={() => {
              setActionError(null);
              void query.refetch();
            }}
          >
            {query.isFetching ? '正在刷新…' : '刷新状态'}
          </button>
        </div>
        <AgentPackageEvidence />
      </header>
      {actionError !== null && (
        <>
          <AgentPackageMessage error={actionError} />
          {actionError instanceof AgentPackageRequestError && actionError.outcomeUncertain && (
            <p className="cb-agent-notice">
              结果未知不代表失败。请先刷新状态；重新确认发布时会复用原请求编号，不会自动重发。
            </p>
          )}
        </>
      )}
      {transfer.phase === 'pending_approval' && (
        <section className="cb-agent-card" aria-labelledby="pair-title">
          <p className="cb-agent-kicker">01 · PRIVATE UPLOAD</p>
          <h2 id="pair-title">核对 Codex 配对码</h2>
          <p>
            请回到发起上传的 Codex 任务，核对 Agent 名称与下方两个摘要，再输入该任务给出的 8
            位配对码。
          </p>
          <p className="cb-agent-notice">
            这次确认只允许保存当前这份私有 Agent，不会公开发布，也不会安装到任何任务或 Project。
          </p>
          <label className="cb-agent-field" htmlFor="agent-verification-code">
            Codex 中的 8 位配对码
            <input
              id="agent-verification-code"
              value={code}
              onChange={(event) =>
                setCodeEntry({
                  identity,
                  text: event.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/gu, '')
                    .slice(0, 8),
                })
              }
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={8}
              placeholder="例如 A1B2C3D4"
              disabled={busy || expired}
              aria-describedby="pair-expiry"
            />
          </label>
          <p id="pair-expiry" className="cb-agent-subtle">
            {expired
              ? '配对已过期。请回到 Codex 创建新的上传请求。'
              : `有效至 ${new Date(transfer.expiresAt).toLocaleTimeString('zh-CN')}；超过时间需重新发起。`}
          </p>
          <div className="cb-agent-actions">
            <button
              type="button"
              className="cb-agent-primary"
              disabled={busy || expired || !pairMatches}
              onClick={() => void action('approve')}
            >
              {busy ? '正在提交…' : '允许私有上传'}
            </button>
            <button
              type="button"
              disabled={busy || expired || !pairMatches}
              onClick={() => void action('reject')}
            >
              拒绝此次上传
            </button>
          </div>
        </section>
      )}
      {transfer.phase === 'approved' && (
        <section className="cb-agent-card">
          <p className="cb-agent-kicker">01 · PRIVATE UPLOAD</p>
          <h2>已允许私有上传</h2>
          <p>
            {expired
              ? '上传授权已过期。若 Codex 尚未完成上传，请在原任务重新发起。'
              : '请回到发起请求的 Codex 任务，让它完成上传，再点击“刷新状态”。'}
          </p>
          <p className="cb-agent-subtle">浏览器不持有上传 secret；此时尚不能公开发布。</p>
        </section>
      )}
      {transfer.phase === 'rejected' && (
        <section className="cb-agent-card">
          <h2>此次上传已拒绝</h2>
          <p>本次授权已结束。若要继续，请回到 Codex 发起新的请求。</p>
        </section>
      )}
      {(transfer.phase === 'uploaded' || transfer.phase === 'published') && view.review && (
        <AgentPackageContents value={view.review} />
      )}
      {transfer.phase === 'uploaded' && (
        <section className="cb-agent-card" aria-labelledby="publish-title">
          <p className="cb-agent-kicker">02 · SEPARATE PUBLICATION</p>
          <h2 id="publish-title">要将这份 Agent 按链接公开吗？</h2>
          <p>
            目前仅私有保存。公开后，任何拿到链接的人都能查看与下载上面的完整内容；已经下载的副本无法收回。
          </p>
          <label className="cb-agent-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmedIdentity(event.target.checked ? identity : null)}
              disabled={busy}
            />
            <span>
              我已核对 AGENT.md、Skill
              和其他文件，确认没有隐私、凭证或无权分享的内容，并同意按链接公开。
            </span>
          </label>
          <button
            type="button"
            className="cb-agent-primary"
            disabled={!confirmed || busy || !view.review}
            onClick={() => void action('publish')}
          >
            {busy ? '正在确认发布…' : '确认公开发布'}
          </button>
          <p className="cb-agent-subtle">
            只发布当前两个摘要对应的内容。此操作不会自动安装或试运行。
          </p>
        </section>
      )}
      {transfer.phase === 'published' && transfer.release && (
        <section className="cb-agent-card">
          <p className="cb-agent-kicker">PUBLICATION COMPLETE</p>
          <h2>已按链接公开</h2>
          <p>发布的是当前内容的固定版本，不代表已经安装或运行。</p>
          <a className="cb-agent-share" href={transfer.release.shareUrl}>
            {transfer.release.shareUrl}
          </a>
          <div className="cb-agent-actions">
            <CopyButton text={transfer.release.shareUrl} label="复制分享链接" />
            <CopyButton text={transfer.release.acquirePrompt} label="复制获取提示词" />
          </div>
          <div className="cb-agent-prompt">
            <p>{transfer.release.acquirePrompt}</p>
          </div>
        </section>
      )}
      <section className="cb-agent-digest" aria-label="待确认内容摘要">
        <span>Draft fingerprint</span>
        <code>{view.draftFingerprint}</code>
        <span>Package digest</span>
        <code>{view.packageDigest}</code>
      </section>
    </article>
  );
}

export function AgentTransferPage(): ReactElement {
  const { transferId = '' } = useParams();
  const { me } = useAuth();
  if (!TRANSFER_ID_PATTERN.test(transferId))
    return (
      <article className="cb-agent-page">
        <h1>这个上传链接不正确</h1>
        <p>请从 Codex 打开完整的确认链接。</p>
      </article>
    );
  if (!me)
    return (
      <article className="cb-agent-page">
        <p role="status">正在确认登录身份…</p>
      </article>
    );
  return <TransferContent key={`${me.id}:${transferId}`} transferId={transferId} ownerId={me.id} />;
}
