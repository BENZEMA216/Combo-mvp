import { useEffect, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ErrorState, Skeleton } from '../../components/index.js';
import { CopyButton } from '../../components/CopyButton.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import { fetchProjectAgentShare } from './projectAgentShareApi.js';

function RobotsNoIndex(): null {
  useEffect(() => {
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previous = existing?.content;
    const meta = existing ?? document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    if (!existing) document.head.appendChild(meta);
    return () => {
      if (existing && previous !== undefined) existing.content = previous;
      else meta.remove();
    };
  }, []);
  return null;
}

function RequirementList({ title, items }: { title: string; items: string[] }): ReactElement {
  return (
    <div className="cb-project-share__requirement">
      <h3>{title}</h3>
      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item}>
              <code>{item}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p>未声明</p>
      )}
    </div>
  );
}

export function ProjectAgentSharePage(): ReactElement {
  const { shareToken = '' } = useParams<{ shareToken?: string }>();
  const query = useQuery({
    queryKey: ['project-agent-share', shareToken],
    queryFn: () => fetchProjectAgentShare(shareToken),
    enabled: shareToken.length > 0,
    retry: false,
  });
  useDocumentTitle(query.data ? `${query.data.manifest.name} · Project Agent · Combo` : undefined);

  if (query.isLoading) {
    return (
      <section className="cb-public cb-project-share" aria-busy="true">
        <RobotsNoIndex />
        <Skeleton rows={6} label="Project Agent 分享加载中" />
      </section>
    );
  }
  if (query.isError || !query.data) {
    return (
      <section className="cb-public cb-project-share">
        <RobotsNoIndex />
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </section>
    );
  }

  const { manifest, copyPrompt } = query.data;
  const requirements = manifest.requirements;

  return (
    <article className="cb-public cb-project-share" aria-labelledby="cb-project-share-title">
      <RobotsNoIndex />
      <header className="cb-project-share__hero">
        <p className="cb-project-share__eyebrow">Project Agent 分享</p>
        <h1 id="cb-project-share-title">{manifest.name}</h1>
        <p>{manifest.description}</p>
      </header>

      <section className="cb-project-share__warning" role="alert">
        <strong>这是不可信项目</strong>
        <p>
          分享者提供的代码和项目指令可能执行命令或读取本机文件。请先审查内容和依赖，确认后再使用
          Codex 恢复。
        </p>
        <p>
          任何拿到链接的人都可匿名读取这份 manifest。V0 分享不会过期、也不能撤销。它不是账户授权或
          OAuth token；但它是未列出的公开定位链接， 持有即匿名可读，请按公开内容处理，manifest
          中不要放任何秘密。
        </p>
      </section>

      <section className="cb-project-share__panel" aria-labelledby="cb-project-source-title">
        <h2 id="cb-project-source-title">固定来源</h2>
        <dl>
          <dt>仓库</dt>
          <dd>
            <a href={manifest.source.repositoryUrl} target="_blank" rel="noreferrer">
              {manifest.source.repositoryUrl}
            </a>
          </dd>
          <dt>创建者声明的 ref</dt>
          <dd>
            <code>{manifest.source.sourceRef}</code>
          </dd>
          <dt>Commit</dt>
          <dd>
            <code>{manifest.source.commitSha}</code>
          </dd>
          <dt>Tree</dt>
          <dd>
            <code>{manifest.source.treeSha}</code>
          </dd>
          <dt>创建时间</dt>
          <dd>{new Date(manifest.createdAt).toLocaleString()}</dd>
        </dl>
        <p className="cb-project-share__note">
          创建者客户端在创建前应核对 ref 已推送；Combo 只记录这项声明，未独立验证。后续 branch 或
          tag 移动不会改变这份分享，恢复必须以上述不可变 commit 为准并核对 tree。
        </p>
      </section>

      <section className="cb-project-share__panel" aria-labelledby="cb-project-start-title">
        <h2 id="cb-project-start-title">恢复后 Codex 首条启动任务</h2>
        <pre>{manifest.startPrompt}</pre>
        <p className="cb-project-share__note">此文字不会被「复制分享提示」直接执行。</p>
      </section>

      <section className="cb-project-share__panel" aria-labelledby="cb-project-requirements-title">
        <h2 id="cb-project-requirements-title">接收端依赖声明</h2>
        <p>
          Codex 版本：<code>{requirements.codexVersion ?? '未声明'}</code>
        </p>
        <div className="cb-project-share__requirements">
          <RequirementList title="命令" items={requirements.commands} />
          <RequirementList title="Plugin" items={requirements.plugins} />
          <RequirementList title="环境变量名" items={requirements.environmentVariableNames} />
        </div>
      </section>

      <section className="cb-project-share__panel" aria-labelledby="cb-project-boundary-title">
        <h2 id="cb-project-boundary-title">分享边界</h2>
        <ul>
          <li>只恢复该 commit 内的 Git tracked files。ignored 与 untracked files 不在分享中。</li>
          <li>不包含 Codex 会话、运行中进程、Cookie、令牌、凭据或环境变量值。</li>
          <li>Combo 服务端不抓取仓库，也不声称已验证远程 SHA。</li>
          <li>
            Combo 只保存 manifest，不归档 Git 对象；仓库删除、转为私有或 commit
            不再可取时，旧分享将无法恢复。
          </li>
          <li>推理和 Agent Harness 由接收者的真实 Codex 负责，Combo 不模拟 Runtime。</li>
        </ul>
      </section>

      <section
        className="cb-project-share__panel cb-project-share__copy"
        aria-labelledby="cb-project-copy-title"
      >
        <h2 id="cb-project-copy-title">复制分享提示</h2>
        <p>
          在 Codex 的新任务中粘贴并发送这段话。Codex 会先读取和展示
          manifest，等你确认后再恢复；即使尚未安装 Combo，提示也会引导你从同环境安装页继续。
        </p>
        <textarea readOnly value={copyPrompt} aria-label="Project Agent 分享提示" />
        <CopyButton
          text={copyPrompt}
          label="复制到 Codex"
          ariaLabel="复制 Project Agent 分享提示到 Codex"
          className="cb-project-share__copy-button"
        />
      </section>
    </article>
  );
}
