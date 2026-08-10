# @cb/shared — 前后端共享契约包

这个包是 authoring、runtime、web 与 runtime-web 共同使用的契约真源。生产代码位于 `src/`，编译结果输出到忽略版本控制的 `dist/`。包内只包含运行时校验、类型、常量、基础设施接口和无副作用工具，不连接数据库或外部服务。

## 文件

- `package.json` 声明包入口、Zod 运行时依赖以及构建、类型检查和测试命令。
- `tsconfig.json` 编译生产源码并生成 ESM、类型声明和 source map。
- `tsconfig.vitest.json` 对测试源码执行不产物的严格类型检查。
- `vitest.config.ts` 配置共享包的单元测试。
- `src/` 保存全部手写源码，目录职责与上下游关系记录在 `src/README.md`。

## 认证契约

邮箱验证码登录的请求、结果、成功包络、当前用户视图、登出结果、显式 HTTPS `__Host-cb_session` 与本地 HTTP `cb_session` 策略和安全站内回跳函数统一定义在 `src/domains/auth.ts`。验证码和会话失败使用 `src/core/errors.ts` 中的安全错误映射，对外错误信封不包含内部错误码。健康契约不把邮件供应商列为就绪依赖，因此已有会话和普通业务请求不依赖新邮件投递。

远程 MCP 的 OAuth 发现、动态客户端注册、PKCE 授权码和令牌响应契约统一定义在 `src/domains/mcp-oauth.ts`。浏览器 Cookie 只负责用户在授权页确认身份；MCP 请求只接受数据库中摘要化保存且绑定资源地址的 Bearer Token。

## 使用与验证

Agent Builder 也从本包读取 `AgentDefinition`、Project、Revision、Test、不可变 Test 质量复核、Project Test 恢复列表与 Release 契约。恢复列表独立覆盖 `starting` claim，查询默认 20 条且硬限制为 50 条；每个 Test 同时暴露技术状态、质量状态和当前发布资格。Agent Revision 通过稳定 JSON 编码计算内容摘要，新 Release 必须引用同一份不可变 Runtime Bundle、技术通过的 Test 和可发布质量复核。

Project Agent Share 从本包读取不可变 manifest、规范 GitHub HTTPS 仓库与精确 Git SHA 校验、无值的 Codex 依赖声明和公开分享结果契约。任何持链接者都可匿名读取 manifest；V0 链接不会过期且不能撤销，因此不得写入秘密。这个域不保存或归档 Git 对象、工程文件、Codex 会话、凭据或 Runtime 状态，仓库/commit 不再可取时旧分享也无法恢复。

Codex Agent Share 从本包读取创建者声明由当前顶层任务本地派生的公开 Agent 定义契约。Manifest 固定保存精确 Project 来源、最长八千字符的 instructions、一至五条唯一 starter prompts、无值依赖声明、`authoringSource.kind=codex_current_task` 与 `rawStored=false`；结果还携带稳定 manifest SHA-256。创建请求不接受独立 raw task、threadId、messages、session、路径、transcript 或 secret-bearing 字段；`rawStored=false` 只表示没有独立 raw task blob，不能证明公开 instructions 已脱敏或不含原文。当前 V1 持链接匿名可读、不支持撤销或过期。它不是账户授权或 OAuth token；但它是未列出的公开定位链接，持有即匿名可读，请按公开内容处理。

`combo.project-agent-share/1` 同时冻结 manifest 与 `copyPrompt` wire contract。Authoring 必须按 schema version 保留对应 renderer 和完整 golden；已有 renderer 不能原地改写，新增文案只能通过新 schema version，才能保证滚动发布时同一幂等请求仍返回字节一致结果。

