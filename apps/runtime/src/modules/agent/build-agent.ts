// pi Agent 的 TurnAgent 实现：CapabilityDefinition.instructions 组系统提示词 +
//   messages 表历史重建 pi AgentMessage[] 直接喂回 + 挂产物工具 + 定模型与密钥。
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai';
import type { CapabilityDefinition, SessionMode } from '@cb/shared';
import type { Env } from '../../platform/config/env.js';
import {
  apiKeyFor,
  hasLlmCredential,
  resolveModel,
  type RuntimeModel,
} from '../../platform/infra/llm.js';
import type { MessageRecord } from '../session/repo.js';
import { withDesignStudioInstructions } from './design-studio-prompt.js';
import { DESIGN_STUDIO_BOOTSTRAP_MARKER } from './design-visual-profile.js';
import { TurnAgentUnavailableError, type TurnAgent, type TurnAgentFactory } from './run-turn.js';

/** 产物协议：约束模型「成品进产物、正文只放说明」。 */
const ARTIFACT_PROTOCOL = [
  '# 产物（Artifact）协议 —— 必须遵守',
  '当你要产出「可独立留存、用户会保存/复用/反复查看」的成品（一篇文档、一个网页、一段代码、一份结构化报告/清单/评分）时，',
  '必须调用 upsert_artifact 工具把成品写成产物，而不是把成品全文堆进聊天正文。',
  '',
  '- 聊天正文只放：简短说明、思路、给用户的提示与追问；成品本体进产物。',
  '- 修改已有产物：带上之前回执里的 artifactId（原地更新同一份产物）；新成品则省略 artifactId。',
  '- kind 选择：',
  '  - html：可交互/可视化网页，会被放进【沙箱 iframe】预览。必须产出【完整自包含 HTML 文档】',
  '    （含 <!doctype html>、<html>、内联 <style>/<script>）；可用公共 CDN，禁止外链需要鉴权的私有资源。',
  '  - markdown：富文本文档（报告/文章/说明）。',
  '  - code：单文件代码产物（用 language 标注语言，如 ts/python/sql）。',
  '  - structured：结构化数据产物（评分卡/清单/字段表），content 用 JSON 字符串。',
  '- 产出后用一两句话说明你做了什么、可以怎么用，并主动邀请用户继续迭代；不要在正文重复产物全文。',
].join('\n');

/** Studio 模式把同一个运行时收束成“对话改 Miniapp”，而不是再次执行这个能力。 */
const STUDIO_PROTOCOL = [
  '# Miniapp 设计模式 —— 必须遵守',
  '你现在是这个 Agent 的设计与前端实现助手。用户正在修改 Agent 的用户界面；',
  '不要把本轮当成一次业务任务执行，也不要直接替用户运行这个能力。',
  '',
  '- 保留原能力的业务目标、输入输出与安全边界；只改用户明确提出的页面、交互、文案与视觉效果。',
  '- 主结果始终是一份 kind=html 的 Miniapp 产物。每次保存都必须调用 upsert_artifact 生成新的不可变 revision；',
  '  Studio 修改时不要传旧 artifactId。只有本轮完整成功后，平台才会把本轮最后一个合法 revision 提升为 Agent 当前 UI。',
  '- 每次写入都必须是可直接渲染的完整自包含 HTML：包含 <!doctype html>、<html>、内联 CSS 与必要的内联 JavaScript。',
  '  不使用外链脚本或外链样式，不依赖本机路径、私有鉴权资源或构建步骤；不能只返回 JSON、代码片段、检查清单、伪页面或实现计划。',
  '  本段规则优先于后文通用 Artifact 协议：Studio 页面不得使用公共 CDN。',
  '- 页面主操作必须带 data-combo-key="run-primary"，把用户当前填写的真实内容整理成非空 prompt，并且只通过',
  "  window.parent.postMessage({ type: 'combo:run', version: 1, prompt }, '*') 请求 Combo Runtime 执行 Agent。",
  '- 发出 combo:run 后，页面只能展示已提交/运行中的等待状态；真正结果由 Runtime 生成并在工作区展示。',
  "- 页面必须监听宿主发回的 { type: 'combo:run-state', version: 1, state, message } 消息：",
  '  running 时禁用主操作并展示真实运行中；completed / failed / blocked 时按宿主状态恢复按钮并展示 message。',
  '  只有收到 state=completed 才能宣告完成，不能由页面自己推断或提前展示成功。',
  '  禁止使用 setTimeout、setInterval、Math.random、mock/fake/dummy 数据、硬编码结果或伪网络请求伪造完成。',
  '- 页面交互必须真实可操作，并清楚表达这项 Agent 的输入、执行动作、进行中、失败与重试状态。',
  '- 没有成功调用 upsert_artifact 就不能声称页面已生成或修改完成。工具成功后，用很短的话说明这次改了什么并邀请继续调整。',
].join('\n');

