import { createHash, randomBytes } from 'node:crypto';
import {
  CODEX_AGENT_SHARE_SCHEMA_VERSION,
  CODEX_AGENT_SHARE_TEST_ORIGIN,
  CodexAgentShareTokenSchema,
  ProjectAgentRequirementsSchema,
  canonicalJson,
  renderCodexAgentRunEnvelope,
  renderCodexReceiverBootstrapHandoff,
  type CodexAgentShareManifest,
  type CodexAgentShareResult,
  type CreateCodexAgentShareBody,
  type PrepareCodexAgentRunBody,
  type PrepareCodexAgentRunResult,
} from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import {
  insertCodexAgentShare,
  readCodexAgentShareByToken,
  type CodexAgentShareRecord,
  type CreateCodexAgentShareOutcome,
} from './repo.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePublicOrigin(publicOrigin: string): string {
  const url = new URL(publicOrigin);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('codex agent public origin is invalid');
  }
  return url.origin;
}

export function codexAgentShareUrl(publicOrigin: string, shareToken: string): string {
  const token = CodexAgentShareTokenSchema.parse(shareToken);
  return new URL(`/agent/${token}`, normalizePublicOrigin(publicOrigin)).toString();
}

export function codexAgentShareTokenFromUrl(publicOrigin: string, shareUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(shareUrl);
  } catch {
    return null;
  }
  if (
    parsed.origin !== normalizePublicOrigin(publicOrigin) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  const match = parsed.pathname.match(/^\/agent\/([A-Za-z0-9_-]{43})$/u);
  if (!match || !match[1] || codexAgentShareUrl(publicOrigin, match[1]) !== shareUrl) {
    return null;
  }
  return match[1];
}

