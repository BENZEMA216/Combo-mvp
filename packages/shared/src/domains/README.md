# domains — 业务域契约

这个目录按业务域定义对外接口的数据形状与校验规则，覆盖认证、任务、能力项、Agent 项目和试用会话，另含去敏规则引擎。每个域同时导出 Zod 运行时 schema 和推导出的 TypeScript 类型。

## 文件

- `auth.ts` 定义邮箱验证码认证域。该文件提供严格的 challenge、verification 与 logout 请求 schema、必填 traceId 的成功包络、当前用户视图 `MeView`、中间件使用的 `AuthContext`、六位验证码与七天会话常量，以及 `sanitizeAuthReturnTo` 站内回跳净化函数。显式安全入口使用 `__Host-cb_session`，显式本地 HTTP 入口使用 `cb_session`，两者都使用根路径。`MeView.email` 是必填的规范邮箱，`MeView.account` 固定为 `creator-` 加八位小写 Base32，登出结果的已知字段只有 `loggedOut: true`。
- `task.ts` 定义任务域：带幂等键的建任务请求、任务视图 `TaskView`（含两轴状态、上传分片计数，以及不可再收片但保留清理诊断的 `expired` 上传态）、建任务响应（配对码只在此明文出现一次），以及本机助手分片上传接口的请求与结果。
- `capability.ts` 定义能力项域：库内轻量索引视图 `CapabilityView`、存在 MinIO 里的完整可运行定义 `CapabilityDefinition`（提取流水线写入、试用端读出注入 agent，是两个服务之间唯一的契约缝，除系统提示词外还带试用开场表单字段 `inputs` 与开场提示语 `starterPrompts`）、供 Codex 发布前审阅的 `CapabilityDetail`，以及发布动作的结果。
- `agent.ts` 定义 Agent Builder V1：单循环 AgentDefinition、恰好一个入口 Capability 的绑定规则、严格 UUID 资源边界、保留历史编译器版本的 Runtime Bundle、Project、不可变 Revision、幂等真实 Test、不可变质量复核、Project 最近 Test 恢复列表、Release，以及 Codex 直接保存 Miniapp HTML 的请求与响应契约。质量复核至少包含 normal、boundary 和 failure 三类案例，每个案例分别保存执行终态与质量结论；例外接受必须说明理由和影响。Revision、Test 和 Release 都显式携带 Runtime Bundle 与 UI 的 SHA-256 摘要；恢复列表独立覆盖尚未绑定 Session/Turn 的 `starting` claim，默认 20 条、最多 50 条。
- `agent-ui.ts` 定义 Authoring 与 Runtime 共用的 Miniapp HTML 最小运行校验，要求自包含文档和真实 `combo:run` Bridge，并拒绝定时器、随机数和 mock 结果。
- `mcp-oauth.ts` 定义远程 MCP 的稳定路径、OAuth 2.1 scope、RFC 9728 资源发现、RFC 8414 授权服务器发现、动态客户端注册、短期访问令牌与轮换刷新令牌响应契约。它不包含浏览器 Session Cookie，也不允许把 Cookie 当作 Bearer Token。
- `project-agent-share.ts` 定义不可变 Git Project 分享契约，仅允许规范 GitHub HTTPS 仓库、精确 commit/tree SHA、启动说明和无值的依赖声明进入 manifest。输出只包含任何持链接者都可匿名读取的公开 manifest、分享链接和复制到 Codex 的文字，不包含 owner 或内部存储标识。V0 分享不撤销、不过期且不托管 Git 对象，调用方不得把秘密放进 manifest。
- `codex-agent-share.ts` 定义 `combo.codex-agent-share/1` 当前任务派生 Agent 分享契约：公开 manifest、canonical digest、Test canonical URL、1–5 条有序 starter，以及没有独立 raw task blob 的边界。Receiver 的 reserved `codex_agent_restore` 请求严格只允许 `{stage,shareUrl,manifestSha256}`；Authoring 必须重新公开读取并校验 digest 后服务端构造完整 1+M 卡。共享包冻结不含 manifest 自由文本的 digest/M/N action、真正不可变的 canonical serialized card snapshot、只含 commitSha/treeSha 的 Creator 分享 action，以及 `starterOrdinal`+`starterPrompt` 双重绑定的 `prepare`/`COMBO_CODEX_AGENT_RUN/1` wire；服务端只接受 `starterPrompts[N-1]===starterPrompt`。Creator/Receiver/Run compact JSON 继续 Host-safe 转义实际 `<`、`>`、`&`、U+2028、U+2029，`expectedSourceRef` 只代表远端 provenance。

