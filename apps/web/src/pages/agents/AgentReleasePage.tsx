import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import {
  RELEASE_ID_PATTERN,
  getAgentPackageDownload,
  getAgentPublication,
} from '../../api/agentPackages.js';
import { AgentIcon } from '../../components/AgentIcon.js';
import { CopyInstruction } from '../../components/CopyInstruction.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import {
  AgentIdentity,
  AgentMethodExcerpt,
  AgentPackageEvidence,
  AgentPackageMessage,
  AgentReviewScreen,
} from './AgentPackageReview.js';
import './agentPackages.css';

function ReleaseContent({ releaseId }: { releaseId: string }): ReactElement {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const [reviewing, setReviewing] = useState(false);
  const downloadRef = useRef(false);
  const activeRef = useRef(false);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  const query = useQuery({
    queryKey: ['agent-publication', releaseId],
    queryFn: ({ signal }) => getAgentPublication(releaseId, signal),
    retry: false,
    refetchOnWindowFocus: false,
  });
  useDocumentTitle(query.data ? query.data.name + ' · Agent · Combo' : 'Agent 分享 · Combo');
  if (query.isPending)
    return (
      <article className="cb-agent-page cb-agent-page--public">
        <p role="status">正在读取这个 Agent…</p>
      </article>
    );
  if (query.isError || !query.data)
    return (
      <article className="cb-agent-page cb-agent-page--center">
        <span className="cb-agent-symbol cb-agent-symbol--hero">
          <AgentIcon name="error" />
        </span>
        <h1>暂时无法查看这个 Agent</h1>
        <AgentPackageMessage error={query.error} />
        <button
          type="button"
          className="cb-agent-primary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          重新读取
        </button>
        <p className="cb-agent-subtle">链接可能已失效。你也可以向发布者索取完整链接。</p>
      </article>
    );
  const view = query.data;
  async function download(): Promise<void> {
    if (downloadRef.current || !view) return;
    downloadRef.current = true;
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await getAgentPackageDownload(releaseId, view.release.packageDigest);
      if (!activeRef.current) return;
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'agent-package-' + releaseId.slice(-32) + '.json';
        anchor.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      if (activeRef.current) setDownloadError(error);
    } finally {
      downloadRef.current = false;
      if (activeRef.current) setDownloading(false);
    }
  }
  if (reviewing)
    return (
      <article className="cb-agent-page">
        <AgentReviewScreen
          name={view.name}
          value={view.package}
          onBack={() => {
            setReviewing(false);
            requestAnimationFrame(() => reviewButtonRef.current?.focus());
          }}
        />
      </article>
    );
  return (
    <article className="cb-agent-page cb-agent-page--public">
      <section className="cb-agent-card cb-agent-release-card">
        <AgentIdentity
          name={view.name}
          description={view.description}
          publisher={view.publisher.account}
          primaryHeading
        />
        <AgentMethodExcerpt value={view.package} />
        <CopyInstruction
          text={view.acquirePrompt}
          label="复制使用指令"
          copiedHint="已复制。粘贴到当前对话，让你的 Agent 先校验这个版本，再应用方法。"
          className="cb-agent-primary cb-agent-wide"
        />
        <button
          ref={reviewButtonRef}
          type="button"
          className="cb-agent-text-button cb-agent-review-entry"
          onClick={() => setReviewing(true)}
        >
          查看完整方法
        </button>
      </section>
      <footer className="cb-agent-footer">
        <p className="cb-agent-description">复制后，粘贴到你的 Agent 对话。</p>
        <AgentPackageEvidence />
        <p className="cb-agent-subtle">不包含创作者的原始对话。复制、安装和实际运行分别确认。</p>
        <details className="cb-agent-technical">
          <summary>接收要求与版本信息</summary>
          <p>
            在已经选定项目的 Codex 或 Claude Code 对话中使用。指令以服务端返回的这个固定版本为准。
          </p>
          <p>
            支持 macOS / Linux，需已有 Node.js 24.2
            或更新版本。当前支持轻量文本方法，不自动安装外部工具；遇到文件冲突会停止，不覆盖
            AGENTS.md 或全局配置。
          </p>
          <p>
            无需主站登录。复制不会自动操作客户端或创建新对话；安装后仍需读取原始方法，并单独确认真实运行。
          </p>
          <p>按链接公开；任何拿到链接的人都能查看和下载。已下载的副本无法收回。</p>
          <dl className="cb-agent-digest">
            <dt>Package digest</dt>
            <dd>
              <code>{view.release.packageDigest}</code>
            </dd>
            <dt>Release</dt>
            <dd>
              <code>{view.release.releaseId}</code>
            </dd>
            <dt>发布时间</dt>
            <dd>
              <time dateTime={view.publishedAt}>
                {new Date(view.publishedAt).toLocaleDateString('zh-CN')}
              </time>
            </dd>
          </dl>
          <div className="cb-agent-secondary-actions">
            <CopyInstruction
              text={view.shareUrl}
              label="复制分享链接"
              copiedHint="已复制这个版本的分享链接。"
            />
            <button type="button" disabled={downloading} onClick={() => void download()}>
              {downloading ? '正在下载…' : '下载包 JSON'}
            </button>
          </div>
          {downloadError !== null && <AgentPackageMessage error={downloadError} />}
        </details>
      </footer>
    </article>
  );
}

export function AgentReleasePage(): ReactElement {
  const { releaseId = '' } = useParams();
  if (!RELEASE_ID_PATTERN.test(releaseId))
    return (
      <article className="cb-agent-page cb-agent-page--center">
        <h1>这个 Agent 链接不正确</h1>
        <p>请向发布者索取完整的分享链接。</p>
      </article>
    );
  return <ReleaseContent key={releaseId} releaseId={releaseId} />;
}