/**
 * 事实纪律：模型没有可靠的「今天」，也倾向把片段材料外推成完整事实下确定性结论
 * （真实验收中产物写错生成日期、对摘录外代码作否定判断，见 issue #19）。
 * 日期由服务端注入；证据边界作为平台约定强制声明。
 */
function factDiscipline(now: Date): string {
  const date = now.toISOString().slice(0, 10);
  return [
    '# 事实纪律 —— 必须遵守',
    `今天的日期是 ${date}（服务端时间）。产物或正文里需要写日期时以此为准，`,
    '不要凭记忆推断日期；拿不准的时间信息宁可省略，不要编造。',
    '用户提供的材料可能只是片段。只对材料直接支持的事实下确定性结论；',
    '材料没有覆盖的部分，明确写「当前材料未覆盖，需要补充确认」，不要当作已证实的问题或事实。',
    '涉及判断时把内容分清三类：材料直接证明的结论、材料暗示但需要完整信息才能确认的风险、纯建议或待补查项。',
  ].join('\n');
}

/** 编排完整 systemPrompt：作者 instructions 逐字 + 平台注入的运行约定。 */
export function composeSystemPrompt(
  definition: CapabilityDefinition,
  now: Date = new Date(),
  mode: SessionMode = 'consume',
  studioContext: { taskText?: string; hasExistingPage?: boolean } = {},
): string {
  const basePrompt = [
    definition.instructions.trim(),
    '',
    '———',
    '以下为平台注入的运行约定（请严格遵守）：',
    '',
    '# 这个能力',
    `名称：${definition.name}`,
    `简介：${definition.summary}`,
    '',
    factDiscipline(now),
    '',
    ...(mode === 'studio' ? [STUDIO_PROTOCOL, ''] : []),
    ARTIFACT_PROTOCOL,
  ].join('\n');
  if (mode !== 'studio') return basePrompt;

  const taskText = studioContext.hasExistingPage
    ? studioContext.taskText
    : `${DESIGN_STUDIO_BOOTSTRAP_MARKER}\n${studioContext.taskText ?? ''}`;
  return withDesignStudioInstructions(basePrompt, {
    capabilityName: definition.name,
    description: definition.summary,
    inputLabels: definition.inputs.map((input) => input.label),
    outputType: definition.kind,
    taskText,
  });
}