Project Agent 与 Codex Agent 的 schema version 都版本化服务端 `copyPrompt` renderer；每个 v1 renderer 都是 wire contract，必须永久保留并由完整 contract 或 golden test 固定。普通文案不能在同一 schema version 下改写；ordinal action 的安全收紧只允许移除 user-role message 中的不可信自由文本，并必须同步共享 renderer、完整 golden、literal hash、UI/Service 测试和接收端实现。

Codex Agent V1 digest 的 canonical JSON 不是 RFC 8785。它递归按 JavaScript 默认 UTF-16 code-unit 顺序排列对象键，对 primitive 使用 `JSON.stringify`，保持数组顺序，并拒绝 `undefined` 与非有限数字；摘要是该 UTF-8 字节串的 SHA-256。共享测试给出跨仓库必须完全匹配的 JSON 与 digest golden。

- `trial.ts` 定义试用域：会话、消息、产物和 Turn 的视图，以及建会话、带 `usageId` 发消息和余额不足响应的契约；`usageId` 在校验 UUID 后统一输出小写规范形，Agent Builder 会话可携带固定的 Project、Revision 与 Release。Artifact 会带可选来源 Turn 和创建时间，会话详情能从 PostgreSQL 恢复 active Turn，并只用严格白名单码描述最近终态 Turn，绝不承载原始错误文本。`currentUiArtifactId` 标识 Studio 当前 UI 或普通会话创建时冻结的 UI 副本。会话详情里的能力摘要带开场表单字段与提示语（来自普通能力定义或固定 Revision Bundle，定义读不出时为空数组）。消息内容是 agent 原生分块格式，共享层只约束到「是数组」，严格校验在 runtime 侧。
- `redaction.ts` 是去敏规则引擎，纯函数、无任何 IO：`redact` 与 `redactBatch` 按带版本号的规则集抹掉手机号、邮箱、密钥、证件号、银行卡号、IP 等隐私信息，产出只含类别与计数的聚合报告，且对已去敏文本重跑结果不变。
- `index.ts` 汇总转出以上全部文件。

## 认证契约边界

认证域只定义邮箱六位验证码、`GET /me`、`POST logout` 和一枚按显式传入的 HTTPS 策略命名的不透明 Cookie 所需契约。请求邮箱只执行保守结构校验，不裁剪地址；authoring 使用同一规范化结果完成投递、摘要和身份写入。`sanitizeAuthReturnTo` 最多接受五百一十二字符，并只保留既有业务路径，以及只含一个格式正确 `mar1` 不透明请求句柄的 OAuth 授权恢复路径。绝对地址、原始 OAuth 查询、附加参数、双斜杠、反斜杠、控制字符、编码斜杠和其他路径统一回落到 `/tasks`。

## 上下游

runtime 的认证中间件使用 `AuthSessionCookieValueSchema`、Cookie 常量、角色和 `AuthContext`，并用会话摘要读取 PostgreSQL。authoring 的账号模块使用邮箱请求、验证结果、当前用户、登出、Cookie 和回跳契约。web 与 runtime-web 使用相同请求、响应和回跳定义实现自定义登录与站内导航。

runtime 的能力加载模块使用 `CapabilityDefinitionSchema` 校验从 MinIO 读出的定义，agent 与会话模块使用 capability、agent 和 trial 域类型。authoring 的任务、能力与提取流水线使用 task、capability 和 redaction 域定义；Agent Builder 使用 agent 域冻结 Capability、UI 与 Runtime Bundle。