`combo.codex-agent-share/1` 同样冻结 manifest、manifest digest 和不内嵌 instructions 或 starter 原文的接收文案。完整卡仍展示公开 `manifest.name`，但共享 `renderCodexAgentReceiverOrdinalAction` 生成的 user-role action 只绑定 manifest digest、starter 总数 M 和一基序号 N，不复制 name 或任何 manifest 自由文本；确认解析还会比较整个 card snapshot，name、URL、digest、总数、顺序或序号任一变化都失败关闭。共享包还冻结 Creator、Receiver 两种 bootstrap handoff 与终端 Run 三条 fixed-order compact JSON wire。三者在 `JSON.stringify` 后把实际 `<`、`>`、`&`、U+2028、U+2029 转为小写 Unicode escape，避免进入 Host 的 XML-like delegation delimiter；解析后字段值逐字还原。公开 free text 与 `codexVersion` 拒绝 PostgreSQL jsonb 无法保存的 NUL 和未配对 surrogate，U+0001、CRLF 与合法 astral 字符仍可往返。V1 `sourceRef` 另收窄为以字母或数字起始、仅含 ASCII 字母数字及 `._/-` 的完整 heads/tags ref，避免 packaged helper 的命令参数接受 shell 元字符；V0 ref 契约保持字节兼容。用户在同一次确认中按一基序号选择 starter 后，接收端先调用 `prepare_codex_agent_run`，由服务端按 canonical share、精确 digest 和 starter 成员关系返回权威 run envelope；四项回显与 envelope 校验通过前不得写本地。随后 Plugin packaged helper 的 `restore` mode 只能写入 `$HOME/Developer/Combo-shared-projects` 下由 commit 前十二位与随机 nonce 组成的 ASCII child，不能从 manifest 文本生成路径；独立 hash/clean 核对后，用 exec tool 的已验证 workdir 和固定 `"/Applications/ChatGPT.app/Contents/Resources/codex" app .` 注册，路径不进入 command string，再由正式 Host 创建新任务。唯一首消息必须逐字等于 prepare 返回、并由 `renderCodexAgentRunEnvelope` 生成的 flat compact JSON；属性顺序、固定 preflight、特殊字符 fixture 与 exact bytes 都由 `CODEX_AGENT_RUN_WIRE_GOLDEN*` 导出。`expectedSourceRef` 是远端 provenance，当前本地 ref 是 deterministic restore branch，二者不得比较相等。Run envelope 是显式 advanced launch 命令，不是此前 UI 确认的证明；终端 Plugin 必须在任何 Git preflight 或 Agent 文本执行前恰好调用一次 `prepare_codex_agent_run`，要求四项回显与当前 envelope 字节完全一致，失败时零执行。权威复核通过后不再 read、restore、注册、导航或创建下一层任务。

V1 的普通产品文案仍不得原地改写；本次 ordinal action 变化是一次安全收紧，只移除 user-role message 中的不可信自由文本，并要求共享 renderer、完整 copyPrompt golden、literal hash、UI/Service 测试及接收端实现同步后才能发布。

V1 copyPrompt 固定 Combo Test，因此 Authoring 只允许 Test 创建；Preview 与 Production create 在数据库写入前失败关闭，但已有链接仍可读取。HTTP 创建路由用 128 KiB 限额容纳 schema 允许的完整多字节文本。

V1 manifest digest 使用本包 `canonicalJson` 的 UTF-8 字节做 SHA-256，不是 RFC 8785。算法对对象递归使用 JavaScript `Object.keys(...).sort()` 的默认 UTF-16 code-unit 顺序排列键，对字符串、布尔值、null 和有限数字使用 `JSON.stringify`，数组保持原顺序，并拒绝 `undefined` 与非有限数字。共享包导出 `CODEX_AGENT_MANIFEST_CANONICAL_GOLDEN_FIXTURE`、exact JSON 与 literal SHA-256，`codex-agent-share.test.ts` 逐字验证；Plugin 和 Web 必须复用同一算法或通过该 golden 证明字节一致。

业务包通过 `@cb/shared` 根入口导入契约，不引用 `dist/` 内部路径，也不在各应用重复定义相同 schema。`pnpm -F @cb/shared typecheck` 检查生产源码，`pnpm -F @cb/shared typecheck:test` 检查测试源码，`pnpm -F @cb/shared test` 运行单元测试。
