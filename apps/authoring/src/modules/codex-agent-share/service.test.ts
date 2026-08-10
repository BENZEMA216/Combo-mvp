import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  CODEX_AGENT_SHARE_TEST_ORIGIN,
  canonicalJson,
  renderCodexAgentRunEnvelope,
  renderCodexReceiverBootstrapHandoff,
  type CreateCodexAgentShareBody,
  type CreateProjectAgentShareBody,
} from '@cb/shared';
import type { Queryable, QueryResultLike } from '../../platform/infra/db.js';
import {
  createProjectAgentShare,
  readProjectAgentShareWithToken,
} from '../project-agent-share/index.js';
import { getCodexAgentShareHandler } from './handlers.js';
import {
  CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN,
  CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_FIXTURE,
  CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_SHA256,
  createCodexAgentShare,
  prepareCodexAgentRun,
  readCodexAgentShare,
  readCodexAgentShareWithToken,
  renderCodexAgentCopyPrompt,
} from './service.js';

const OWNER_A = '00000000-0000-4000-8000-000000000001';
const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = 'B'.repeat(43);
const NOW = new Date('2026-08-10T00:00:00.000Z');
const PUBLIC_ORIGIN = CODEX_AGENT_SHARE_TEST_ORIGIN;

const body: CreateCodexAgentShareBody = {
  name: 'Repository reviewer',
  description: 'Review one immutable Git Project with a task-derived Agent.',
  repositoryUrl: 'https://github.com/openai/codex.git',
  sourceRef: 'refs/heads/main',
  commitSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  agent: {
    instructions: 'PRIVATE-DERIVED-INSTRUCTIONS: review changes against repository conventions.',
    starterPrompts: ['Review the current branch.', 'Explain the architecture.'],
  },
  requirements: {
    commands: ['git'],
    plugins: ['combo@dangdang-tech-combo'],
    environmentVariableNames: [],
  },
  idempotencyKey: '00000000-0000-4000-8000-000000000002',
};

interface StoredRow {
  id: string;
  owner_user_id: string;
  share_token: string;
  manifest: Record<string, unknown>;
  manifest_sha256: string;
  idempotency_key: string;
  idempotency_sha256: string;
  created_at: string;
}

