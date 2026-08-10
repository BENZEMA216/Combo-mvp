import { useEffect, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ErrorState, Skeleton } from '../../components/index.js';
import { CopyButton } from '../../components/CopyButton.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import { fetchCodexAgentShare } from './codexAgentShareApi.js';

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

export function CodexAgentSharePage(): ReactElement {
  const { shareToken = '' } = useParams<{ shareToken?: string }>();
  const query = useQuery({
    queryKey: ['codex-agent-share', shareToken],
    queryFn: () => fetchCodexAgentShare(shareToken),
    enabled: shareToken.length > 0,
    retry: false,
  });
  useDocumentTitle(query.data ? `${query.data.manifest.name} · Codex Agent · Combo` : undefined);

  if (query.isLoading) {
    return (
      <section className="cb-public cb-project-share" aria-busy="true">
        <RobotsNoIndex />
        <Skeleton rows={6} label="Codex Agent 分享加载中" />
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

  const { manifest, manifestSha256, copyPrompt } = query.data;
  const requirements = manifest.requirements;

  return (
    <article className="cb-public cb-project-share" aria-labelledby="cb-codex-agent-title">
      <RobotsNoIndex />
      <header className="cb-project-share__hero">
        <p className="cb-project-share__eyebrow">Codex Agent 分享</p>
        <h1 id="cb-codex-agent-title">{manifest.name}</h1>
        <p>{manifest.description}</p>
      </header>

      <section className="cb-project-share__warning" role="alert">
        <strong>派生 Agent 指令是公开内容</strong>
        <p>
          任何拿到链接的人都能匿名读取下面的 instructions、starter prompts 和 Project
          来源。请把它当作公开链接，不要在派生定义中放入秘密。
        </p>
        <p>
          当前 V1 不支持撤销或过期。它不是账户授权或 OAuth
          token；但它是未列出的公开定位链接，持有即匿名可读，请按公开内容处理。
        </p>
        <p>
          这份 schema 没有独立的 raw
          task、threadId、messages、session、路径、Cookie、令牌、验证码或环境变量值字段；
          <code>authoringSource.rawStored=false</code> 只表示没有独立 raw task blob。 Instructions
          与 starter prompts 是创建者声明从当前 task
          派生的公开文本，服务端不能证明其已脱敏或不含原文。
        </p>
      </section>

      <section className="cb-project-share__panel" aria-labelledby="cb-codex-agent-source-title">
        <h2 id="cb-codex-agent-source-title">固定 Project 来源</h2>
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
          <dt>Manifest SHA-256</dt>
          <dd>
            <code>{manifestSha256}</code>
          </dd>
          <dt>创建时间</dt>
          <dd>{new Date(manifest.createdAt).toLocaleString()}</dd>
        </dl>
        <p className="cb-project-share__note">
          接收端必须先核对 manifest digest，再恢复精确 commit 并核对 tree；Combo
          记录创建者声明，但不抓取仓库或代替接收端验证。
        </p>
      </section>

      <section
        className="cb-project-share__panel"
        aria-labelledby="cb-codex-agent-definition-title"
      >
        <h2 id="cb-codex-agent-definition-title">公开的派生 Agent 定义</h2>
        <h3>Instructions</h3>
        <pre>{manifest.agent.instructions}</pre>
        <h3>Starter prompts</h3>
        <ol>
          {manifest.agent.starterPrompts.map((prompt) => (
            <li key={prompt}>{prompt}</li>
          ))}
        </ol>
        <p className="cb-project-share__note">
          创建者声明这些内容由 Codex 从当前任务可见上下文本地提炼；Combo
          只校验字段形状，不能验证该声明或去敏质量。
        </p>
      </section>

      <section
        className="cb-project-share__panel"
        aria-labelledby="cb-codex-agent-requirements-title"
      >
        <h2 id="cb-codex-agent-requirements-title">接收端依赖声明</h2>
        <p>
          Codex 版本：<code>{requirements.codexVersion ?? '未声明'}</code>
        </p>
        <div className="cb-project-share__requirements">
          <RequirementList title="命令" items={requirements.commands} />
          <RequirementList title="Plugin" items={requirements.plugins} />
          <RequirementList title="环境变量名" items={requirements.environmentVariableNames} />
        </div>
      </section>

      <section className="cb-project-share__panel" aria-labelledby="cb-codex-agent-boundary-title">
        <h2 id="cb-codex-agent-boundary-title">接收与运行边界</h2>
        <ul>
          <li>复制文案只引用分享链接和 manifest digest，不内嵌 instructions 或原始会话。</li>
          <li>确认前只读 manifest，不恢复 Project，也不执行 Agent instructions。</li>
          <li>
            四项新工具与 official Plugin <code>&gt;=0.7.0</code>/Test MCP metadata
            初始都满足时留在当前任务； 任一不满足才用 Host-safe{' '}
            <code>combo.receiver-bootstrap-handoff/1</code> 和 <code>target:type=projectless</code>{' '}
            创建续跑任务，不能借用 Creator 的同 Project handoff。
          </li>
          <li>
            留在当前任务时不主动登录，只有可调用工具明确返回 authorization
            错误才恰好登录一次并重试原调用； 进入安装或升级 continuation 时，则在最终 metadata
            校验后、任何 create_thread 前用 Desktop 内置 CLI 恰好完成一次 Codex-managed
            OAuth。失败或取消不创建任务；续跑任务不再登录或重建任务。
          </li>
          <li>
            Handoff 不算确认；子任务 readiness、读取并完整重显后，必须在 assistant agentMessage（
            <code>phase=final_answer</code>）回证 exact <code>COMBO_RECEIVER_HANDOFF_READY</code>
            。父任务不能从 userMessage、codexDelegation、tool input、echo 或 handoff
            输入匹配该字面量，只在证据之后的该 assistant 输出回证成功时自动导航显示它。
          </li>
          <li>
            完整卡仍显示公开 name；一基序号 action 的 user-role message 只绑定 digest、总数 M 与 N，
            不复制 name 或其他 manifest 自由文本，且整个 card snapshot
            变化都会失败关闭。确认后系统先调用 <code>prepare_codex_agent_run</code> 校验
            URL、digest、精确 starter 成员关系和四项回显； 任一不一致都停止，且不得写本地。
          </li>
          <li>
            prepare 成功后才由 Plugin packaged helper 的 restore mode 把固定 commit 恢复到全新目录，
            目标只能是固定 <code>$HOME/Developer/Combo-shared-projects</code> 下由 commit
            前十二位和随机 nonce 组成的 ASCII child，不能来自 manifest 文本；再独立核对 HEAD、tree
            与 clean 状态，sourceRef 后续推进不能改变旧分享。
          </li>
          <li>
            注册时 exec tool 的 workdir 精确设为已验证 target，只执行一次固定{' '}
            <code>"/Applications/ChatGPT.app/Contents/Resources/codex" app .</code>；路径不得插入
            command string。正式 Host 的 list_projects 最多顺序调用三次，按 canonical exact path
            唯一匹配 saved Project，任一次 Host error/timeout、未命中或多重命中都停止。
          </li>
          <li>
            用户必须在同一次恢复确认中明确选择一条 starter prompt，不默认第一条，也不先建空任务。
            正式 Agent task 的唯一首消息是 flat compact JSON <code>COMBO_CODEX_AGENT_RUN/1</code>
            ，包含来源、digest、完整 instructions 与所选 starter。
          </li>
          <li>
            <code>expectedSourceRef</code> 只记录远端 provenance；当前本地 ref 必须是 deterministic
            restore branch，不能把两者比较相等。V1 sourceRef 只允许 shell-safe 的完整 ASCII
            heads/tags ref。Raw run envelope 是显式 advanced launch
            命令，不证明此前完成卡片或序号确认； 终端 Plugin 必须在任何 preflight 或 Agent
            文本执行前恰好调用一次 <code>prepare_codex_agent_run</code>，并要求四项回显与
            runEnvelope 字节完全一致。失败时零执行； 通过后不再 read、restore、调用 codex
            app、导航或创建下一层任务。只有 preflight 成功且 chosen starter 已实际开始并由 assistant
            agentMessage（<code>phase=final_answer</code>）回证 exact{' '}
            <code>COMBO_CODEX_AGENT_STARTED:{manifestSha256}</code>{' '}
            后，父任务精确核对本次分享摘要才自动显示正式 Agent；失败不导航。
          </li>
          <li>推理和 Agent Harness 由接收者的正式 Codex 负责，Combo 不模拟 Codex。</li>
        </ul>
      </section>

      <section
        className="cb-project-share__panel cb-project-share__copy"
        aria-labelledby="cb-codex-agent-copy-title"
      >
        <h2 id="cb-codex-agent-copy-title">复制到 Codex</h2>
        <p>
          在 Codex 中粘贴并发送这一段自包含文案；缺 Plugin 时会使用 Desktop 内置 CLI 安装，在最终
          metadata 校验后完成一次 Codex-managed OAuth，再进入 projectless
          顶层任务自动续跑；确认恢复后才进入已验证 Project，不默认重启。
        </p>
        <textarea readOnly value={copyPrompt} aria-label="Codex Agent 分享提示" />
        <CopyButton
          text={copyPrompt}
          label="复制到 Codex"
          ariaLabel="复制 Codex Agent 分享提示到 Codex"
          className="cb-project-share__copy-button"
        />
      </section>
    </article>
  );
}