/** Frozen by combo.codex-agent-share/1. Add a new renderer instead of editing this text. */
function renderCodexAgentCopyPromptV1(shareUrl: string, manifestSha256: string): string {
  const receiverHandoff = renderCodexReceiverBootstrapHandoff({
    shareUrl,
    manifestSha256,
  });
  return [
    `请在 macOS Codex Desktop 中接收 Combo Codex Agent Share（schema combo.codex-agent-share/1）：${shareUrl}；期望 manifestSha256=${manifestSha256}。`,
    '该 shareUrl 必须逐字匹配 https://test.43-160-242-46.sslip.io/agent/<43-token>：协议、origin、/agent 路径和 43 字符 token 都精确，且不得含 userinfo、query 或 hash；任一不符立即 STOP。',
    `先只读检查当前任务是否同时可调用 render_agent_builder、create_codex_agent_share、read_codex_agent_share、prepare_codex_agent_run，并按下述 Desktop CLI 步骤检查 Plugin metadata。只有四工具与 official source、installed/enabled semver>=0.7.0、精确 Test MCP 全部在初始检查中满足，才留在当前任务。任一缺失、过旧或不合时，只冻结以下 Host-safe ASCII compact JSON 为后续 create_thread 的唯一 structured prompt：receiverHandoff=${receiverHandoff}。它的 schemaVersion=combo.receiver-bootstrap-handoff/1，固定字段顺序与 behaviorMarker=COMBO_RECEIVER_HANDOFF_READY 必须逐字保留，不得加入 instructions、starter、路径、Project ID、threadId、messages、session、原始会话或 Host wrapper。此 handoff 不是用户确认；接收者此时可能处于任意 Project 或无 Project，不能沿用 Creator 的 saved Project handoff。`,
    '每次 CLI 调用都直接使用绝对路径 "/Applications/ChatGPT.app/Contents/Resources/codex"；不得依赖环境变量在不同 exec 调用间持久，也不依赖 PATH。',
    '先分别执行 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace list --json 与 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin list --marketplace dangdang-tech-combo --available --json，记录 marketplaceInitiallyPresent 与 upgradePerformed=false；Plugin metadata 每次都必须使用这个 Marketplace-filtered 短 JSON 命令，禁止改回可能被 Host 输出截断的全量 plugin list --json。若 name=dangdang-tech-combo 已存在，必须确认 marketplaceSource.sourceType=git 且 marketplaceSource.source 精确等于 https://github.com/dangdang-tech/combo-plugin.git；同名错源、Plugin 已安装但 Marketplace 缺失、无效语义版本等异常组合立即 STOP，不 remove、不覆盖。',
    '若 Marketplace 与 Plugin 初始都缺失，执行 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace add https://github.com/dangdang-tech/combo-plugin.git --ref codex/combo-plugin-v2-ui --json，再重新执行 marketplace list 与 plugin list 并验证官方 source。若 marketplaceInitiallyPresent=true 且官方 Marketplace 已存在、Plugin 缺失或有效 version<0.7.0，则先精确验证官方 source，再恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace upgrade dangdang-tech-combo --json，设置 upgradePerformed=true，并重新读取两份 metadata。无论 marketplaceInitiallyPresent 初值为何，只要此时已确认 official Marketplace 且 Plugin 仍缺失，就恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin add combo@dangdang-tech-combo --json，并再次读取 plugin list；同一状态机内 plugin add 最多一次。fresh install 的固定顺序必须是 marketplace add→重新读取并确认 official source→plugin add→最终检查。',
    '若 Plugin add 或刷新后得到有效 version<0.7.0 且 upgradePerformed=false，必须重新验证 official Marketplace source，恰好再执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace upgrade dangdang-tech-combo --json，设置 upgradePerformed=true，并重新读取 marketplace list 与 plugin list；若升级后仍低于 0.7.0，或 upgradePerformed=true 时仍低于 0.7.0，立即 STOP。整个状态机 marketplace upgrade 最多执行一次。',
    '最后再次执行 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace list --json、"/Applications/ChatGPT.app/Contents/Resources/codex" plugin list --marketplace dangdang-tech-combo --available --json 与 "/Applications/ChatGPT.app/Contents/Resources/codex" mcp get combo --json；最终 Plugin 必须是有效语义版本且 version>=0.7.0、installed=true、enabled=true、marketplaceSource 精确匹配，MCP 必须得到 name=combo、enabled=true、disabled_reason=null、transport.type=streamable_http，且 transport.url 精确等于 https://test.43-160-242-46.sslip.io/api/external-mcp/mcp；不符立即 STOP，不 remove、不 mcp add。',
    '若初始检查的四工具与全部 metadata 已同时满足，跳过安装变更、receiverHandoff 与 projectless create_thread，直接留在当前任务执行 readiness 和只读展示；此 stay-current 分支在首次 Combo 工具调用前主动 mcp login combo 的调用数必须为 0。否则完成安全安装/升级与最终 metadata 校验后、任何 create_thread 之前，必须用绝对 bundled CLI 恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" mcp login combo 完成 Codex-managed OAuth；失败或用户取消立即 STOP，create_thread 调用数必须为 0。OAuth 成功后才由正式 Host 精确调用 create_thread({prompt:receiverHandoff,target:{type:"projectless"}}) 创建 projectless 顶层续跑任务。子任务必须 parse 唯一 structured prompt 中逐字相同的 receiverHandoff、完成 readiness、读取同一分享、完整重显 manifest 与有序 starter 卡，并在这些证据之后的 assistant agentMessage（phase="final_answer"）中以独立一行逐字输出 COMBO_RECEIVER_HANDOFF_READY；到此 prepare、restore、codex app 与正式 Agent create_thread 的调用数都为 0。只返回 clientThreadId 时立即失败关闭，不能把它传给 wait_threads/read_thread，也不能重建任务。只有同时返回 ready threadId 与 hostId 才调用 wait_threads，再用 list_threads 按该 threadId 核对 documented project context 的 projectId=null，并用 read_thread({threadId,hostId,includeOutputs:true,maxOutputCharsPerItem:20000,turnLimit:10}) 要求同一个 status=completed、error=null 的首轮中、marker 前以下 lifecycle signature 各恰好一次且按序：server=combo、tool=render_agent_builder、arguments 深度等于固定 readiness payload 且 status=completed；server=combo、tool=read_codex_agent_share、arguments 深度等于同一 shareUrl 且 status=completed；server=combo、tool=render_agent_builder、arguments 深度等于包含同一 manifestSha256、createdAt、完整有序 starter 项与每项 ordinal action 的 project_restore 确认卡且 status=completed；最后才是 assistant marker。该 turn 中 commandExecution 与 fileChange 必须均为 0；任何重复或额外 Combo lifecycle mcpToolCall，以及任何 restore、codex app、create_thread、list_projects、navigate_to_codex_page 等 known forbidden dynamicToolCall 都失败关闭。mcpToolCall 不含 result、structuredContent 或 error，completed 只证明调用结束，不能证明业务结果或 digest；子任务仍须内部核验，完整 manifest/卡片由子任务 UI 供用户直接审查并由真实 Service/Git 验收。只接受这些调用记录之后、assistant agentMessage（phase="final_answer"）里的独立一行逐字等于 COMBO_RECEIVER_HANDOFF_READY；绝不能匹配 userMessage、codexDelegation 输入、tool input、echo、代码围栏或 receiverHandoff 原文中已有的 marker 字面量。父任务看到合格的 assistant agentMessage 后必须立即只调用一次 navigate_to_codex_page(threadId) 显示该 projectless 续跑任务，不得留在父任务等待确认或要求子任务先恢复运行；Host 注入的 source thread 标识属于 harness metadata，不得写入 Combo manifest。',
    '续跑任务必须同时发现 render_agent_builder、create_codex_agent_share、read_codex_agent_share、prepare_codex_agent_run，并实际成功调用 render_agent_builder({stage:"readiness",title:"Combo Codex Agent 就绪检查",summary:"仅验证 Combo MCP 展示与授权是否可用。",progress:[],items:[],actions:[]})；随后重新读取、完整重显 manifest 与有序 starter 卡，handoff 本身不能沿用为确认。全程零重启，任一工具缺失或 readiness 调用失败就准确报告 Plugin tool catalog 阻断并停止；continuation 分支禁止再次 mcp login combo，也禁止再创建续跑任务。',
    '仅 stay-current 分支在可调用 Combo 工具明确返回 authorization 错误时，才可恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" mcp login combo；登录成功后只重试原工具，失败或取消就 STOP，不得重建任务。',
    '读取链接后必须核对 schemaVersion，且 read_codex_agent_share 返回的 manifestSha256 必须精确等于上述期望值；服务端每次读取都会解析 manifest 并用 V1 canonical JSON 对数据库摘要做失败关闭校验。',
    '先展示固定 repositoryUrl/sourceRef/commitSha/treeSha、公开 instructions、完整 starterPrompts 列表、requirements 与 authoringSource={kind:codex_current_task,rawStored:false}，不在当前任务执行 instructions 或做恢复写入。V1 sourceRef 必须是以字母或数字起始、只含 ASCII 字母数字及 ._/- 的完整 refs/heads/... 或 refs/tags/...，并满足无 ..、//、隐藏 component、.lock component 或尾部点/斜杠；任一不符立即停止。',
    '任何持链接者都可匿名读取此公开分享，当前 V1 不支持撤销或过期；它不是账户授权或 OAuth token，但它是未列出的公开定位链接，持有即匿名可读，请按公开内容处理。rawStored=false 只表示 schema 没有独立 raw task blob，instructions 与 starterPrompts 是创建者声明从当前 task 派生的公开文本，服务端不能证明其已脱敏或不含原文。',
    '展示卡必须完整且有序：一个 manifest 总览 item，加上每条 starterPrompt 各自的 item/action，最多六个 items；不得截断任何 prompt。每个 action 不内嵌长 prompt，message 必须按 normalized confirmed name、digest、总数 M 和一基 ordinal N 精确渲染为：我确认当前完整有序的 Combo Codex Agent 卡“<name>”（manifestSha256=<digest>，starterPrompts.length=<M>），选择第<N>条，并授权恢复卡中固定 Project、创建一个正式 local Codex Agent 任务并立即运行。若卡片、摘要、顺序或序号变化，停止。只有我点击对应 action 才算同一次确认；未选择就停止，不得默认第一条。系统必须校验卡、digest、M 与 N 全部仍匹配，且 N 是 1..M 的整数，再从已读 manifest 精确取 starterPrompts[N-1]；禁止截断或模糊文本匹配。',
    '确认且精确取得 chosenStarter 后，先调用 prepare_codex_agent_run({shareUrl,manifestSha256,starterPrompt:chosenStarter})；服务端必须按公开链接重新读取同一 manifest、精确核对期望 digest 和 starter 唯一成员关系，并回显完全相同的 shareUrl、manifestSha256、starterPrompt 与一个权威 runEnvelope。必须先校验四项回显和 runEnvelope 契约，任一不一致都停止且不得写本地。把返回 runEnvelope 原样指定为 frozen；不得由 Plugin 或模型自行构造、拼接、canonicalize 或 JSON.stringify。',
    '确认与选择齐全后，由已安装 Skill 按其参数契约调用 Plugin packaged helper 的 restore mode，把 manifest 固定 commit 恢复到固定 parent $HOME/Developer/Combo-shared-projects 下全新生成的 ASCII child combo-agent-<commitSha前12>-<16 lowercase hex nonce>。child 不得来自 manifest 的 name、description、instructions、starter 或任意路径文本；helper 只接收 schema 已验证的固定来源字段与这个安全生成目标，不能把未受信文本插入 shell command。接收端不得调用 creator 专用的 verify-source，也不得因 sourceRef 后续推进而改用新 commit。',
    'restore 完成后必须独立核对新目录的 HEAD 精确等于 manifest.source.commitSha、tree 精确等于 manifest.source.treeSha 且 worktree clean；不得内嵌自制 shell 恢复实现。',
    '全部通过后，通过 exec tool 把 workdir 精确设置为已验证 target，只执行固定命令 "/Applications/ChatGPT.app/Contents/Resources/codex" app . 一次，将该目录注册并打开为 saved Project；不得把 target 路径插入 command string，这一步不算 Agent 启动。',
    '随后正式 Host 的 list_projects 最多顺序调用三次，等待 canonical exact path 唯一匹配；任一次 Host error/timeout、三次后仍为 0 个或任一次多于 1 个匹配都阻断。',
    '唯一匹配后，确认 frozen 仍是 prepare_codex_agent_run 返回的同一逐字 runEnvelope；expectedSourceRef 只作远端 provenance，当前本地 ref 必须由 deterministic restore branch 校验。不得先创建空 Agent task 后再选择，也不得发送第二条启动消息。',
    `正式 Host 必须精确调用 create_thread({prompt:frozen,target:{type:"project",projectId,environment:{type:"local"}}})。只返回 clientThreadId 时立即失败关闭，不能把它传给 wait_threads/read_thread，也不能重建任务；只有同时返回 ready threadId 与 hostId 才调用 wait_threads，再用 list_threads 按该 threadId 核对 documented project context 的 projectId 精确匹配，并用 read_thread({threadId,hostId,includeOutputs:true,maxOutputCharsPerItem:20000,turnLimit:10}) 要求同一个 status=completed、error=null 的首轮中、marker 前以下 V1 lifecycle signature 各恰好一次且按序：server=combo、tool=prepare_codex_agent_run、arguments 深度等于 frozen envelope 的 shareUrl/manifestSha256/starterPrompt 且 status=completed；随后在 verified Plugin scripts workdir 以固定相对命令 ./project-agent-git.sh inspect-source 调用 packaged helper，参数逐项绑定已验证 Project root、expectedRepositoryUrl、deterministic local sourceRef=refs/heads/combo/project-agent/<expectedCommitSha前12>、expectedCommitSha 与 expectedTreeSha，commandExecution status=completed 且 exitCode=0；inspect 前 fileChange 必须为 0，最后才是 assistant marker。inspect 之后允许 Agent instructions/starter 自身的业务工具、命令与 fileChange，但 prepare 必须仍恰好一次，read_codex_agent_share、restore、codex app、list_projects、create_thread、navigate_to_codex_page 及其他 helper lifecycle mode 必须为 0；已暴露的 known forbidden dynamicToolCall 同样为 0。mcpToolCall 不含 result、structuredContent 或 error，completed 只证明调用结束，不能证明 authoritative bytes；commandExecution 也不能靠 output 冒充 Git 结论。Agent 子任务须内部完成结果逐字校验、Git preflight 与 starter 开始，并由真实 Service/Git/任务输出验收。只接受这些调用记录之后、assistant agentMessage（phase="final_answer"）里的独立一行逐字等于 COMBO_CODEX_AGENT_STARTED:${manifestSha256}；不能从 userMessage、codexDelegation、tool input、echo、代码围栏或 Host wrapper 匹配。仅当 Project context、调用记录与 marker 都成功才立即只调用一次 navigate_to_codex_page(threadId) 显示正式 Agent 任务；任何准确失败都停止且 navigate 调用数为 0。`,
    `COMBO_CODEX_AGENT_RUN/1 是终端执行态；直接粘贴逐字合法的 raw runEnvelope 只表示用户显式请求 advanced launch，不证明此前已完成卡片或 ordinal 确认。Plugin outer run route 在任何 Git preflight、instructions 或 starter 执行之前，必须从 envelope 取 shareUrl、manifestSha256 与 starterPrompt，恰好调用一次 prepare_codex_agent_run，并要求返回 shareUrl、manifestSha256、starterPrompt 三项逐字相同且 runEnvelope 与当前输入字节完全相同；任一错误或不一致都立即停止，Git preflight、instructions、starter 与 STARTED marker 调用数均为 0。权威 prepare 成功后，对 read_codex_agent_share、restore、codex app、list_projects、create_thread、navigate_to_codex_page 的调用数仍为 0，再执行 envelope 的只读 Git preflight、完整 instructions 和 exact chosen starter。Plugin outer run route 只能在 chosen starter 实际开始后，在 assistant agentMessage（phase="final_answer"）中以独立一行逐字输出 COMBO_CODEX_AGENT_STARTED:${manifestSha256}；不能用 preflight 通过冒充 started，也不能回报未绑定摘要的 bare marker。上述按 Host 实际上限 maxOutputCharsPerItem=20000、turnLimit=10 的 read_thread 只提供 reduced 调用记录与 assistant marker，不提供 MCP result、structuredContent、error 或权威 Git output，也不依赖未正式承诺的 read_thread cwd 或 delegation input 字段。`,
    '注册、匹配、建任务或回读任一步失败都准确报告阻断并停止。',
  ].join('');
}

