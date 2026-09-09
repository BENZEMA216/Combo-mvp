import type { ReactElement } from 'react';
import { AgentIcon } from '../../components/AgentIcon.js';
import { CopyInstruction } from '../../components/CopyInstruction.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import './landing.css';

export const CODING_AGENT_CREATION_TASK = `请帮我在当前客户端安装并检查本地 Combo。
先读取官方仓库 https://github.com/dangdang-tech/combo-plugin 的说明，解析并固定当前版本，再按该版本中适用于当前客户端（Codex 或 Claude Code）的安装方式继续。
需要确认时请由当前客户端提示我；仓库无读取权限、客户端不受支持或已有来源与版本冲突时，说明原因并停止，不套用其他客户端命令、不切换来源、不卸载已有插件。
此次只安装和检查，不读取项目内容、其他任务、历史会话或凭据，不开始制作、上传或分享 Agent。就绪后告诉我如何在原对话里留下方法。`;

export function LandingPage(): ReactElement {
  useDocumentTitle('把对话，变成 Agent · Combo');
  return (
    <article className="cb-agent-landing">
      <header className="cb-agent-landing__intro">
        <h1>
          把对话，
          <wbr />
          变成 Agent。
        </h1>
        <p>复制指令，交给 Codex 或 Claude Code。</p>
        <CopyInstruction
          text={CODING_AGENT_CREATION_TASK}
          label="复制指令"
          copiedHint="已复制。粘贴到你的对话，先检查当前客户端的安装支持。"
          className="cb-agent-landing__primary"
        />
      </header>
      <figure
        className="cb-agent-landing__concept"
        aria-label="把你的对话整理成可复用的 Agent，概念示意"
      >
        <div className="cb-agent-landing__conversation">
          <div className="cb-agent-landing__bubbles" aria-hidden="true">
            <div className="cb-agent-landing__bubble">
              <i />
              <i />
            </div>
            <div className="cb-agent-landing__bubble">
              <i />
              <i />
            </div>
            <div className="cb-agent-landing__bubble">
              <i />
              <i />
            </div>
          </div>
          <span>你的对话</span>
        </div>
        <AgentIcon name="arrow" className="cb-agent-landing__arrow" />
        <div className="cb-agent-landing__result">
          <div className="cb-agent-landing__sample" aria-hidden="true">
            <span className="cb-agent-landing__emblem">
              <AgentIcon name="layers" />
            </span>
            <strong>Agent</strong>
          </div>
          <span>随时复用</span>
        </div>
      </figure>
    </article>
  );
}
