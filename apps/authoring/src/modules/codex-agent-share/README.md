# modules/codex-agent-share —— 当前任务派生 Agent 公开分享

这个模块保存 `combo.codex-agent-share/1` 不可变 manifest，并用高熵随机链接让持链接者匿名读取。创建者声明公开的 instructions 和 starter prompts 由 Codex 从当前顶层任务可见上下文本地派生并完成必要去敏；服务端只校验字段形状，不能证明该声明、去敏质量或文本中不含原文。Schema 没有独立的 raw task、threadId、messages、session、路径、Cookie、令牌、验证码、秘密值或环境变量值字段，`rawStored=false` 只表示没有独立 raw task blob。当前 V1 分享不支持撤销或过期。它不是账户授权或 OAuth token；但它是未列出的公开定位链接，持有即匿名可读，请按公开内容处理。

## 文件

- `routes.ts` 声明受信任浏览器来源与会话保护的创建端点，以及不要求登录的公开读取端点。创建端点独立使用 128 KiB body limit，完整八千字符多字节 instructions 与五条一千字符 starter prompts 不会被旧 32 KiB 限额误拒绝。
- `handlers.ts` 校验创建请求，映射幂等冲突和公开未命中，并为匿名读取添加禁止缓存、禁止来源泄露和禁止索引头。
- `service.ts` 固定 `authoringSource` 为当前 Codex task 且没有独立 raw task blob，计算稳定 manifest 摘要，生成三十二字节随机定位符，并按 schema 版本生成不内嵌 instructions 或 starter 原文的接收文案。
- `repo.ts` 复用 `project_agent_shares` 不可变表保存 manifest，按 owner 和幂等键重放创建，并按随机定位符执行不带 owner 过滤的公开读取。读取和幂等重放都先按 schema version 分流，旧 Project Agent 与新 Codex Agent 不能互相解析。
- `service.test.ts` 固定幂等、摘要、复制文案、跨 schema 分流、跨 schema 幂等冲突和篡改失败关闭边界。

## 接收边界

接收端先检查四项工具与 official Plugin `>=0.7.0`/Test MCP metadata；全部初始满足则留在当前任务且不主动 OAuth login，只有可调用工具明确返回 authorization 错误时才恰好登录一次并只重试原调用。任一工具或 metadata 不满足时，只冻结 Host-safe `combo.receiver-bootstrap-handoff/1`；完成安装或升级及最终 metadata 校验后、任何 `create_thread` 前，绝对 bundled CLI 必须恰好执行一次 Codex-managed OAuth，失败或取消时保持零任务创建。成功后才通过正式 Host 的 `target:{type:"projectless"}` 新顶层任务续跑，不能冒充 Creator 的 same-Project handoff；子任务若缺工具或 readiness 失败只能报告 catalog blocker，禁止再次登录或重建任务。子任务完成 readiness、读取并完整重显后，才在 assistant `agentMessage`（`phase=final_answer`）报告 exact `COMBO_RECEIVER_HANDOFF_READY`；父任务不能从 `userMessage`、`codexDelegation`、tool input、echo 或 handoff 输入中匹配该字面量，只在证据之后的该 assistant 输出回证成功时自动导航给用户。Handoff 不算确认。接收端核对 `read_codex_agent_share` 返回的 schema 与摘要是否等于 copyPrompt 固定值；Authoring 仓储在每次读取时解析 manifest 并按共享 canonical JSON 重算数据库摘要，Web 在渲染前另做独立重算。随后展示完整 starter prompts，等待用户在同一次确认中明确选择一条。