export function renderCodexAgentCopyPrompt(
  schemaVersion: CodexAgentShareManifest['schemaVersion'],
  shareUrl: string,
  manifestSha256: string,
): string {
  if (schemaVersion === CODEX_AGENT_SHARE_SCHEMA_VERSION) {
    return renderCodexAgentCopyPromptV1(shareUrl, manifestSha256);
  }
  throw new Error('unsupported Codex Agent share schema version');
}

/** Fixed cross-repository receiver prompt fixture. Keep the digest literal as a release gate. */
export const CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_FIXTURE = {
  schemaVersion: CODEX_AGENT_SHARE_SCHEMA_VERSION,
  shareUrl: `${CODEX_AGENT_SHARE_TEST_ORIGIN}/agent/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
  manifestSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
} as const;
export const CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN = renderCodexAgentCopyPrompt(
  CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_FIXTURE.schemaVersion,
  CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_FIXTURE.shareUrl,
  CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_FIXTURE.manifestSha256,
);
export const CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_SHA256 =
  'ce7dffc6f8ccfd11d99eabffcd86e5a8d8895553e29593ca3934f1cc09468faf' as const;

function toResult(publicOrigin: string, record: CodexAgentShareRecord): CodexAgentShareResult {
  const shareUrl = codexAgentShareUrl(publicOrigin, record.shareToken);
  return {
    manifest: record.manifest,
    manifestSha256: record.manifestSha256,
    shareUrl,
    copyPrompt: renderCodexAgentCopyPrompt(
      record.manifest.schemaVersion,
      shareUrl,
      record.manifestSha256,
    ),
  };
}

export type CreateCodexAgentShareServiceOutcome =
  | { kind: 'created' | 'replayed'; result: CodexAgentShareResult }
  | { kind: 'environment_conflict' }
  | Extract<CreateCodexAgentShareOutcome, { kind: 'idempotency_conflict' }>;

export type ReadCodexAgentShareServiceOutcome =
  | { kind: 'found'; result: CodexAgentShareResult }
  | { kind: 'not_found' }
  | { kind: 'invalid_url' };

export type PrepareCodexAgentRunServiceOutcome =
  | { kind: 'found'; result: PrepareCodexAgentRunResult }
  | { kind: 'not_found' }
  | { kind: 'invalid_url' }
  | { kind: 'digest_mismatch' }
  | { kind: 'starter_not_found' };

export async function createCodexAgentShare(
  db: Queryable,
  input: {
    ownerUserId: string;
    body: CreateCodexAgentShareBody;
    publicOrigin: string;
    comboEnvironment: string;
    now?: () => Date;
    randomToken?: () => string;
  },
): Promise<CreateCodexAgentShareServiceOutcome> {
  // V1 copyPrompt is a frozen Test receiver contract. Other environments may read an
  // existing share, but must never mint a new row that points its receiver at Test.
  if (
    input.comboEnvironment !== 'test' ||
    normalizePublicOrigin(input.publicOrigin) !== CODEX_AGENT_SHARE_TEST_ORIGIN
  ) {
    return { kind: 'environment_conflict' };
  }
  const requirements = ProjectAgentRequirementsSchema.parse(input.body.requirements ?? {});
  const source = {
    repositoryUrl: input.body.repositoryUrl,
    sourceRef: input.body.sourceRef,
    commitSha: input.body.commitSha,
    treeSha: input.body.treeSha,
  };
  const agent = {
    instructions: input.body.agent.instructions,
    starterPrompts: input.body.agent.starterPrompts,
  };
  const authoringSource = { kind: 'codex_current_task' as const, rawStored: false as const };
  const idempotencySha256 = sha256(
    canonicalJson({
      schemaVersion: CODEX_AGENT_SHARE_SCHEMA_VERSION,
      name: input.body.name,
      description: input.body.description,
      source,
      agent,
      authoringSource,
      requirements,
    }),
  );
  const manifest: CodexAgentShareManifest = {
    schemaVersion: CODEX_AGENT_SHARE_SCHEMA_VERSION,
    name: input.body.name,
    description: input.body.description,
    source,
    agent,
    authoringSource,
    requirements,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  const shareToken = CodexAgentShareTokenSchema.parse(
    (input.randomToken ?? (() => randomBytes(32).toString('base64url')))(),
  );
  const manifestSha256 = sha256(canonicalJson(manifest));
  const outcome = await insertCodexAgentShare(db, {
    ownerUserId: input.ownerUserId,
    shareToken,
    manifest,
    manifestSha256,
    idempotencyKey: input.body.idempotencyKey,
    idempotencySha256,
  });
  if (outcome.kind === 'idempotency_conflict') return outcome;
  return { kind: outcome.kind, result: toResult(input.publicOrigin, outcome.record) };
}

export async function readCodexAgentShare(
  db: Queryable,
  input: { publicOrigin: string; shareUrl: string },
): Promise<ReadCodexAgentShareServiceOutcome> {
  const shareToken = codexAgentShareTokenFromUrl(input.publicOrigin, input.shareUrl);
  if (!shareToken) return { kind: 'invalid_url' };
  return readCodexAgentShareWithToken(db, { publicOrigin: input.publicOrigin, shareToken });
}

export async function readCodexAgentShareWithToken(
  db: Queryable,
  input: { publicOrigin: string; shareToken: string },
): Promise<ReadCodexAgentShareServiceOutcome> {
  const parsed = CodexAgentShareTokenSchema.safeParse(input.shareToken);
  if (!parsed.success) return { kind: 'invalid_url' };
  const record = await readCodexAgentShareByToken(db, parsed.data);
  if (!record) return { kind: 'not_found' };
  return { kind: 'found', result: toResult(input.publicOrigin, record) };
}

export async function prepareCodexAgentRun(
  db: Queryable,
  input: { publicOrigin: string; body: PrepareCodexAgentRunBody },
): Promise<PrepareCodexAgentRunServiceOutcome> {
  const read = await readCodexAgentShare(db, {
    publicOrigin: input.publicOrigin,
    shareUrl: input.body.shareUrl,
  });
  if (read.kind !== 'found') return read;
  if (read.result.manifestSha256 !== input.body.manifestSha256) {
    return { kind: 'digest_mismatch' };
  }
  if (!read.result.manifest.agent.starterPrompts.includes(input.body.starterPrompt)) {
    return { kind: 'starter_not_found' };
  }
  return {
    kind: 'found',
    result: {
      shareUrl: read.result.shareUrl,
      manifestSha256: read.result.manifestSha256,
      starterPrompt: input.body.starterPrompt,
      runEnvelope: renderCodexAgentRunEnvelope({
        manifest: read.result.manifest,
        manifestSha256: read.result.manifestSha256,
        shareUrl: read.result.shareUrl,
        chosenStarterPrompt: input.body.starterPrompt,
      }),
    },
  };
}
