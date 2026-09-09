import { useEffect, useRef, type ReactElement } from 'react';
import { AgentPackageRequestError, type AgentPackageReview } from '../../api/agentPackages.js';
import { AgentIcon } from '../../components/AgentIcon.js';

export function packageDescription(value: AgentPackageReview): string {
  try {
    const manifest: unknown = JSON.parse(value.manifestText);
    if (
      typeof manifest === 'object' &&
      manifest !== null &&
      'description' in manifest &&
      typeof manifest.description === 'string'
    )
      return manifest.description;
  } catch {
    /* API 校验后的内容若不可读，不生成替代方法。 */
  }
  return '';
}

/** 节选只来自实际 Skill，不渲染 Markdown、外部图片或脚本。 */
export function AgentMethodExcerpt({ value }: { value: AgentPackageReview }): ReactElement | null {
  const skill = value.files.find((file) => /^skills\/[^/]+\/SKILL\.md$/u.test(file.path));
  if (!skill) return null;
  const body = skill.text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').trim();
  return (
    <div className="cb-agent-excerpt">
      <p className="cb-agent-subtle">方法节选</p>
      <pre>
        {body.slice(0, 600)}
        {body.length > 600 ? '…' : ''}
      </pre>
    </div>
  );
}

export function AgentPackageContents({ value }: { value: AgentPackageReview }): ReactElement {
  return (
    <section className="cb-agent-content" aria-labelledby="agent-content-title">
      <h2 id="agent-content-title">查看实际内容</h2>
      <p className="cb-agent-subtle">
        完整原文 · 不执行内容。API 已校验此版本；网页未独立重算摘要。
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

export function AgentReviewScreen({
  name,
  value,
  onBack,
}: {
  name: string;
  value: AgentPackageReview;
  onBack: () => void;
}): ReactElement {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <section className="cb-agent-review-screen">
      <button type="button" className="cb-agent-text-button" onClick={onBack}>
        返回 Agent
      </button>
      <h1 ref={headingRef} tabIndex={-1}>
        {name}的完整方法
      </h1>
      <AgentPackageEvidence />
      <AgentPackageContents value={value} />
      <details className="cb-agent-technical">
        <summary>版本信息</summary>
        <code>{value.packageDigest}</code>
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

export function AgentIdentity({
  name,
  description,
  publisher,
  primaryHeading = false,
}: {
  name: string;
  description?: string;
  publisher?: string;
  primaryHeading?: boolean;
}): ReactElement {
  const Heading = primaryHeading ? 'h1' : 'h2';
  return (
    <header className="cb-agent-identity">
      <span className="cb-agent-symbol">
        <AgentIcon name="layers" />
      </span>
      <div>
        <Heading>{name}</Heading>
        {description && <p>{description}</p>}
        {publisher && <p className="cb-agent-subtle">由 {publisher} 分享</p>}
      </div>
    </header>
  );
}
