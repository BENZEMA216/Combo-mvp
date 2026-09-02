# modules/codex-agent-share —— 当前任务派生 Agent 公开分享

这个模块保存 `combo.codex-agent-share/1` 不可变 manifest，并用高熵随机链接让持链接者匿名读取。创建者声明公开的 instructions 和 starter prompts 由 Codex 从当前顶层任务可见上下文本地派生并完成必要去敏；服务端只校验字段形状，不能证明该声明、去敏质量或文本中不含原文。Schema 没有独立的 raw task、threadId、messages、session、路径、Cookie、令牌、验证码、秘密值或环境变量值字段，`rawStored=false` 只表示没有独立 raw task blob。当前 V1 分享不支持撤销或过期。它不是账户授权或 OAuth token；但它是未列出的公开定位链接，持有即匿名可读，请按公开内容处理。

## 文件

- `routes.ts` 声明受信任浏览器来源与会话保护的创建端点，以及不要求登录的公开读取端点。创建端点独立使用 128 KiB body limit，完整八千字符多字节 instructions 与五条一千字符 starter prompts 不会被旧 32 KiB 限额误拒绝。
- `handlers.ts` 校验创建请求，映射幂等冲突和公开未命中，并为匿名读取添加禁止缓存、禁止来源泄露和禁止索引头。
- `service.ts` 固定 `authoringSource` 为当前 Codex task 且没有独立 raw task blob，计算稳定 manifest 摘要，生成三十二字节随机定位符，并按 schema 版本生成不内嵌 instructions 或 starter 原文的接收文案。
- `repo.ts` 复用 `project_agent_shares` 不可变表保存 manifest，按 owner 和幂等键重放创建，并按随机定位符执行不带 owner 过滤的公开读取。读取和幂等重放都先按 schema version 分流，旧 Project Agent 与新 Codex Agent 不能互相解析。
- `service.test.ts` 固定幂等、摘要、复制文案、跨 schema 分流、跨 schema 幂等冲突和篡改失败关闭边界。

## 接收边界

接收端先检查四项工具与 official Plugin `>=0.7.0`/Test MCP metadata；全部初始满足则 stay current，只有明确 authorization error 才恰好登录一次。否则冻结 Host-safe `combo.receiver-bootstrap-handoff/1`，在最终 metadata 后、任何 `create_thread` 前用 bundled CLI 完成一次 OAuth，再创建 projectless continuation。续跑任务先 readiness，然后只能调用 strict `render_agent_builder({stage:"codex_agent_restore",shareUrl,manifestSha256})`；服务端通过 `readCodexAgentShare` 重新匿名读取 canonical URL、按 canonical JSON 校验数据库 digest、核对期望 digest，并构造完整 1+M 卡，禁止 caller 传 title/items/actions 或再调用 `read_codex_agent_share` 冒充证据。目标 `COMBO_RECEIVER_HANDOFF_READY` 必须是 assistant whole-message `text.trim()` exact marker；phase `final_answer` 可用，null/absent 仅作同一唯一 completed/error-null turn、ordered lifecycle 齐全且 marker 最后的 legacy fallback，commentary 或含其他文字的 final 拒绝。

服务端卡的 manifest item 完整展示 name/description、share/digest/createdAt、source、instructions、requirements、authoringSource 与 privacy；M 个 starter items 不截断 prompt，`fact.value` 上限 20,000 可覆盖合法最大 requirements。所有 starter action 同等展示，user-role message 只绑定 digest/M/N。用户点击一基 N 后调用 `prepare_codex_agent_run({shareUrl,manifestSha256,starterOrdinal:N,starterPrompt})`；服务端重读同一分享并要求 authoritative `starterPrompts[N-1]===starterPrompt`，回显 URL、digest、ordinal、prompt、runEnvelope 五项，任何错位都失败关闭。随后 Plugin helper 才可 restore 到固定 `$HOME/Developer/Combo-shared-projects` 下安全生成的 ASCII child，并核对 HEAD/tree/clean、注册 Project 与创建正式任务。

正式 Agent task 的唯一首消息是带必填 `starterOrdinal` 的 Host-safe `COMBO_CODEX_AGENT_RUN/1`。Raw envelope 是 advanced launch，不证明 UI consent；终端 Plugin 必须在任何 preflight/instructions/starter 前恰好调用一次 prepare，以 shareUrl、digest、ordinal、prompt 四个字段及完整 runEnvelope bytes 复核，失败即零执行。`expectedSourceRef` 仍只作远端 provenance。chosen starter 实际开始后，目标 `COMBO_CODEX_AGENT_STARTED:<manifestSha256>` 也必须是 whole-message exact marker，沿用 final_answer/受限 legacy null-phase/commentary-reject 规则；只有 Project context、ordered lifecycle 与摘要 marker 全部一致才导航。

因为 V1 copyPrompt 永久固定 Combo Test URL，只有 `COMBO_ENVIRONMENT=test` 可以创建新行；Development、Preview 与 Production 的 HTTP/MCP create 都在数据库写入前失败关闭，公开读取仍保持可用。未来其他环境必须发布新 schema/renderer，不能用同一 V1 铸造跨环境链接。

`copyPrompt` 按 manifest `schemaVersion` 派发冻结 renderer。`service.ts` 导出固定 Test URL/digest 的完整 `CODEX_AGENT_COPY_PROMPT_WIRE_GOLDEN` 及 literal SHA-256，Plugin 可以直接绑定普通 receiver route 的真实 prompt 字节。`combo.codex-agent-share/1` 的完整语义由 golden 和 contract 测试固定；普通文案变化必须新增 schema 版本并永久保留旧 renderer。Ordinal action 的本次 P1 安全收紧只移除 user-role message 中的不可信自由文本，必须等 Backend shared/service/UI、完整 golden/hash 与 Plugin receiver 同步后才能发布。

Manifest 摘要使用共享 `canonicalJson` 的 UTF-8 字节做 SHA-256，不是 RFC 8785。对象键递归按 JavaScript 默认 UTF-16 code-unit 顺序排序，primitive 使用 `JSON.stringify`，数组保持原顺序，并拒绝 `undefined` 与非有限数字。共享包固定跨仓库 canonical JSON 与摘要 golden，Web 在渲染前独立重算并拒绝不一致响应。
