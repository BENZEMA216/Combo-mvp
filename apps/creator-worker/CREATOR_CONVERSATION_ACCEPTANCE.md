# 当前对话生成 Agent Package Draft 验收

本文件定义 `J-011` · 当前对话生成 Draft 的真实用户验收。它只覆盖创作者从当前 Codex Desktop 对话得到可审阅
Draft 的第一段旅程，不证明 Package 编译、试跑、发布、接收或 Agent Session。

## 当前结论

- 流程合同已经启用。
- current-conversation V2 协议已由公开 `agent-package-draft` 子路径进入 production build；它只定义 path-free
  request、Draft 与脱敏 provenance，不提供 Host snapshot 或任务选择能力。Worker ordering seam 与
  `agent-package-current-conversation-draft` production fail-closed facade 也进入 production build；当前 composition
  只绑定固定 unavailable Host，因此调用必然以 `AGENT_PACKAGE_CONVERSATION_SOURCE_UNAVAILABLE` 停止，绝不接
  Fake port 或回退到 Project、session、Hook / Bridge、CLI 或第二个 Codex thread。
- `ACC-CONTRACT-011A` 的协议实现已存在，但尚未产生绑定 exact candidate commit 的正式
  `CONTRACT_TEST_REPORT`，因此状态是 `NOT_RUN`，不是 `PASS`。
- 当前对话生产入口是 `NOT_IMPLEMENTED`：可编译 facade 已存在，但真实 Desktop Host capability 和成功路径不存在。
- 真实 Codex Desktop Host 验收是 `NOT_IMPLEMENTED`。
- 普通用户 UAT 是 `NOT_RUN`。
- `J-011` 整体状态是 `BLOCKED`。

仓库已有的 Project-first Creator、CLI、Hook / Bridge、Fake Host 和 Combo 自建 bundled Codex thread 都不是这条
用户路径。它们继续作为显式 Project 来源或工程兼容测试维护，但不能提升本文件中的任何状态。

## 用户 Golden Path

1. 创作者已在一个 Codex Desktop 任务中完成工作。
2. 创作者在同一任务输入一句自然语言，例如“把我们刚才完成的工作做成一个 Agent”。
3. Codex Desktop 运行时建立不可由业务调用方伪造的当前 active task 来源边界，只使用该任务中用户可见的
   对话。具体实现可以由顶层 Host 原生交付当前上下文或等价的受控能力完成，但不得让业务调用方、Plugin 或
   MCP 提交 task、thread、session 标识或 raw transcript 来选择来源。顶层 Host 可以在自己的边界内使用
   `thread/read`；Plugin 或 MCP 不得直接读取 rollout / thread store。
4. Creator 从该快照提取方法，在同一任务打开或展示 Agent Studio Draft。
5. 创作者能看到 Agent 的身份、能力、来源类型和可复核的脱敏来源摘要。

普通用户不得为了完成这条流程执行 Terminal 命令、输入 `/hooks`、手工 trust Hook、填写 Project 路径、复制
内部 JSON、设置环境变量或理解 thread、digest、manifest 等实现术语。

## 五层门禁