用户按一基序号点击对应 action 后，系统从当前完整有序卡片精确取 `starterPrompts[N-1]`。卡片的 manifest 总览仍显示公开 name，但 action 的 user-role message 只能由共享 renderer 绑定 `manifestSha256`、starter 总数 M 和一基序号 N，不能复制 name、starter 或其他 manifest 自由文本；确认时整个 card snapshot、digest、M、顺序和 N 必须保持不变。随后先调用 `prepare_codex_agent_run` 并校验回显的 URL、digest、starter 与权威 run envelope；任一不一致都停止，且此时不得写本地。只有 prepare 成功后，才由已安装 Skill 按参数契约调用 Plugin packaged helper 的 `restore` mode，把 manifest 固定 commit 恢复到固定 `$HOME/Developer/Combo-shared-projects` 下由 commit 前十二位和随机 nonce 组成的全新 ASCII child，路径不能来自 manifest 自由文本；再独立核对 HEAD、tree 与 clean 状态，sourceRef 后续推进不能改变旧分享。注册时 exec tool 的 workdir 精确设为已验证 target，只调用一次固定 `"/Applications/ChatGPT.app/Contents/Resources/codex" app .`，路径不得插入 command string。正式 Host 的 `list_projects` 最多顺序调用三次以按 canonical exact path 唯一匹配；任一次 Host error/timeout、三次后仍未命中或多重命中都阻断。

正式 Agent task 的唯一首消息是 `prepare_codex_agent_run` 返回、由共享包 `renderCodexAgentRunEnvelope` 生成的 Host-safe compact JSON，固定属性顺序为 `schemaVersion=COMBO_CODEX_AGENT_RUN/1`、share URL、manifest digest、expected repository/ref/commit/tree、固定只读 preflight、完整 instructions 与用户明确选择的 starter。V1 sourceRef 只允许 shell-safe 的完整 ASCII heads/tags ref，V0 契约不变。Raw run envelope 是显式 advanced launch 命令，不证明此前完成卡片或序号确认；终端 Plugin 在任何 Git preflight、instructions 或 starter 执行前必须恰好调用一次 `prepare_codex_agent_run`，要求返回四项与当前输入逐字、逐字节一致，任一错误时保持零执行。权威复核通过后才报告 provenance preflight 并执行定义；此后不得重新 read、restore、调用 `codex app`、导航或创建下一层任务。Plugin outer run route 只能在 chosen starter 实际开始后，由 assistant `agentMessage`（`phase=final_answer`）报告 exact `COMBO_CODEX_AGENT_STARTED:<manifestSha256>`；父任务排除 `userMessage`、`codexDelegation`、tool input 与 echo，精确核对本次分享摘要，仅在 preflight 成功和绑定摘要的 marker 都回证后导航显示正式 Agent，任何失败都保持零导航。Host 只接受同时返回 ready threadId/hostId 的同步创建结果，clientThreadId-only 必须失败关闭。

因为 V1 copyPrompt 永久固定 Combo Test URL，只有 `COMBO_ENVIRONMENT=test` 可以创建新行；Development、Preview 与 Production 的 HTTP/MCP create 都在数据库写入前失败关闭，公开读取仍保持可用。未来其他环境必须发布新 schema/renderer，不能用同一 V1 铸造跨环境链接。

`copyPrompt` 按 manifest `schemaVersion` 派发冻结 renderer。`service.ts` 导出固定 Test URL/digest 的完整 `CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN` 及 literal SHA-256，Plugin 可以直接绑定普通 receiver route 的真实 prompt 字节。`combo.codex-agent-share/1` 的完整语义由 golden 和 contract 测试固定；普通文案变化必须新增 schema 版本并永久保留旧 renderer。Ordinal action 的本次 P1 安全收紧只移除 user-role message 中的不可信自由文本，必须等 Backend shared/service/UI、完整 golden/hash 与 Plugin receiver 同步后才能发布。

Manifest 摘要使用共享 `canonicalJson` 的 UTF-8 字节做 SHA-256，不是 RFC 8785。对象键递归按 JavaScript 默认 UTF-16 code-unit 顺序排序，primitive 使用 `JSON.stringify`，数组保持原顺序，并拒绝 `undefined` 与非有限数字。共享包固定跨仓库 canonical JSON 与摘要 golden，Web 在渲染前独立重算并拒绝不一致响应。