class FakeShareDb implements Queryable {
  readonly rows: StoredRow[] = [];
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.queries.push({ sql, params });
    if (sql.includes('INSERT INTO project_agent_shares')) {
      const existing = this.rows.find(
        (row) => row.owner_user_id === params[0] && row.idempotency_key === params[4],
      );
      if (existing) return { rows: [], rowCount: 0 };
      const row: StoredRow = {
        id: '00000000-0000-4000-8000-000000000099',
        owner_user_id: String(params[0]),
        share_token: String(params[1]),
        manifest: JSON.parse(String(params[2])) as Record<string, unknown>,
        manifest_sha256: String(params[3]),
        idempotency_key: String(params[4]),
        idempotency_sha256: String(params[5]),
        created_at: String(params[6]),
      };
      this.rows.push(row);
      return { rows: [row as R], rowCount: 1 };
    }
    if (sql.includes('WHERE owner_user_id')) {
      const row = this.rows.find(
        (candidate) =>
          candidate.owner_user_id === params[0] && candidate.idempotency_key === params[1],
      );
      return { rows: row ? [row as R] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('WHERE share_token')) {
      const row = this.rows.find((candidate) => candidate.share_token === params[0]);
      return { rows: row ? [row as R] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

async function create(db: FakeShareDb, overrides: Partial<CreateCodexAgentShareBody> = {}) {
  return createCodexAgentShare(db, {
    ownerUserId: OWNER_A,
    body: { ...body, ...overrides },
    publicOrigin: PUBLIC_ORIGIN,
    comboEnvironment: 'test',
    now: () => NOW,
    randomToken: () => TOKEN_A,
  });
}

describe('Codex Agent share service', () => {
  it.each(['development', 'preview', 'production'])(
    'fails closed before storage when %s tries to mint the Test-frozen V1 prompt',
    async (comboEnvironment) => {
      const db = new FakeShareDb();
      const randomToken = vi.fn(() => TOKEN_A);
      await expect(
        createCodexAgentShare(db, {
          ownerUserId: OWNER_A,
          body,
          publicOrigin: 'https://other.example',
          comboEnvironment,
          now: () => NOW,
          randomToken,
        }),
      ).resolves.toEqual({ kind: 'environment_conflict' });
      expect(db.queries).toHaveLength(0);
      expect(randomToken).not.toHaveBeenCalled();
    },
  );

  it('fails closed before storage when Test is rendered on any non-Test public origin', async () => {
    const db = new FakeShareDb();
    const randomToken = vi.fn(() => TOKEN_A);
    await expect(
      createCodexAgentShare(db, {
        ownerUserId: OWNER_A,
        body,
        publicOrigin: 'https://other.example',
        comboEnvironment: 'test',
        now: () => NOW,
        randomToken,
      }),
    ).resolves.toEqual({ kind: 'environment_conflict' });
    expect(db.queries).toHaveLength(0);
    expect(randomToken).not.toHaveBeenCalled();
  });

  it('replays byte-identically and freezes the self-contained receiver prompt without raw text', async () => {
    const db = new FakeShareDb();
    const first = await create(db);
    const replay = await createCodexAgentShare(db, {
      ownerUserId: OWNER_A,
      body,
      publicOrigin: PUBLIC_ORIGIN,
      comboEnvironment: 'test',
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      randomToken: () => TOKEN_B,
    });

    expect(first.kind).toBe('created');
    expect(replay).toEqual({ ...first, kind: 'replayed' });
    expect(db.rows).toHaveLength(1);
    if (first.kind !== 'created') throw new Error('unexpected outcome');
    expect(first.result.shareUrl).toBe(`${PUBLIC_ORIGIN}/agent/${TOKEN_A}`);
    expect(first.result.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.result.manifestSha256).toBe(db.rows[0]?.manifest_sha256);
    expect(canonicalJson(first.result.manifest)).toContain('codex_current_task');
    expect(first.result.manifest.authoringSource).toEqual({
      kind: 'codex_current_task',
      rawStored: false,
    });
    const receiverHandoff = renderCodexReceiverBootstrapHandoff({
      shareUrl: first.result.shareUrl,
      manifestSha256: first.result.manifestSha256,
    });
    expect(first.result.copyPrompt).toBe(
      [
        `请在 macOS Codex Desktop 中接收 Combo Codex Agent Share（schema combo.codex-agent-share/1）：${PUBLIC_ORIGIN}/agent/${TOKEN_A}；期望 manifestSha256=${first.result.manifestSha256}。`,
        '该 shareUrl 必须逐字匹配 https://test.43-160-242-46.sslip.io/agent/<43-token>：协议、origin、/agent 路径和 43 字符 token 都精确，且不得含 userinfo、query 或 hash；任一不符立即 STOP。',
        `先只读检查当前任务是否同时可调用 render_agent_builder、create_codex_agent_share、read_codex_agent_share、prepare_codex_agent_run，并按下述 Desktop CLI 步骤检查 Plugin metadata。只有四工具与 official source、installed/enabled semver>=0.7.0、精确 Test MCP 全部在初始检查中满足，才留在当前任务。任一缺失、过旧或不合时，只冻结以下 Host-safe ASCII compact JSON 为后续 create_thread 的唯一 structured prompt：receiverHandoff=${receiverHandoff}。它的 schemaVersion=combo.receiver-bootstrap-handoff/1，固定字段顺序与 behaviorMarker=COMBO_RECEIVER_HANDOFF_READY 必须逐字保留，不得加入 instructions、starter、路径、Project ID、threadId、messages、session、原始会话或 Host wrapper。此 handoff 不是用户确认；接收者此时可能处于任意 Project 或无 Project，不能沿用 Creator 的 saved Project handoff。`,
        '每次 CLI 调用都直接使用绝对路径 "/Applications/ChatGPT.app/Contents/Resources/codex"；不得依赖环境变量在不同 exec 调用间持久，也不依赖 PATH。',
        '先分别执行 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace list --json 与 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin list --json，记录 marketplaceInitiallyPresent 与 upgradePerformed=false。若 name=dangdang-tech-combo 已存在，必须确认 marketplaceSource.sourceType=git 且 marketplaceSource.source 精确等于 https://github.com/dangdang-tech/combo-plugin.git；同名错源、Plugin 已安装但 Marketplace 缺失、无效语义版本等异常组合立即 STOP，不 remove、不覆盖。',
        '若 Marketplace 与 Plugin 初始都缺失，执行 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace add https://github.com/dangdang-tech/combo-plugin.git --ref codex/combo-plugin-v2-ui --json，再重新执行 marketplace list 与 plugin list 并验证官方 source。若 marketplaceInitiallyPresent=true 且官方 Marketplace 已存在、Plugin 缺失或有效 version<0.7.0，则先精确验证官方 source，再恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace upgrade dangdang-tech-combo --json，设置 upgradePerformed=true，并重新读取两份 metadata。无论 marketplaceInitiallyPresent 初值为何，只要此时已确认 official Marketplace 且 Plugin 仍缺失，就恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin add combo@dangdang-tech-combo --json，并再次读取 plugin list；同一状态机内 plugin add 最多一次。fresh install 的固定顺序必须是 marketplace add→重新读取并确认 official source→plugin add→最终检查。',
        '若 Plugin add 或刷新后得到有效 version<0.7.0 且 upgradePerformed=false，必须重新验证 official Marketplace source，恰好再执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace upgrade dangdang-tech-combo --json，设置 upgradePerformed=true，并重新读取 marketplace list 与 plugin list；若升级后仍低于 0.7.0，或 upgradePerformed=true 时仍低于 0.7.0，立即 STOP。整个状态机 marketplace upgrade 最多执行一次。',
        '最后再次执行 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace list --json、"/Applications/ChatGPT.app/Contents/Resources/codex" plugin list --json 与 "/Applications/ChatGPT.app/Contents/Resources/codex" mcp get combo --json；最终 Plugin 必须是有效语义版本且 version>=0.7.0、installed=true、enabled=true、marketplaceSource 精确匹配，MCP 必须得到 name=combo、enabled=true、disabled_reason=null、transport.type=streamable_http，且 transport.url 精确等于 https://test.43-160-242-46.sslip.io/api/external-mcp/mcp；不符立即 STOP，不 remove、不 mcp add。',
        '若初始检查的四工具与全部 metadata 已同时满足，跳过安装变更、receiverHandoff 与 projectless create_thread，直接留在当前任务执行 readiness 和只读展示；此 stay-current 分支在首次 Combo 工具调用前主动 mcp login combo 的调用数必须为 0。否则完成安全安装/升级与最终 metadata 校验后、任何 create_thread 之前，必须用绝对 bundled CLI 恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" mcp login combo 完成 Codex-managed OAuth；失败或用户取消立即 STOP，create_thread 调用数必须为 0。OAuth 成功后才由正式 Host 精确调用 create_thread({prompt:receiverHandoff,target:{type:"projectless"}}) 创建 projectless 顶层续跑任务。子任务必须 parse 唯一 structured prompt 中逐字相同的 receiverHandoff、完成 readiness、读取同一分享、完整重显 manifest 与有序 starter 卡，并在这些证据之后的 assistant agentMessage（phase="final_answer"）中以独立一行逐字输出 COMBO_RECEIVER_HANDOFF_READY；到此 prepare、restore、codex app 与正式 Agent create_thread 的调用数都为 0。只返回 clientThreadId 时立即失败关闭，不能把它传给 wait_threads/read_thread，也不能重建任务。只有同时返回 ready threadId 与 hostId 才调用 wait_threads，再用 list_threads 按该 threadId 核对 documented project context 的 projectId=null，并用 read_thread({threadId,hostId,includeOutputs:true,maxOutputCharsPerItem:50000,turnLimit:20}) 只接受 readiness 与完整卡证据之后、assistant agentMessage（phase="final_answer"）里的独立一行逐字等于 COMBO_RECEIVER_HANDOFF_READY；绝不能匹配 userMessage、codexDelegation 输入、tool input、echo 或 receiverHandoff 原文中已有的 marker 字面量。父任务看到合格的 assistant agentMessage 后必须立即只调用一次 navigate_to_codex_page(threadId) 显示该 projectless 续跑任务，不得留在父任务等待确认或要求子任务先恢复运行；Host 注入的 source thread 标识属于 harness metadata，不得写入 Combo manifest。',
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
        `正式 Host 必须精确调用 create_thread({prompt:frozen,target:{type:"project",projectId,environment:{type:"local"}}})。只返回 clientThreadId 时立即失败关闭，不能把它传给 wait_threads/read_thread，也不能重建任务；只有同时返回 ready threadId 与 hostId 才调用 wait_threads，再用 list_threads 按该 threadId 核对 documented project context 的 projectId 精确匹配，并用 read_thread({threadId,hostId,includeOutputs:true,maxOutputCharsPerItem:50000,turnLimit:20}) 只接受全部只读 preflight 成功且 chosen starter 已实际开始的证据之后、assistant agentMessage（phase="final_answer"）里的独立一行逐字等于 COMBO_CODEX_AGENT_STARTED:${first.result.manifestSha256}；不能从 userMessage、codexDelegation、tool input、echo 或 Host wrapper 匹配。仅当两项都成功才立即只调用一次 navigate_to_codex_page(threadId) 显示正式 Agent 任务；任何准确失败都停止且 navigate 调用数为 0。`,
        `COMBO_CODEX_AGENT_RUN/1 是终端执行态；直接粘贴逐字合法的 raw runEnvelope 只表示用户显式请求 advanced launch，不证明此前已完成卡片或 ordinal 确认。Plugin outer run route 在任何 Git preflight、instructions 或 starter 执行之前，必须从 envelope 取 shareUrl、manifestSha256 与 starterPrompt，恰好调用一次 prepare_codex_agent_run，并要求返回 shareUrl、manifestSha256、starterPrompt 三项逐字相同且 runEnvelope 与当前输入字节完全相同；任一错误或不一致都立即停止，Git preflight、instructions、starter 与 STARTED marker 调用数均为 0。权威 prepare 成功后，对 read_codex_agent_share、restore、codex app、list_projects、create_thread、navigate_to_codex_page 的调用数仍为 0，再执行 envelope 的只读 Git preflight、完整 instructions 和 exact chosen starter。Plugin outer run route 只能在 chosen starter 实际开始后，在 assistant agentMessage（phase="final_answer"）中以独立一行逐字输出 COMBO_CODEX_AGENT_STARTED:${first.result.manifestSha256}；不能用 preflight 通过冒充 started，也不能回报未绑定摘要的 bare marker。上述带 50000 字符上限的 read_thread 只检查实际行为结果，不依赖未正式承诺的 read_thread cwd 或 delegation input 字段。`,
        '注册、匹配、建任务或回读任一步失败都准确报告阻断并停止。',
      ].join(''),
    );
    expect(first.result.copyPrompt).toContain('schema combo.codex-agent-share/1');
    expect(first.result.copyPrompt).toContain(`期望 manifestSha256=${first.result.manifestSha256}`);
    expect(first.result.copyPrompt).toContain(
      '"/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace upgrade dangdang-tech-combo --json',
    );
    expect(first.result.copyPrompt).toContain(
      '"/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace add https://github.com/dangdang-tech/combo-plugin.git --ref codex/combo-plugin-v2-ui --json',
    );
    expect(first.result.copyPrompt).toContain('marketplaceInitiallyPresent');
    expect(first.result.copyPrompt).toContain('upgradePerformed=false');
    expect(first.result.copyPrompt).toContain(
      '无论 marketplaceInitiallyPresent 初值为何，只要此时已确认 official Marketplace 且 Plugin 仍缺失，就恰好执行一次',
    );
    expect(first.result.copyPrompt).toContain(
      'fresh install 的固定顺序必须是 marketplace add→重新读取并确认 official source→plugin add→最终检查',
    );
    expect(first.result.copyPrompt).toContain('Plugin add 或刷新后得到有效 version<0.7.0');
    expect(first.result.copyPrompt).toContain('marketplace upgrade 最多执行一次');
    expect(first.result.copyPrompt).not.toContain('$COMBO_CODEX_CLI');
    expect(first.result.copyPrompt).toContain('完成 Codex-managed OAuth');
    expect(first.result.copyPrompt).toContain('失败或用户取消立即 STOP');
    expect(first.result.copyPrompt).toContain('continuation 分支禁止再次 mcp login combo');
    expect(first.result.copyPrompt).toContain('仅 stay-current 分支');
    expect(first.result.copyPrompt.match(/mcp login combo/gu)).toHaveLength(4);
    const finalMetadataIndex = first.result.copyPrompt.indexOf('最后再次执行');
    const continuationLoginIndex = first.result.copyPrompt.indexOf(
      '"/Applications/ChatGPT.app/Contents/Resources/codex" mcp login combo',
    );
    const continuationCreateIndex = first.result.copyPrompt.indexOf(
      'create_thread({prompt:receiverHandoff,target:{type:"projectless"}})',
    );
    expect(finalMetadataIndex).toBeGreaterThan(-1);
    expect(continuationLoginIndex).toBeGreaterThan(finalMetadataIndex);
    expect(continuationCreateIndex).toBeGreaterThan(continuationLoginIndex);
    expect(first.result.copyPrompt).toContain('全程零重启');
    expect(first.result.copyPrompt).not.toContain('完全退出并重开');
    expect(first.result.copyPrompt).toContain('receiverHandoff=');
    expect(first.result.copyPrompt).toContain('combo.receiver-bootstrap-handoff/1');
    expect(first.result.copyPrompt).toContain('COMBO_RECEIVER_HANDOFF_READY');
    expect(first.result.copyPrompt).toContain(
      '绝不能匹配 userMessage、codexDelegation 输入、tool input、echo 或 receiverHandoff 原文中已有的 marker 字面量',
    );
    expect(first.result.copyPrompt).toContain('此 handoff 不是用户确认');
    expect(first.result.copyPrompt).toContain(
      'create_thread({prompt:receiverHandoff,target:{type:"projectless"}})',
    );
    expect(first.result.copyPrompt).toContain('projectId=null');
    expect(first.result.copyPrompt).toContain('COMBO_RECEIVER_HANDOFF_READY');
    expect(first.result.copyPrompt).toContain('navigate_to_codex_page(threadId)');
    expect(first.result.copyPrompt.match(/navigate_to_codex_page\(threadId\)/gu)).toHaveLength(2);
    expect(first.result.copyPrompt).toContain(
      '只有四工具与 official source、installed/enabled semver>=0.7.0、精确 Test MCP 全部在初始检查中满足，才留在当前任务',
    );
    expect(first.result.copyPrompt).toContain(
      '跳过安装变更、receiverHandoff 与 projectless create_thread',
    );
    expect(first.result.copyPrompt).toContain('正式 Host 的 list_projects');
    expect(first.result.copyPrompt).toContain('$HOME/Developer/Combo-shared-projects');
    expect(first.result.copyPrompt).toContain(
      'combo-agent-<commitSha前12>-<16 lowercase hex nonce>',
    );
    expect(first.result.copyPrompt).toContain('workdir 精确设置为已验证 target');
    expect(first.result.copyPrompt).toContain(
      '"/Applications/ChatGPT.app/Contents/Resources/codex" app .',
    );
    expect(first.result.copyPrompt).not.toContain('app "<canonical-absolute-verified-path>"');
    expect(first.result.copyPrompt).toContain('canonical exact path 唯一匹配');
    expect(first.result.copyPrompt).toContain('最多顺序调用三次');
    expect(first.result.copyPrompt).not.toContain('总计不超过 30 秒');
    expect(first.result.copyPrompt).toContain('这一步不算 Agent 启动');
    expect(first.result.copyPrompt).toContain(
      'create_thread({prompt:frozen,target:{type:"project",projectId,environment:{type:"local"}}})',
    );
    expect(first.result.copyPrompt).not.toContain('environment.mode=local');
    expect(first.result.copyPrompt).toContain('只返回 clientThreadId 时立即失败关闭');
    expect(first.result.copyPrompt).toContain('不能把它传给 wait_threads/read_thread');
    expect(first.result.copyPrompt).toContain(
      'read_thread({threadId,hostId,includeOutputs:true,maxOutputCharsPerItem:50000,turnLimit:20})',
    );
    expect(first.result.copyPrompt).toContain('packaged helper 的 restore mode');
    expect(first.result.copyPrompt).not.toContain('调用 Plugin 内置 helper 的 verify-source mode');
    expect(first.result.copyPrompt).toContain('完整 starterPrompts 列表');
    expect(first.result.copyPrompt).toContain('V1 sourceRef 必须是以字母或数字起始');
    expect(first.result.copyPrompt).toContain('不得默认第一条');
    expect(first.result.copyPrompt).toContain('不得先创建空 Agent task');
    expect(first.result.copyPrompt).toContain('COMBO_CODEX_AGENT_RUN/1');
    expect(first.result.copyPrompt).toContain('prepare_codex_agent_run({shareUrl,manifestSha256');
    expect(first.result.copyPrompt).toContain(
      '我确认当前完整有序的 Combo Codex Agent 卡“<name>”（manifestSha256=<digest>，starterPrompts.length=<M>），选择第<N>条，并授权恢复卡中固定 Project、创建一个正式 local Codex Agent 任务并立即运行。若卡片、摘要、顺序或序号变化，停止。',
    );
    expect(first.result.copyPrompt).toContain('starterPrompts[N-1]');
    expect(first.result.copyPrompt).toContain('禁止截断或模糊文本匹配');
    expect(first.result.copyPrompt).toContain('不得由 Plugin 或模型自行构造');
    expect(first.result.copyPrompt).toContain('expectedSourceRef 只作远端 provenance');
    expect(first.result.copyPrompt).toContain('是终端执行态');
    expect(first.result.copyPrompt).toContain(
      `COMBO_CODEX_AGENT_STARTED:${first.result.manifestSha256}`,
    );
    expect(first.result.copyPrompt).toContain('不能回报未绑定摘要的 bare marker');
    expect(first.result.copyPrompt).toContain('显式请求 advanced launch');
    expect(first.result.copyPrompt).toContain('恰好调用一次 prepare_codex_agent_run');
    expect(first.result.copyPrompt).toContain('runEnvelope 与当前输入字节完全相同');
    expect(first.result.copyPrompt).not.toContain('Host-authenticated');
    expect(first.result.copyPrompt).toContain(
      'assistant agentMessage（phase="final_answer"）里的独立一行逐字等于 COMBO_CODEX_AGENT_STARTED',
    );
    expect(first.result.copyPrompt).toContain('任何准确失败都停止且 navigate 调用数为 0');
    expect(first.result.copyPrompt).toContain('V1 不支持撤销或过期');
    expect(first.result.copyPrompt).toContain('它不是账户授权或 OAuth token');
    expect(first.result.copyPrompt).toContain('持有即匿名可读，请按公开内容处理');
    expect(first.result.copyPrompt).not.toContain(body.agent.instructions);
    for (const starter of body.agent.starterPrompts) {
      expect(first.result.copyPrompt).not.toContain(starter);
    }
    const readBack = await readCodexAgentShare(db, {
      publicOrigin: PUBLIC_ORIGIN,
      shareUrl: first.result.shareUrl,
    });
    expect(readBack).toEqual({ kind: 'found', result: first.result });
    if (readBack.kind !== 'found' || replay.kind !== 'replayed') {
      throw new Error('unexpected replay/read outcome');
    }
    expect(readBack.result.copyPrompt).toBe(first.result.copyPrompt);
    expect(replay.result.copyPrompt).toBe(first.result.copyPrompt);
  });

  it('exports one full fixed receiver prompt golden and a literal byte digest', () => {
    const rendered = renderCodexAgentCopyPrompt(
      CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_FIXTURE.schemaVersion,
      CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_FIXTURE.shareUrl,
      CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_FIXTURE.manifestSha256,
    );
    expect(rendered).toBe(CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN);
    expect(createHash('sha256').update(rendered).digest('hex')).toBe(
      CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_SHA256,
    );
    expect(
      rendered.match(/https:\/\/test\.43-160-242-46\.sslip\.io\/agent\/[A-Za-z0-9_-]{43}/gu),
    ).toEqual(Array(2).fill(CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_FIXTURE.shareUrl));
    expect(rendered.match(/[a-f0-9]{64}/gu)).toEqual(
      Array(4).fill(CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN_FIXTURE.manifestSha256),
    );
  });

  it('keeps restoring the frozen old commit when sourceRef advances later', async () => {
    const db = new FakeShareDb();
    const created = await create(db);
    if (created.kind !== 'created') throw new Error('unexpected outcome');
    expect(created.result.manifest.source).toMatchObject({
      sourceRef: 'refs/heads/main',
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
    });
    expect(created.result.copyPrompt).toContain('不得因 sourceRef 后续推进而改用新 commit');
    expect(created.result.copyPrompt).toContain('Plugin packaged helper 的 restore mode');
    expect(created.result.copyPrompt).not.toContain(
      '调用 Plugin 内置 helper 的 verify-source mode',
    );
  });

  it('allows Agent text to collide with fixed receiver vocabulary without treating substrings as leakage', async () => {
    const db = new FakeShareDb();
    const created = await create(db, {
      agent: { instructions: 'create_thread', starterPrompts: ['git'] },
    });
    if (created.kind !== 'created') throw new Error('unexpected outcome');
    expect(created.result.manifest.agent).toEqual({
      instructions: 'create_thread',
      starterPrompts: ['git'],
    });
    expect(created.result.copyPrompt).toContain('create_thread');
    expect(created.result.copyPrompt).toContain('git');
    expect(created.result.copyPrompt).toContain(created.result.shareUrl);
    expect(created.result.copyPrompt).toContain(created.result.manifestSha256);
    expect(created.result.copyPrompt).not.toContain('PRIVATE-DERIVED-INSTRUCTIONS');
  });

  it('prepares exactly one authoritative run envelope only for the confirmed digest and starter', async () => {
    const db = new FakeShareDb();
    const created = await create(db);
    if (created.kind !== 'created') throw new Error('unexpected outcome');
    const starterPrompt = body.agent.starterPrompts[1]!;
    const prepared = await prepareCodexAgentRun(db, {
      publicOrigin: PUBLIC_ORIGIN,
      body: {
        shareUrl: created.result.shareUrl,
        manifestSha256: created.result.manifestSha256,
        starterPrompt,
      },
    });
    expect(prepared).toEqual({
      kind: 'found',
      result: {
        shareUrl: created.result.shareUrl,
        manifestSha256: created.result.manifestSha256,
        starterPrompt,
        runEnvelope: renderCodexAgentRunEnvelope({
          manifest: created.result.manifest,
          manifestSha256: created.result.manifestSha256,
          shareUrl: created.result.shareUrl,
          chosenStarterPrompt: starterPrompt,
        }),
      },
    });
    await expect(
      prepareCodexAgentRun(db, {
        publicOrigin: PUBLIC_ORIGIN,
        body: {
          shareUrl: created.result.shareUrl,
          manifestSha256: '0'.repeat(64),
          starterPrompt,
        },
      }),
    ).resolves.toEqual({ kind: 'digest_mismatch' });
    await expect(
      prepareCodexAgentRun(db, {
        publicOrigin: PUBLIC_ORIGIN,
        body: {
          shareUrl: created.result.shareUrl,
          manifestSha256: created.result.manifestSha256,
          starterPrompt: 'Not in the manifest.',
        },
      }),
    ).resolves.toEqual({ kind: 'starter_not_found' });
  });

  it('rejects an idempotency key reused with another Agent definition', async () => {
    const db = new FakeShareDb();
    await create(db);
    const conflict = await create(db, {
      agent: { ...body.agent, instructions: 'Different instructions.' },
    });
    expect(conflict).toEqual({ kind: 'idempotency_conflict' });
  });

  it('reads only the canonical current-origin /agent URL', async () => {
    const db = new FakeShareDb();
    const created = await create(db);
    if (created.kind !== 'created') throw new Error('unexpected outcome');
    expect(
      await readCodexAgentShare(db, {
        publicOrigin: PUBLIC_ORIGIN,
        shareUrl: created.result.shareUrl,
      }),
    ).toEqual({ kind: 'found', result: created.result });
    const queryCountBeforeInvalidUrls = db.queries.length;
    for (const shareUrl of [
      `https://evil.example/agent/${TOKEN_A}`,
      `${PUBLIC_ORIGIN}/agent/${TOKEN_A}?leak=1`,
      `${PUBLIC_ORIGIN}/project-agent/${TOKEN_A}`,
      `https://test.43-160-242-46.sslip.io:443/agent/${TOKEN_A}`,
      `${PUBLIC_ORIGIN}/foo/../agent/${TOKEN_A}`,
      `https://TEST.43-160-242-46.sslip.io/agent/${TOKEN_A}`,
    ]) {
      expect(await readCodexAgentShare(db, { publicOrigin: PUBLIC_ORIGIN, shareUrl })).toEqual({
        kind: 'invalid_url',
      });
      expect(
        await prepareCodexAgentRun(db, {
          publicOrigin: PUBLIC_ORIGIN,
          body: {
            shareUrl,
            manifestSha256: created.result.manifestSha256,
            starterPrompt: body.agent.starterPrompts[0]!,
          },
        }),
      ).toEqual({ kind: 'invalid_url' });
    }
    expect(db.queries).toHaveLength(queryCountBeforeInvalidUrls);
  });

  it('keeps old and new URL/schema pairs mutually exclusive in the shared immutable table', async () => {
    const newDb = new FakeShareDb();
    await create(newDb);
    expect(
      await readProjectAgentShareWithToken(newDb, {
        publicOrigin: PUBLIC_ORIGIN,
        shareToken: TOKEN_A,
      }),
    ).toEqual({ kind: 'not_found' });

    const oldDb = new FakeShareDb();
    const oldBody: CreateProjectAgentShareBody = {
      name: 'Legacy Project',
      description: 'Legacy Project Agent V1.',
      repositoryUrl: body.repositoryUrl,
      sourceRef: body.sourceRef,
      commitSha: body.commitSha,
      treeSha: body.treeSha,
      startPrompt: 'Review it.',
      requirements: { commands: [], plugins: [], environmentVariableNames: [] },
      idempotencyKey: '00000000-0000-4000-8000-000000000003',
    };
    await createProjectAgentShare(oldDb, {
      ownerUserId: OWNER_A,
      body: oldBody,
      publicOrigin: PUBLIC_ORIGIN,
      now: () => NOW,
      randomToken: () => TOKEN_B,
    });
    expect(
      await readCodexAgentShareWithToken(oldDb, {
        publicOrigin: PUBLIC_ORIGIN,
        shareToken: TOKEN_B,
      }),
    ).toEqual({ kind: 'not_found' });
  });

  it('turns same-owner cross-schema idempotency reuse into conflicts in both directions', async () => {
    const newFirstDb = new FakeShareDb();
    await create(newFirstDb);
    const oldAfterNew = await createProjectAgentShare(newFirstDb, {
      ownerUserId: OWNER_A,
      body: {
        name: 'Legacy Project',
        description: 'Must not replay a v2 row as v1.',
        repositoryUrl: body.repositoryUrl,
        sourceRef: body.sourceRef,
        commitSha: body.commitSha,
        treeSha: body.treeSha,
        startPrompt: 'Review it.',
        requirements: { commands: [], plugins: [], environmentVariableNames: [] },
        idempotencyKey: body.idempotencyKey,
      },
      publicOrigin: PUBLIC_ORIGIN,
      now: () => NOW,
      randomToken: () => TOKEN_B,
    });
    expect(oldAfterNew).toEqual({ kind: 'idempotency_conflict' });

    const oldFirstDb = new FakeShareDb();
    await createProjectAgentShare(oldFirstDb, {
      ownerUserId: OWNER_A,
      body: {
        name: 'Legacy Project',
        description: 'Must not replay a v1 row as v2.',
        repositoryUrl: body.repositoryUrl,
        sourceRef: body.sourceRef,
        commitSha: body.commitSha,
        treeSha: body.treeSha,
        startPrompt: 'Review it.',
        requirements: { commands: [], plugins: [], environmentVariableNames: [] },
        idempotencyKey: body.idempotencyKey,
      },
      publicOrigin: PUBLIC_ORIGIN,
      now: () => NOW,
      randomToken: () => TOKEN_B,
    });
    const newAfterOld = await createCodexAgentShare(oldFirstDb, {
      ownerUserId: OWNER_A,
      body,
      publicOrigin: PUBLIC_ORIGIN,
      comboEnvironment: 'test',
      now: () => NOW,
      randomToken: () => TOKEN_A,
    });
    expect(newAfterOld).toEqual({ kind: 'idempotency_conflict' });
  });

  it('fails closed when a v2 manifest or digest is tampered', async () => {
    const db = new FakeShareDb();
    await create(db);
    db.rows[0]!.manifest = { ...db.rows[0]!.manifest, description: 'tampered' };
    await expect(
      readCodexAgentShareWithToken(db, {
        publicOrigin: PUBLIC_ORIGIN,
        shareToken: TOKEN_A,
      }),
    ).rejects.toThrow('manifest digest mismatch');

    const digestDb = new FakeShareDb();
    await create(digestDb);
    digestDb.rows[0]!.manifest_sha256 = '0'.repeat(64);
    await expect(
      readCodexAgentShareWithToken(digestDb, {
        publicOrigin: PUBLIC_ORIGIN,
        shareToken: TOKEN_A,
      }),
    ).rejects.toThrow('manifest digest mismatch');
  });

  it('serves the owner-created manifest to an anonymous HTTP reader with public-link headers', async () => {
    const db = new FakeShareDb();
    await create(db);
    const headers = new Map<string, string>();
    let statusCode = 0;
    let sentBody: unknown;
    const reply = {
      header(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
      code(status: number) {
        statusCode = status;
        return this;
      },
      send(value: unknown) {
        sentBody = value;
        return this;
      },
    } as unknown as FastifyReply;
    const logError = vi.fn();
    const request = {
      id: 'trace-public-codex-agent-share',
      params: { shareToken: TOKEN_A },
      log: { error: logError },
      server: {
        infra: {
          db,
          env: { EXTERNAL_MCP_PUBLIC_ORIGIN: PUBLIC_ORIGIN },
        },
      },
    } as unknown as FastifyRequest;

    await getCodexAgentShareHandler().call(request.server, request, reply);
    expect(statusCode).toBe(200);
    expect(sentBody).toMatchObject({
      data: {
        manifest: { name: body.name, authoringSource: { rawStored: false } },
      },
    });
    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const publicRead = db.queries.find(({ sql }) => sql.includes('WHERE share_token'));
    expect(publicRead?.sql.slice(publicRead.sql.indexOf('WHERE'))).not.toContain('owner_user_id');
    expect(logError).not.toHaveBeenCalled();
  });
});
