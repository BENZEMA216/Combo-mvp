# Project-history Agent Package lane

本模块实现一个独立、低保证的显式 Project 历史来源链路。用户必须先在 Codex Host 的正式
`list_projects` 结果中按安全 ordinal 选择一个 saved Project；Plugin 再从全局有界的
`list_threads` 结果中筛选该 Project 的 Codex 任务，最多按稳定顺序选择 20 个 eligible 任务，并用
`read_thread` cursor 读到每个已选任务的终页。其余同 Project 的 matching/non-Codex 任务计入
`omittedThreadCount`（最多 10,000，超出即失败关闭）。`discoveredThreadCount` 表示已选 eligible 数，
必须与 `readThreadCount` 相等；Host 可因 pinned 任务返回超过 50 条，不得将总数硬编码为 50。
Combo 不接收 Project、task、thread、session、item ID、路径、消息、transcript 或 raw tool result，只接收
模型提炼后的 strict candidate 和有界计数。

这条 lane 不替代 `J-011` 的 current-conversation 默认入口。当前 Host 的 `list_threads` 没有分页或
server-side Project filter；`read_thread` 返回的是可能有界或摘要化的 reduced result，而且完整结果会先进入
模型，Skill 才能约定只采用 user/agent 字段。因此 Draft、卡片、来源回执和 Package provenance 永远固定
`assurance=best_effort`、`completeness=not_proven`、`hostAttestation=not_proven`、
`sourceProjectionEnforced=not_proven`。`rawStored=false` 只表示 Combo 不另存 raw history，不证明模型未见过
其他 reduced item，也不证明 candidate 没有原文或秘密。V3 服务会词法拒绝明显 credential 模式，但这仍不是
完整脱敏证明。

## 状态与确认

- `service.ts` 创建并持久化 revision 1 only 的 `combo.agent-package-draft/3`，协议会从 exact creator request、
  初始 candidate 与 source evidence 重算 candidate commitment；V3 不提供 revision API，避免把后续编辑误称为
  来源历史提取候选。Draft 写入前还会用正式 Package builder 与 launch prompt builder 完成同一套确定性预检，
  因此卡片只会展示可编译 Draft。
- `renderDraft` 必须重新读取 exact Draft，并生成专用 typed Draft App card。它签发五分钟的一次性 opaque
  token；生产 PostgreSQL 用单次 `clock_timestamp()` 原子确定 created/expiry 且数据库只保存 SHA-256。
  token 证明 server render-first 与 exact revision 绑定，不证明 Host 点击。
- 固定卡片动作明确说明：分享是不过期、不可撤回的 public-by-link 工件，任何持链接者可读，但不是
  marketplace publication 或 public listing。token 不进入卡片、action message、copy prompt、Package、share
  或 receipt。
- `createShare` 在 PostgreSQL 单事务中锁定 token 和 exact Draft，原子消费 token，并冻结一个不可变
  `combo.agent-package/1` Release/share。相同 idempotency key 的掉响应重放返回同一结果；其他 replay、过期、
  跨 owner、旧 fingerprint 或冲突 key 都 fail closed。
- confirmation ledger 不是永久 token 存档。`combo_api` 没有表级 DELETE；共享 external-MCP 低频 scheduler
  只能调用 `cleanup_retired_project_history_confirmations(100)` SECURITY DEFINER 入口，每批只锁定并删除最多
  100 条已消费或按数据库 wall clock 已过期的行。多副本并发使用 `SKIP LOCKED`；清理失败只记录固定低敏
  warning，不阻断当前用户请求，也绝不删除 active confirmation。

## HTTP 与 MCP registry

Authoring API 路径挂在 `/api/v1`：

- `POST /agent-package-drafts`
- `POST /agent-package-drafts/:draftId/render`
- `POST /agent-package-shares`
- `GET /agent-package-shares/:shareToken` (the high-entropy link alone returns the immutable Package and authoritative digest)
- `POST /agent-package-runs/prepare`

前三个 HTTP mutation 只接受 trusted browser Origin + owner Session Cookie。它们不是远程 MCP transport，不能由
Plugin 伪造 Origin 调用。`mcp.ts` 提供五工具 definitions、draft-07 exact input/output JSON Schema
和 service-bound dispatcher；`draft-app.ts` 提供 render tool 绑定的 MCP App resource 及严格 URI read。

