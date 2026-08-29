# domains — 业务域契约

这个目录按业务域定义对外接口的数据形状与校验规则，覆盖认证、任务、能力项和试用会话，另含去敏规则引擎。每个域同时导出 Zod 运行时 schema 和推导出的 TypeScript 类型。

## 文件

- `auth.ts` 定义邮箱验证码认证域。该文件提供严格的 challenge、verification 与 logout 请求 schema、必填 traceId 的成功包络、当前用户视图 `MeView`、中间件使用的 `AuthContext`、六位验证码与七天会话常量，以及 `sanitizeAuthReturnTo` 站内回跳净化函数。显式安全入口使用 `__Host-cb_session`，显式本地 HTTP 入口使用 `cb_session`，两者都使用根路径。`MeView.email` 是必填的规范邮箱，`MeView.account` 固定为 `creator-` 加八位小写 Base32，登出结果的已知字段只有 `loggedOut: true`。
- `task.ts` 定义任务域：带幂等键的建任务请求、任务视图 `TaskView`（含两轴状态、上传分片计数，以及不可再收片但保留清理诊断的 `expired` 上传态）、建任务响应（配对码只在此明文出现一次），以及本机助手分片上传接口的请求与结果。
- `capability.ts` 定义能力项域：库内轻量索引视图 `CapabilityView`、存在 MinIO 里的完整可运行定义 `CapabilityDefinition`（提取流水线写入、试用端读出注入 agent，是两个服务之间唯一的契约缝，除系统提示词外还带试用开场表单字段 `inputs` 与开场提示语 `starterPrompts`），以及发布动作的结果。
- `knowledge.ts` 定义受控 Test 知识 Agent 的冻结 Capability/Release/Package/resource 绑定与权威使用收据视图。它只表达 append-only 数据库收据及绑定 Message 的一致性投影，不把 digest 描述为签名，也不引入 `latest`、storage key 或独立知识选择器。
- `trial.ts` 定义试用域：会话、消息、产物和 Turn 的视图，以及建会话、带 `usageId` 发消息和余额不足响应的契约；`usageId` 在校验 UUID 后统一输出小写规范形。Artifact 会带可选来源 Turn 和创建时间，会话详情能从 PostgreSQL 恢复 active Turn，并只用严格白名单码描述最近终态 Turn，绝不承载原始错误文本。`currentUiArtifactId` 标识 Studio 当前 UI 或普通会话创建时冻结的 UI 副本。会话详情里的能力摘要带开场表单字段与提示语（来自能力定义，定义读不出时为空数组）。知识会话额外要求明确 `agentBinding` 与必定存在的 `knowledgeResults`（空会话为 `[]`）；旧 Runtime 缺失新字段仍可解析。知识回答只从收据绑定的权威投影展示，消息数组不携带 assistant/tool 候选文本。普通消息内容仍是 agent 原生分块格式，共享层只约束到「是数组」，严格校验在 runtime 侧。
- `redaction.ts` 是去敏规则引擎，纯函数、无任何 IO：`redact` 与 `redactBatch` 按带版本号的规则集抹掉手机号、邮箱、密钥、证件号、银行卡号、IP 等隐私信息，产出只含类别与计数的聚合报告，且对已去敏文本重跑结果不变。
- `index.ts` 汇总转出以上全部文件。

## 认证契约边界

认证域只定义邮箱六位验证码、`GET /me`、`POST logout` 和一枚按显式传入的 HTTPS 策略命名的不透明 Cookie 所需契约。请求邮箱只执行保守结构校验，不裁剪地址；authoring 使用同一规范化结果完成投递、摘要和身份写入。`sanitizeAuthReturnTo` 最多接受五百一十二字符，并只保留 `/tasks`、`/tasks/` 子路径、`/capabilities`、`/try` 与 `/try/` 子路径。绝对地址、双斜杠、反斜杠、控制字符、编码斜杠和其他路径统一回落到 `/tasks`。

## 知识收据边界

`KnowledgeTurnResult` 只是已经 Runtime 核对过的 owner-visible 投影。Runtime 必须在构造它之前，于同一会话快照里读取收据绑定的权威 Message，对唯一文本块的精确 UTF-8 字节重算 `responseDigest`，再从冻结 Package 内的固定 Knowledge Bundle 映射 citation label。共享 schema 验证这些值的形状与交叉不变量，但不替 Runtime 执行重算与对象验证。`createdAt` 是数据库事务时间的记录字段，不是 commit timestamp；digest 也不是签名或发布者授权证明。

## 上下游

runtime 的认证中间件使用 `AuthSessionCookieValueSchema`、Cookie 常量、角色和 `AuthContext`，并用会话摘要读取 PostgreSQL。authoring 的账号模块使用邮箱请求、验证结果、当前用户、登出、Cookie 和回跳契约。web 与 runtime-web 使用相同请求、响应和回跳定义实现自定义登录与站内导航。

runtime 的能力加载模块使用 `CapabilityDefinitionSchema` 校验从 MinIO 读出的定义，agent 与会话模块使用 capability 和 trial 域类型。authoring 的任务、能力与提取流水线使用 task、capability 和 redaction 域定义。