| Acceptance                                | 通过条件                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACC-CONTRACT-011A` · 当前对话 Draft 合同 | 新合同表达 `current_conversation` 来源；不接受 Project 路径、Hook 字段、环境 trust flag、调用方 task/thread/session ID 或 raw transcript            |
| `ACC-UNIT-011B` · 对话提取                | 随机方法标记只存在于选定对话；Project 诱饵不得进入 Draft；Project scanner、projection、Bridge 和 child process 调用为零                             |
| `ACC-SEC-011C` · 零旁路                   | 对话缺失、压缩不完整、漂移、Host egress 拒绝/receipt 错绑或输出非法时停止；不得回退到 Project scan、raw session、Hook / Bridge、CLI 或手贴 handoff  |
| `ACC-HOST-011D` · Desktop 原生链路        | 真实 Desktop 证明 `DESKTOP_ATTESTED_ACTIVE_CURRENT_TASK_SOURCE_BOUNDARY`；同一任务一句话看到 Draft，且不打开 Terminal、不 trust Hook 或选择 Project |
| `ACC-UAT-011E` · 普通用户体验             | 非开发用户独立完成流程；另一个任务中的随机标记不得出现在 Draft；用户无需理解任何内部协议                                                            |

五层状态必须分别报告。Contract 或 Unit 通过不能替代 Host 和 UAT，真实 Host 单次成功也不能替代来源隔离与失败闭包。

本合同中，`NOT_IMPLEMENTED` 表示生产候选仍缺少该能力；`NOT_RUN` 表示实现或体验对象已经存在，但尚无绑定
exact candidate commit 的该层正式 evidence；`PASS` 必须满足下述证据规则。当前仅 Contract 层已达到
“实现存在、正式 evidence 未运行”。Unit / Security / Host 仍因 production composition 只有 unavailable Host、
不存在真实 active-task snapshot 和同任务 Draft UI 而保持 `NOT_IMPLEMENTED`，UAT 仍为 `NOT_RUN`。

## 最小测试语料

### 正常对话

在受控任务中完成一个含随机方法标记的流程，再发出自然语言制作指令。Draft 必须包含该方法的可复用语义，不得复制
原始对话全文，也不得包含测试 Project 中未出现在对话里的随机诱饵。

### 来源不完整

构造已压缩、缺失关键结果或无法证明来自当前任务的对话。系统必须说明来源不足并停止，不得为了补齐信息扫描
Project、寻找 session 文件或要求用户进入 Terminal。

### 跨任务隔离

在两个 Desktop 任务分别放入不同随机标记，只在其中一个任务触发制作。Draft 只能使用触发任务的用户可见来源。

### 对话引用 Project

让对话提到一个 Project 文件名，但不把文件内容带入用户可见对话。系统不得隐式读取该文件；需要文件内容时，
应停止并让用户另行选择显式 Project 来源。

## PASS 证据绑定

每一层只有在自己的 `evidence` 非空时才能标记 `PASS`，且每条 evidence 都必须记录 `artifactRef`、artifact
SHA-256、runtime identity 和精确组件版本。合同还必须设置一个顶层 40 位 `candidateCommit`，五层所有 evidence
的 `repositoryCommit` 必须与它完全相同。五层只接受各自的 evidence kind：

| Acceptance          | Evidence kind                         |
| ------------------- | ------------------------------------- |
| `ACC-CONTRACT-011A` | `CONTRACT_TEST_REPORT`                |
| `ACC-UNIT-011B`     | `CONVERSATION_EXTRACTION_TEST_REPORT` |
| `ACC-SEC-011C`      | `SECURITY_BOUNDARY_TEST_REPORT`       |
| `ACC-HOST-011D`     | `DESKTOP_CURRENT_TASK_RUN_RECEIPT`    |
| `ACC-UAT-011E`      | `NON_DEVELOPER_UAT_RECEIPT`           |

仅编辑 status、填写一段说明、复用其他层的 artifact ref 或 digest，或拼接不同 commit 的结果，都必须由机器
合同拒绝。Desktop Host 层的 receipt 还必须通过公开
`@cb/creator-agent-protocol/desktop-current-conversation-receipt` verifier，使用仓库外受信公钥复验
domain-separated canonical 签名消息、exact candidate、同任务绑定、source/egress candidate/projection/Draft
digest、事件 hash chain 和 Host 签名的端到端零旁路观测声明。本合同没有独立 Worker trust root，不把 Host
填写的 Worker 标签冒充第二权威。snapshot commitment 与 task binding 必须是 Host secret 派生的 per-run
HMAC，不得保存或公开 raw transcript SHA；验收 registry 还要原子拒绝重复 `(issuer,keyId,runId)`。
Evidence 引用仍需独立复核；它不是由 JSON 自己证明真实。

## 真实证据窗口

所有零副作用计数只统计从 `DIRECT_USER_CREATOR_ITEM_ACCEPTED` 到 `DRAFT_TERMINAL_RESULT` 的 Creator 窗口，
不追溯用户在发起制作前完成原任务时的正常 Project 读取或 shell 操作。

一次可接受的真实运行至少记录以下脱敏证据：

- 仓库提交 SHA、Codex Desktop build、Combo Plugin 版本与被测服务版本。
- 触发指令是 `DIRECT_USER_CREATOR_ITEM`，并由
  `DESKTOP_ATTESTED_ACTIVE_CURRENT_TASK_SOURCE_BOUNDARY` 绑定当前 active task；不保存原始 task、thread 或
  session 标识。
- 当前任务来源的脱敏摘要、选中 item 数量和来源类型；不保存原始 transcript。
- Creator 窗口内新增 Project scanner、Project file read 和 Project write 的观测计数都为零。
- 用户 Terminal 操作为零，Creator CLI / Bridge child process 启动为零；Hook trust 写入、Plugin / MCP thread
  store 读取、raw session 文件读取和 fallback 次数都为零。
- Draft ID、revision、fingerprint、Studio 可见截图或等价产品证据。
- 对话来源中非用户可见 item 的包含数量为零，跨任务随机标记泄漏数量为零。

以下机器枚举的证据类统一不属于 Golden Path：`PROJECT_FIRST_CREATOR`、`PLUGIN_HOOK_OR_BRIDGE`、
`CREATOR_CLI`、`FAKE_HOST_OR_PORT`、`ISOLATED_BUNDLED_CODEX_THREAD`。因此，手工填写一个 JSON、Project-first
单元测试全绿、Fake Host 成功、Bridge 输出 Draft、CLI 成功、Hook 被信任、Combo 自建 bundled Codex thread，
或没有 V2 provenance/receipt 的 presentation-only 泛型 Draft 卡片，都不能提升五层状态。只有 exact 被测提交上
的真实 Desktop 运行与普通用户 UAT 都完成后，才能把 `J-011` 标记为 `PASS`。

## 失败和停止

只要当前 Desktop 运行时无法提供经过边界化的当前对话，流程就保持 `BLOCKED`。实现不得把用户自动送入旧 Project
Creator，也不得建议普通用户使用 `/hooks` 或 Terminal。需要 Project 证据时，系统应明确结束当前对话来源尝试，
再由用户主动选择独立的 Project 来源流程。
