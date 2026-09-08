import { useRef, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import {
  AgentPackageRequestError,
  RELEASE_ID_PATTERN,
  getAgentPackageDownload,
  getAgentPublication,
  type AgentPackageReview,
} from '../../api/agentPackages.js';
import { CopyButton } from '../../components/CopyButton.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import './agentPackages.css';

export function AgentPackageContents({ value }: { value: AgentPackageReview }): ReactElement {
  return (
    <section className="cb-agent-content" aria-labelledby="agent-content-title">
      <div className="cb-agent-section-heading">
        <div>
          <p className="cb-agent-kicker">PACKAGE CONTENTS</p>
          <h2 id="agent-content-title">查看实际内容</h2>
        </div>
        <span className="cb-agent-subtle">原文展示 · 不执行内容</span>
      </div>
      <p className="cb-agent-subtle">
        以下为服务端读取并校验的包内容。网页未运行这个 Agent，也未独立重算文件摘要。
      </p>
      {value.files.map((file) => (
        <details
          className="cb-agent-file"
          key={file.path}
          open={file.path === 'AGENT.md' || file.path.endsWith('/SKILL.md')}
        >
          <summary>{file.path}</summary>
          <pre>{file.text}</pre>
        </details>
      ))}
      <details className="cb-agent-file">
        <summary>agent.json</summary>
        <pre>{value.manifestText}</pre>
      </details>
    </section>
  );
}

export function AgentPackageEvidence(): ReactElement {
  return (
    <div className="cb-agent-evidence" aria-label="证据边界">
      <span>来源未核验</span>
      <span>覆盖可能不完整</span>
      <span>尚未试运行</span>
    </div>
  );
}

export function AgentPackageMessage({ error }: { error: unknown }): ReactElement {
  return (
    <p role="alert" className="cb-agent-error">
      {error instanceof AgentPackageRequestError
        ? error.userMessage
        : '暂时无法读取，请稍后刷新状态。'}
    </p>
  );
}

function ReleaseContent({ releaseId }: { releaseId: string }): ReactElement {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const downloadRef = useRef(false);
  const query = useQuery({
    queryKey: ['agent-publication', releaseId],
    queryFn: ({ signal }) => getAgentPublication(releaseId, signal),
    retry: false,
    refetchOnWindowFocus: false,
  });
  useDocumentTitle(query.data ? `${query.data.name} · Agent · Combo` : 'Agent 分享 · Combo');
  if (query.isPending)
    return (
      <article className="cb-agent-page cb-agent-page--public">
        <p role="status">正在读取这个 Agent…</p>
      </article>
    );
  if (query.isError || !query.data)
    return (
      <article className="cb-agent-page cb-agent-page--public">
        <h1>暂时无法查看这个 Agent</h1>
        <AgentPackageMessage error={query.error} />
        <button type="button" onClick={() => void query.refetch()}>
          重新读取
        </button>
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
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `agent-package-${releaseId.slice(-32)}.json`;
        anchor.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      setDownloadError(error);
    } finally {
      downloadRef.current = false;
      setDownloading(false);
    }
  }
  return (
    <article className="cb-agent-page cb-agent-page--public">
      <header className="cb-agent-header">
        <p className="cb-agent-kicker">SHARED AGENT</p>
        <h1>{view.name}</h1>
        <p className="cb-agent-description">{view.description}</p>
        <p className="cb-agent-subtle">
          发布者 {view.publisher.account} ·{' '}
          <time dateTime={view.publishedAt}>
            {new Date(view.publishedAt).toLocaleDateString('zh-CN')}
          </time>
        </p>
        <AgentPackageEvidence />
      </header>
      <section className="cb-agent-card" aria-labelledby="acquire-title">
        <p className="cb-agent-kicker">USE IN YOUR TASK</p>
        <h2 id="acquire-title">把它带到你的任务中</h2>
        <p>
          复制下面的提示词，交给接收端核对包内容和摘要，再明确决定是否使用。打开此页不代表已安装或已运行。
        </p>
        <div className="cb-agent-prompt">
          <p>{view.acquirePrompt}</p>
          <CopyButton text={view.acquirePrompt} label="复制获取提示词" />
        </div>
        <p className="cb-agent-subtle">这是按链接公开的内容，任何拿到链接的人都能查看和下载。</p>
        <div className="cb-agent-actions">
          <CopyButton text={view.shareUrl} label="复制分享链接" />
          <button type="button" disabled={downloading} onClick={() => void download()}>
            {downloading ? '正在下载…' : '下载包 JSON'}
          </button>
        </div>
        {downloadError !== null && <AgentPackageMessage error={downloadError} />}
      </section>
      <section className="cb-agent-digest" aria-label="包标识">
        <span>Package digest</span>
        <code>{view.release.packageDigest}</code>
        <span>Release</span>
        <code>{view.release.releaseId}</code>
      </section>
      <AgentPackageContents value={view.package} />
    </article>
  );
}

export function AgentReleasePage(): ReactElement {
  const { releaseId = '' } = useParams();
  if (!RELEASE_ID_PATTERN.test(releaseId))
    return (
      <article className="cb-agent-page cb-agent-page--public">
        <h1>这个 Agent 链接不正确</h1>
        <p>请向发布者索取完整的分享链接。</p>
      </article>
    );
  return <ReleaseContent key={releaseId} releaseId={releaseId} />;
}