正式 `/api/external-mcp/mcp` 已把 owner 工具映射到 `combo.agent:write` 并注入 OAuth principal user ID；
public-by-link read/prepare 使用 `combo.agent:read`，service 不按 creator owner 过滤。create-share 仍保留独立
Host approval，因为它产生不可撤销、不过期的 public-by-link 状态。匿名 GET 只凭 43 字符高熵
share URL 读取 Package 和权威 digest；prepare 仍需要 URL + exact digest 作 anti-mixup 校验。

`PROJECT_HISTORY_AGENT_MCP_TOOLS` 是五工具 contribution。`project-history-composition.ts` 经 name/URI
碰撞检查后，将它和 typed Draft resource 稳定 append 到 Test 原有 23 个 legacy tools 及 Agent Builder
resource/dispatcher，正式 catalog 固定为 28 tools / 2 resources。catalog parity 不通过时必须阻断 Test
部署和 Plugin 0.8.4 UAT；不得用移除 V0/V1/0.8.3 执行面的方式接入新工具。

## Package 与运行边界

`repo.ts` 保存 canonical Draft/share JSON，同时把 fingerprint、candidate commitment、package digest 和整份
share JSON 的 SHA-256 materialize 成列；数据库插入 trigger 与每次应用回读都重算完整 JSON digest，再逐项
核对列、URL、copy prompt 和 request fingerprint，任一漂移即停止。
Project-history share JSON 额外限制为 256 KiB，避免通用 9 MiB Package 协议上限成为普通 MCP 首错。
Package 还在固定路径保存规范 `starter-prompts.json`，该文件进入 Package manifest/digest；Share parser 每次
回读都要求顶层 starter 顺序和文本与该 digest-bound 工件逐项一致。`share_json_sha256` 负责检测整行漂移，
Package 内 starter 工件则阻止攻击者同步重算该行摘要后单独替换 prepare/launch 的起始任务。

`prepare_agent_package_run` 校验 exact share、Package inventory/digest、digest-bound starter manifest 及
starter ordinal/text，并返回不超过
64 KiB 的 `COMBO_AGENT_PACKAGE_RUN/2`。它包含服务端校验过的 cleartext `AGENT.md` 与一个 `SKILL.md` 投影，
receiver 不需要在模型内解 base64。它不携带 creator Project/Git，也不创建 worktree 或执行写入。
`executionBoundary.hostInstalledEnforcement=not_proven`：这只是 exact Package 的 runtime projection，不证明 Host
已经安装或技术强制 Agent。Project-history Package 内的 `AGENT.md` 也只把 Skill 称为 provided/verified
runtime material，不声称 installed。

prepare 还会生成 exact `launchPrompt`，最大 4096 字符且 UTF-8 不超过 8 KiB。它只显示 Agent 名、
公开 share URL、唯一 Package digest、starter ordinal 与 exact starter text，不包含 JSON、runtime material、
Draft/Release/token 或内部协议文字。Plugin 必须让用户在 Host 中选择 Project B，把这个 exact
`launchPrompt` 作为首条用户可见消息，child 从固定文法解析公开字段后只调用一次 prepare，然后在
同一任务以只读方式连续运行两轮。`runEnvelope` 只保留为机器证据，不得用作用户可见 prompt。

## 文件

- `contracts.ts`：五工具 Zod input、版本、token TTL、确认文案和 256 KiB share 上限。
- `service.ts`：Draft、render、share/read/prepare 编排，以及仅供单元测试的 in-memory repository。
- `repo.ts`：production PostgreSQL repository、DB-clock token mint/consume、幂等、整份 share digest 与受控
  retention function adapter。
- `handlers.ts`、`routes.ts`：独立 HTTP API 边界；所有响应 `no-store`。
- `mcp.ts`：五工具 exact schemas、annotations 与 dispatcher；不实现 transport。
- `draft-app.ts`：typed Draft App resource 和 resource reader。
- Draft App 在第一次异步 digest 前只通过 own data descriptors 建立一次有界、detached、deep-frozen JSON
  snapshot；getter/accessor、symbol、隐藏/危险键、稀疏数组、非 plain prototype、循环/别名及超深/超大输入均
  fail closed。后续 hash、校验、DOM 与固定 action 只读取该 snapshot，避免 Host payload 的 TOCTOU 漂移。
- `*.test.ts`：服务、PG mapper/retention、MCP tools/resources/dispatcher 合同。

真实 PostgreSQL 并发/重启测试位于 `src/__tests__/project-history-agent.pg.test.ts`，必须显式提供管理员和
`combo_api` 两条测试连接；默认单元测试不会把 skipped PG test 计作已运行证据。
