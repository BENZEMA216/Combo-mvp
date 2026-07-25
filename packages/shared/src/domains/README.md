# domains — 业务域契约

这个目录按业务域定义对外接口的数据形状与校验规则，覆盖登录、任务、能力项、试用会话四个域，另含去敏规则引擎。每个域同时导出 zod（运行时校验库）schema 和推导出的类型。

## 文件

- `auth.ts` 定义登录域：登录与回调接口的查询参数 schema、当前用户视图 `MeView`、登出结果，以及鉴权中间件注入请求的 `AuthContext`（非对外响应体）。
- `task.ts` 定义任务域：带幂等键的建任务请求、任务视图 `TaskView`（含两轴状态、上传分片计数，以及不可再收片但保留清理诊断的 `expired` 上传态）、建任务响应（配对码只在此明文出现一次），以及本机助手分片上传接口的请求与结果。
- `capability.ts` 定义能力项域：库内轻量索引视图 `CapabilityView`、存在 MinIO 里的完整可运行定义 `CapabilityDefinition`（提取流水线写入、试用端读出注入 agent，是两个服务之间唯一的契约缝，除系统提示词外还带试用开场表单字段 `inputs` 与开场提示语 `starterPrompts`），以及发布动作的结果。
- `trial.ts` 定义试用域：会话、消息、产物和运行中 Turn 的视图，以及建会话、发消息的请求体；Artifact 会带可选来源 Turn 和创建时间，会话详情能从 PostgreSQL 恢复 active Turn，并用 `currentUiArtifactId` 标识 Studio 当前 UI 或普通会话创建时冻结的 UI 副本。会话详情里的能力摘要带开场表单字段与提示语（来自能力定义，定义读不出时为空数组）。消息内容是 agent 原生分块格式，共享层只约束到「是数组」，严格校验在 runtime 侧。
- `redaction.ts` 是去敏规则引擎，纯函数、无任何 IO：`redact` 与 `redactBatch` 按带版本号的规则集抹掉手机号、邮箱、密钥、证件号、银行卡号、IP 等隐私信息，产出只含类别与计数的聚合报告，且对已去敏文本重跑结果不变。
- `index.ts` 汇总转出以上全部文件。

## 上下游

runtime 侧：`platform/middleware/auth.ts`、`platform/infra/logto.ts` 和 `platform/infra/dev-session.ts` 用 auth 域的角色与 `AuthContext`；`modules/capability/loader.ts` 用 `CapabilityDefinitionSchema` 校验从 MinIO 读出的定义，`modules/agent` 的 `build-agent.ts` 与 `run-turn.ts` 拿它构建 agent；`modules/session` 与 `modules/artifact` 用 trial 域的请求 schema 和视图类型。

authoring 侧：`modules/account` 用 auth 域的角色与视图；`modules/task` 的 `handlers.ts`、`repo.ts`、`service.ts`、`pairing.ts` 用 task 域的全部请求与视图，`pipeline.ts` 在提取流水线里调用 `redactBatch` 去敏并用 `CapabilityDefinitionSchema` 生成能力定义；`modules/capability` 用 `CapabilityView` 和 `PublishResult`。