export function composeKnowledgeSystemPrompt(
  knowledge: {
    name: string;
    description: string;
    instructions: string;
    requiresGroundedExtractiveAnswer: boolean;
  },
  now: Date = new Date(),
): string {
  return [
    knowledge.instructions,
    '',
    `名称：${knowledge.name}`,
    `简介：${knowledge.description}`,
    '',
    factDiscipline(now),
    '',
    '# 知识回答协议 —— 必须遵守',
    '你不能用自由文本直接向用户作答。先调用 knowledge_search 检索证据；只可引用本轮返回的 chunkId。',
    '证据充分时调用 submit_knowledge_answer，status=answered，并提交完整答案与升序、不重复的 citationChunkIds。',
    ...(knowledge.requiresGroundedExtractiveAnswer
      ? [
          '每个事实性句子必须逐字复用被引用 excerpt 中的完整原句；不得删改其中的限定、关系、否定、条件、数额、日期或版本。',
          '只提交直接回答用户问题并给出实质信息的完整陈述句，保留原句内部空白和句末标点；每句必须有陈述式终止标点及主题之外的明确谓语或事实增量。FAQ 问句、Markdown 标题/列表、名词型片段、问题原样复述、短动作嵌入另一个词，以及只共享单字母、短数字、单个年份或 API/HTTP/HTTPS token 的内容都视为证据不足。',
          '当前中文 Beta 不做自由语义改写或前提纠正：只结构化去掉分句尾完整疑问壳、末尾问句粒子、句首整体指示脚手架，或至多一个有足够上下文的疑问操作词；分句尾疑问壳优先，实体或标题内部的同形字样不能删除。剩余实体、名词属性、动作、关系、否定、条件、时间与限定必须直接对齐，并按连续原文由整段答案逐组覆盖；每个答案句至少覆盖一组并包含问题中的全部拉丁字母或数字限定。缺少任一主题、关系或限定都提交 insufficient_evidence。',
        ]
      : []),
    '证据不足时调用 submit_knowledge_answer，status=insufficient_evidence，不要填写 answer 或 citations。',
    '每轮只能提交一次。提交后停止；模型正文和工具转录都只是候选，不会直接展示给用户。',
  ].join('\n');
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * messages 行 → pi AgentMessage[]（喂回 agent 重建上下文）。
 *   content 块原样回放（写入时已过 schema 校验）；assistant 的 api/provider/usage 等
 *   元数据不落库，用当前模型 + 零 usage 补齐——convertToLlm 只消费 role/content，无损。
 */
export function historyToAgentMessages(rows: MessageRecord[], model: RuntimeModel): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const row of rows) {
    const timestamp = Date.parse(row.createdAt) || Date.now();
    if (row.role === 'user') {
      const message: UserMessage = {
        role: 'user',
        content: row.content as UserMessage['content'] & unknown[],
        timestamp,
      };
      out.push(message);
    } else if (row.role === 'assistant') {
      const content = row.content as AssistantMessage['content'];
      const message: AssistantMessage = {
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp,
      };
      out.push(message);
    } else {
      // role='tool' 行：单元素 toolResult 包装块 → pi ToolResultMessage（配对信息在块内）。
      for (const block of row.content as Array<{
        toolCallId: string;
        toolName: string;
        content: ToolResultMessage['content'];
        isError: boolean;
      }>) {
        const message: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          content: block.content,
          isError: block.isError,
          timestamp,
        };
        out.push(message);
      }
    }
  }
  return out;
}

/** 生产 TurnAgentFactory：pi Agent 包装成 run-turn 消费的最小面。 */
export function createPiTurnAgentFactory(env: Env): TurnAgentFactory {
  return ({
    definition,
    history,
    tools,
    mode,
    promptText,
    hasExistingStudioArtifact,
    knowledge,
  }) => {
    if (!hasLlmCredential(env)) {
      throw new TurnAgentUnavailableError(
        '试用服务未配置模型密钥（ANTHROPIC_API_KEY 或 OPENROUTER_API_KEY），暂时无法对话。',
      );
    }
    const model = resolveModel(env);
    const agent = new Agent({
      initialState: {
        systemPrompt: knowledge
          ? composeKnowledgeSystemPrompt(knowledge)
          : composeSystemPrompt(definition, new Date(), mode, {
              taskText: promptText,
              hasExistingPage: hasExistingStudioArtifact,
            }),
        model,
        tools,
        messages: knowledge ? [] : historyToAgentMessages(history, model),
        thinkingLevel: 'off',
      },
      // 按 model.provider 注入对应 key（anthropic→ANTHROPIC_API_KEY / openrouter→OPENROUTER_API_KEY）。
      getApiKey: (provider) => apiKeyFor(env, provider),
    });

    return {
      subscribeTextDelta(fn) {
        return agent.subscribe((event: AgentEvent) => {
          if (
            event.type === 'message_update' &&
            event.assistantMessageEvent.type === 'text_delta'
          ) {
            fn(event.assistantMessageEvent.delta);
          }
        });
      },
      subscribeActivity(fn) {
        // 任意 agent 事件都算活动（含工具调用参数流等非文本事件），供空闲看门狗判活。
        return agent.subscribe(() => fn());
      },
      prompt: (text) => agent.prompt(text),
      abort: () => agent.abort(),
      transcript: () => agent.state.messages as unknown[],
      runtimeError: () => {
        const stateError = (agent.state as { errorMessage?: string | null }).errorMessage;
        if (stateError != null) return stateError;
        const last = [...agent.state.messages]
          .reverse()
          .find((m) => (m as { role?: string }).role === 'assistant') as
          | { stopReason?: string; errorMessage?: string }
          | undefined;
        if (last?.stopReason === 'error') return last.errorMessage ?? 'llm runtime error';
        return undefined;
      },
    } satisfies TurnAgent;
  };
}
