import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';

import { resolveHostedPendingRecovery } from '../api/recovery.js';
import { useHostedKnowledgeAgentDescriptor, useStartHostedKnowledgeAgent } from '../api/runtime.js';
import { ComboMark, ComboWordmark } from '../components/ComboBrand.js';
import { loginUrl } from '../navigation/login.js';

export const HOSTED_KNOWLEDGE_AGENT_PATH = '/try/agent/combo-knowledge' as const;

function formatCents(cents: string): string {
  const padded = cents.padStart(3, '0');
  return `¥${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

function HostedShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="rt-hosted-agent">
      <header className="rt-hosted-agent__header">
        <span className="rt-hosted-agent__brand">
          <ComboMark className="rt-hosted-agent__brand-mark" />
          <ComboWordmark className="rt-hosted-agent__brand-word" />
        </span>
        <span className="rt-hosted-agent__beta">Test Beta</span>
      </header>
      {children}
    </main>
  );
}

/** Static unauthenticated surface: mounting it performs no descriptor, recovery, or mutation call. */
export function HostedKnowledgeAgentAnonymous() {
  return (
    <HostedShell>
      <section className="rt-hosted-agent__hero" aria-labelledby="hosted-agent-title">
        <p className="rt-hosted-agent__eyebrow">固定知识 · 可核验引用 · 按成功回答结算</p>
        <h1 id="hosted-agent-title">Combo 知识助手</h1>
        <p>登录后，可向固定发布的知识 Agent 提问，并在回答中查看来源片段。</p>
        <a className="rt-btn rt-btn--accent" href={loginUrl(HOSTED_KNOWLEDGE_AGENT_PATH)}>
          登录后开始体验
        </a>
      </section>
    </HostedShell>
  );
}

export function HostedKnowledgeAgentPage() {
  const navigate = useNavigate();
  const descriptor = useHostedKnowledgeAgentDescriptor();
  const recoveries = useQuery({
    queryKey: ['pending-usage-recoveries', 'hosted-agent-entry'],
    queryFn: () => resolveHostedPendingRecovery(),
    retry: false,
  });
  const start = useStartHostedKnowledgeAgent();
  const [startError, setStartError] = useState<string | null>(null);
  const recovery = recoveries.data ?? null;

  const begin = async (): Promise<void> => {
    if (recovery || start.isPending) return;
    setStartError(null);
    try {
      const result = await start.mutateAsync();
      navigate(`/session/${result.sessionId}`);
    } catch {
      setStartError('暂时无法开始体验，请稍后重试。');
    }
  };

  if (descriptor.isPending || recoveries.isPending) {
    return (
      <HostedShell>
        <section className="rt-hosted-agent__panel" role="status">
          正在加载固定 Test Agent…
        </section>
      </HostedShell>
    );
  }
  if (descriptor.isError || !descriptor.data || recoveries.isError) {
    return (
      <HostedShell>
        <section className="rt-hosted-agent__panel" role="alert">
          <h1>当前 Test Agent 暂不可用</h1>
          <p>入口已安全关闭，没有创建会话或发起计费。</p>
          <button
            type="button"
            className="rt-btn"
            onClick={() => {
              void descriptor.refetch();
              void recoveries.refetch();
            }}
          >
            重新检查
          </button>
        </section>
      </HostedShell>
    );
  }

  const agent = descriptor.data;
  return (
    <HostedShell>
      <section className="rt-hosted-agent__hero" aria-labelledby="hosted-agent-title">
        <p className="rt-hosted-agent__eyebrow">固定知识 · 可核验引用 · 按成功回答结算</p>
        <h1 id="hosted-agent-title">{agent.name}</h1>
        <p>{agent.summary}</p>
        <dl className="rt-hosted-agent__terms">
          <div>
            <dt>免费体验</dt>
            <dd>前 {agent.billing.freeUses} 次成功回答</dd>
          </div>
          <div>
            <dt>之后每次</dt>
            <dd>{formatCents(agent.billing.unitPriceCents)}</dd>
          </div>
          <div>
            <dt>结算条件</dt>
            <dd>只有通过引用校验的回答才结算</dd>
          </div>
        </dl>
        {recovery ? (
          <div className="rt-hosted-agent__recovery" role="status">
            <p>检测到一条由服务端保存的待恢复问题。</p>
            <button
              type="button"
              className="rt-btn rt-btn--accent"
              onClick={() => navigate(`/session/${recovery.sessionId}`)}
            >
              继续原问题
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="rt-btn rt-btn--accent"
            disabled={start.isPending}
            onClick={() => void begin()}
          >
            {start.isPending ? '正在创建会话…' : '开始提问'}
          </button>
        )}
        {startError && (
          <p className="rt-hosted-agent__error" role="alert">
            {startError}
          </p>
        )}
      </section>
    </HostedShell>
  );
}
