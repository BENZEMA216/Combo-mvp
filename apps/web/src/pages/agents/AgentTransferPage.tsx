import { useRef, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TRANSFER_ID_PATTERN } from '../../api/agentPackages.js';
import { AgentIcon, type AgentIconName } from '../../components/AgentIcon.js';
import { CopyInstruction } from '../../components/CopyInstruction.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import { useAuth } from '../../shell/auth.js';
import {
  AgentIdentity,
  AgentPackageEvidence,
  AgentPackageMessage,
  AgentReviewScreen,
  packageDescription,
} from './AgentPackageReview.js';
import { useAgentTransferState } from './AgentTransferState.js';
import './agentPackages.css';

export const CONTINUE_PRIVATE_SAVE =
  '我已在 Combo 核对确认码并允许保存。请继续刚才同一份 Agent 的私有保存：先查询原上传请求；只在已获授权后继续，不重新提取、不新建请求、不公开发布。';

function TransferContent({
  transferId,
  ownerId,
}: {
  transferId: string;
  ownerId: string;
}): ReactElement {
  const state = useAgentTransferState(transferId, ownerId);
  const { query, view, identity, code, confirmed, expired, busy, blocked, uncertain, actionError } =
    state;
  const [screen, setScreen] = useState<{
    identity: string;
    page: 'share' | 'review';
    returnTo: 'saved' | 'share';
  } | null>(null);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useDocumentTitle(view ? view.name + ' · 保存与分享 · Combo' : 'Agent 保存与分享 · Combo');
  const page = screen?.identity === identity ? screen.page : 'saved';
  function showReview(returnTo: 'saved' | 'share'): void {
    setScreen({ identity, page: 'review', returnTo });
  }
  function backFromReview(): void {
    const returnTo = screen?.returnTo ?? 'saved';
    setScreen(returnTo === 'share' ? { identity, page: 'share', returnTo } : null);
    requestAnimationFrame(() => reviewButtonRef.current?.focus());
  }
  function showShare(): void {
    state.setConfirmed(false);
    setScreen({ identity, page: 'share', returnTo: 'saved' });
    requestAnimationFrame(() => titleRef.current?.focus());
  }

  if (query.isPending)
    return (
      <article className="cb-agent-page cb-agent-page--center">
        <p role="status">正在读取上传请求…</p>
      </article>
    );
  if (query.isError || !view)
    return (
      <article className="cb-agent-page cb-agent-page--center">
        <span className="cb-agent-symbol cb-agent-symbol--hero">
          <AgentIcon name="error" />
        </span>
        <h1>暂时无法读取上传请求</h1>
        <AgentPackageMessage error={query.error} />
        {uncertain && <p>上次操作的结果仍未知。先成功查询状态，再继续。</p>}
        <button
          type="button"
          className="cb-agent-primary"
          disabled={query.isFetching}
          onClick={() => void state.refresh()}
        >
          刷新状态
        </button>
        <p className="cb-agent-subtle">不显示旧账号内容，也不会自动重发请求。</p>
      </article>
    );
  const transfer = view.transfer;
  if (page === 'review' && view.review)
    return (
      <article className="cb-agent-page">
        <AgentReviewScreen name={view.name} value={view.review} onBack={backFromReview} />
      </article>
    );
  const sharing = transfer.phase === 'uploaded' && page === 'share';
  const titles: Record<typeof transfer.phase, [string, string, AgentIconName]> = {
    pending_approval: [
      '确认是你发起的保存。',
      '输入原对话里的 8 位确认码，只保存这一份 Agent。',
      'shield',
    ],
    approved: ['已允许保存。', '回到原对话，继续刚才的私有保存。', 'check'],
    uploaded: ['先留给自己。', 'Agent 已私有保存。是否公开，仍由你决定。', 'lock'],
    published: ['现在，可以分享了。', '链接对应这次确认的固定版本。', 'link'],
    rejected: ['已拒绝此次保存。', '本次授权已结束，未允许上传。', 'error'],
  };
  const [title, lead, symbol] = sharing
    ? (['让别人，也能用。', '公开后，拿到链接的人都能查看和下载这个版本。', 'link'] as const)
    : titles[transfer.phase];
  return (
    <article className="cb-agent-page cb-agent-page--center">
      <header className="cb-agent-header">
        <span className="cb-agent-symbol cb-agent-symbol--hero">
          <AgentIcon name={symbol} />
        </span>
        <h1 ref={titleRef} tabIndex={-1}>
          {title}
        </h1>
        <p className="cb-agent-description">{lead}</p>
      </header>
      {actionError !== null && <AgentPackageMessage error={actionError} />}
      {uncertain && (
        <p className="cb-agent-notice" role="status">
          结果未知不代表失败。请先刷新状态；成功查询前不能再次提交，不会自动重发。
        </p>
      )}

      {transfer.phase === 'pending_approval' && (
        <section className="cb-agent-card" aria-label="核对私有保存">
          <AgentIdentity name={view.name} />
          <p>只保存整理后的 Agent 方法，不读取或保存原始对话。</p>
          <label className="cb-agent-field" htmlFor="agent-verification-code">
            原对话中的 8 位确认码
            <input
              id="agent-verification-code"
              value={code}
              onChange={(event) => state.setCode(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={8}
              placeholder="8 位字母或数字"
              disabled={blocked || expired}
              aria-describedby="pair-expiry"
            />
          </label>
          <p id="pair-expiry" className="cb-agent-subtle">
            {expired
              ? '确认码已过期。请回到原对话重新发起保存。'
              : '有效至 ' +
                new Date(transfer.expiresAt).toLocaleTimeString('zh-CN') +
                '；仅限本次保存。'}
          </p>
          <button
            type="button"
            className="cb-agent-primary cb-agent-wide"
            disabled={blocked || expired || code !== transfer.verificationCode}
            onClick={() => void state.action('approve')}
          >
            {busy ? '正在确认…' : '确认并允许保存'}
          </button>
          <p className="cb-agent-subtle">这次确认不授权公开发布，也不会安装或运行。</p>
          <Link className="cb-agent-text-link" to="/">
            取消
          </Link>
        </section>
      )}

      {transfer.phase === 'approved' && (
        <section className="cb-agent-card">
          <AgentIdentity name={view.name} />
          {expired ? (
            <p role="status">上传授权已过期。若尚未保存，请回到原对话重新发起。</p>
          ) : (
            <>
              <p>网页无法替你返回或上传。请切回发起请求的那条对话，粘贴继续指令。</p>
              <CopyInstruction
                text={CONTINUE_PRIVATE_SAVE}
                label="复制继续保存指令"
                copiedHint="已复制。回到原对话粘贴，继续同一份保存。"
                className="cb-agent-primary cb-agent-wide"
              />
              <p className="cb-agent-subtle" role="status">
                等待原对话完成上传；此页只查询状态。
              </p>
            </>
          )}
        </section>
      )}

      {transfer.phase === 'rejected' && <p>若要继续，请回到原对话发起新的保存请求。</p>}

      {transfer.phase === 'uploaded' && (
        <>
          <section className="cb-agent-card">
            <AgentIdentity
              name={view.name}
              description={view.review ? packageDescription(view.review) : undefined}
            />
            {sharing ? (
              <p>
                公开完整方法与文件，不公开原始对话。
                <br />
                已下载的副本无法收回。
              </p>
            ) : (
              <p className="cb-agent-private">
                <AgentIcon name="lock" /> 仅你可见，尚未公开
              </p>
            )}
            {view.review && (
              <button
                ref={reviewButtonRef}
                type="button"
                className="cb-agent-text-button"
                onClick={() => showReview(sharing ? 'share' : 'saved')}
              >
                {sharing ? '检查完整内容' : '查看完整方法'}
              </button>
            )}
          </section>
          {sharing ? (
            <section className="cb-agent-public-confirm" aria-label="独立公开确认">
              <label className="cb-agent-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={blocked}
                  onChange={(event) => state.setConfirmed(event.target.checked)}
                />
                <span>
                  我已检查完整内容，确认没有隐私、凭证或无权分享的内容，同意公开这个版本。
                </span>
              </label>
              <button
                type="button"
                className="cb-agent-primary"
                disabled={!confirmed || blocked || !view.review}
                onClick={() => void state.action('publish')}
              >
                {busy ? '正在确认发布…' : '确认公开'}
              </button>
              <button
                type="button"
                className="cb-agent-text-button"
                disabled={busy}
                onClick={() => {
                  state.setConfirmed(false);
                  setScreen(null);
                  requestAnimationFrame(() => titleRef.current?.focus());
                }}
              >
                暂不公开
              </button>
            </section>
          ) : (
            <button
              type="button"
              className="cb-agent-primary"
              disabled={blocked || !view.review}
              onClick={showShare}
            >
              准备分享
            </button>
          )}
        </>
      )}

      {transfer.phase === 'published' && transfer.release && (
        <section className="cb-agent-card">
          <AgentIdentity
            name={view.name}
            description={view.review ? packageDescription(view.review) : undefined}
          />
          <a className="cb-agent-share" href={transfer.release.shareUrl}>
            {transfer.release.shareUrl}
          </a>
          <CopyInstruction
            text={transfer.release.shareUrl}
            label="复制分享链接"
            copiedHint="已复制分享链接。拿到链接的人可以查看这个版本。"
            className="cb-agent-primary cb-agent-wide"
          />
          <div className="cb-agent-secondary-actions">
            <CopyInstruction
              text={transfer.release.acquirePrompt}
              label="复制使用指令"
              copiedHint="已复制。交给你当前对话中的 Agent；尚未安装或运行。"
            />
            {view.review && (
              <button
                ref={reviewButtonRef}
                type="button"
                className="cb-agent-text-button"
                onClick={() => showReview('saved')}
              >
                查看完整方法
              </button>
            )}
          </div>
        </section>
      )}

      <footer className="cb-agent-footer">
        <AgentPackageEvidence />
        <button
          type="button"
          className="cb-agent-text-button"
          disabled={busy || query.isFetching}
          onClick={() => void state.refresh()}
        >
          {query.isFetching ? '正在刷新…' : '刷新状态'}
        </button>
        <details className="cb-agent-technical">
          <summary>核对版本与请求</summary>
          <dl className="cb-agent-digest">
            <dt>Draft fingerprint</dt>
            <dd>
              <code>{view.draftFingerprint}</code>
            </dd>
            <dt>Package digest</dt>
            <dd>
              <code>{view.packageDigest}</code>
            </dd>
            <dt>保存状态</dt>
            <dd>{transfer.phase}</dd>
          </dl>
          {transfer.phase === 'pending_approval' && (
            <button
              type="button"
              disabled={blocked || expired || code !== transfer.verificationCode}
              onClick={() => void state.action('reject')}
            >
              拒绝此次上传
            </button>
          )}
        </details>
      </footer>
    </article>
  );
}

export function AgentTransferPage(): ReactElement {
  const { transferId = '' } = useParams();
  const { me } = useAuth();
  if (!TRANSFER_ID_PATTERN.test(transferId))
    return (
      <article className="cb-agent-page cb-agent-page--center">
        <h1>这个上传链接不正确</h1>
        <p>请从原对话打开完整的确认链接。</p>
      </article>
    );
  if (!me)
    return (
      <article className="cb-agent-page">
        <p role="status">正在确认登录身份…</p>
      </article>
    );
  return <TransferContent key={me.id + ':' + transferId} transferId={transferId} ownerId={me.id} />;
}
