# Combo 工程假设与开发记录

> `WORKING DRAFT` · 开发中验证
>
> [PROJECT.md](./PROJECT.md) 定义已经确认的产品基线。本文记录为实现该产品而提出的工程假设，可随真实开发和用户体验持续调整；发生冲突时，以 `PROJECT.md` 为准。

本文中的符号命名必须使用“稳定 ID · 语义名称”双命名。面向人的页面、文档、PR 和验收报告不得只展示裸 ID；语义发生变化时应新增 ID，而不是保留旧 ID 改写含义。

## 一、产品到工程的追踪模型

`PROJECT.md` 已确认目标、体验和唯一产物。下面的工程拆解用于指导开发与验证，不代表用户已经确认具体实现方式。

### 追踪单位

每项工作统一使用下面的关系表达：

```text
Goal：最终让用户获得什么结果
  └── Source：哪一段对话、Project 或工作旅程是创作来源
        └── Journey：用户经历什么
              └── Product Object：这一步创建或消费哪个产品对象
                    └── Capability：系统必须具备什么能力
                          └── Module：哪一部分工程负责实现
                                └── Acceptance：凭什么证明已经完成

Invariant：跨越所有 Journey 的不可变规则
```

### 两条消费入口共享同一工件

```text
Agent Package Release
        │
        ├── 分享链接 ──→ Agent 页面 ──→ 在 Codex 中使用
        │
        └── 能力获取指令 ──→ 用户自己的 Agent 解析并获取能力
                                      │
                                      ▼
                         exact Installed Agent
                                      │
                                      ▼
                              Agent Session
```

分享链接和能力获取指令只是同一个 `Agent Package Release` 的两种入口。能力获取指令应携带或解析出 exact Release 引用，不能把整个 Agent 复制成另一份 Prompt，也不能隐式指向“最新版”。

### 用户体验与工程映射

| Journey                       | 用户结果                                                                                 | 对应产品对象                       | 必需 Capability                                                                                  | 责任 Module                                                                                                                                                           | 核心 Acceptance                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `J-010` · 提交 Agent 创作来源 | 用户把一段 Agent 对话、一个 Project 或一段工作旅程交给自己的 Codex，并用制作指令启动创建 | Agent Package Draft                | `CAP-010` · 创作来源绑定、`CAP-020` · Draft 提取与 Package 编译                                  | `MOD-CREATOR-BRIDGE` · Agent 制作入口、`MOD-AUTHORING` · Agent 创作、`MOD-PACKAGE` · Package 核心                                                                     | `ACC-E2E-010` · 多来源创作启动：三类来源都能形成边界明确的 Draft，且无需用户理解内部文件和摘要                                 |
| `J-020` · Studio 生成与体验   | 用户看到 Agent 的身份、能力、来源和真实试跑结果，并可修订                                | Agent Package Draft、Agent Package | `CAP-020` · Draft 提取与 Package 编译、`CAP-030` · Studio 审阅试跑、`CAP-070` · Package 推理运行 | `MOD-CREATOR-UI` · 创作者体验、`MOD-AUTHORING` · Agent 创作、`MOD-PACKAGE` · Package 核心、`MOD-WEB-PREVIEW` · Web 试跑预览、`MOD-CODEX-HOST` · 原生 Codex Agent 运行 | `ACC-E2E-020A` · Package 编译试跑：正式重载后完成真实试跑；`ACC-UAT-020B` · Studio 审阅修订：完整展示内容，修订后生成新 digest |
| `J-030` · 发布并生成双入口    | 用户发布后同时获得分享链接和可复制的能力获取指令                                         | Agent Package Release              | `CAP-040` · Package 发布、`CAP-050` · 双入口分享                                                 | `MOD-CREATOR-UI` · 创作者体验、`MOD-REGISTRY` · Package 注册、`MOD-SHARE` · 分享服务、`MOD-SHARED` · 共享基础设施                                                     | `ACC-E2E-030` · 精确发布入口：链接与能力获取指令始终解析到同一 Package digest                                                  |
| `J-040` · 通过链接使用        | 使用者打开链接并将 Agent 加载到自己的 Codex                                              | Installed Agent                    | `CAP-050` · 双入口分享、`CAP-060` · Agent 能力接收、`CAP-070` · Package 推理运行                 | `MOD-SHARE` · 分享服务、`MOD-RECEIVER` · Agent 能力接收、`MOD-PACKAGE` · Package 核心、`MOD-CODEX-HOST` · 原生 Codex Agent 运行                                       | `ACC-HOST-040` · 分享链接接收：允许一次简要复制操作，最终在真实 Codex 中加载 exact Package                                     |
| `J-045` · 用一段话获取能力    | 使用者把能力获取指令交给自己的 Agent，该 Agent 获取并加载对应能力                        | Installed Agent                    | `CAP-050` · 双入口分享、`CAP-060` · Agent 能力接收、`CAP-070` · Package 推理运行                 | `MOD-SHARE` · 分享服务、`MOD-RECEIVER` · Agent 能力接收、`MOD-PACKAGE` · Package 核心、`MOD-CODEX-HOST` · 原生 Codex Agent 运行                                       | `ACC-HOST-045` · 自然语言能力获取：用户自己的 Agent 从指令解析 exact Release，完成校验和加载                                   |
| `J-050` · 持续使用            | 使用者在同一个 Agent 对话中持续使用已获取能力完成工作                                    | Agent Session                      | `CAP-070` · Package 推理运行                                                                     | `MOD-PACKAGE` · Package 核心、`MOD-CODEX-HOST` · 原生 Codex Agent 运行                                                                                                | `ACC-E2E-050` · 同线程两轮推理：同一 Package 与同一 Codex 线程连续完成两轮真实任务                                             |

`CAP-080` · 安装与会话恢复属于 `P5` · 平台化与可靠性，用于强化长期使用，不是最小产品闭环成立的前置条件。

模块完成不等于用户旅程完成。只有对应验收在规定环境中产生可复现证据，Journey 才能标记为 `PASS` · 验收通过。

## 二、目标系统结构

```text
┌─────────────────────────────────────────────────────────┐
│                       产品体验层                        │
│ Agent 制作入口 · Agent Studio · 分享页 · 能力获取指令  │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                       产品控制层                        │
│ Authoring Task · Package Registry · Entry Resolver     │
│ Auth · Release · Install · Session Metadata            │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                    唯一工件层                           │
│ Agent Package = agent.json + AGENT.md + Skills + Files │
│                 exact bytes + package digest            │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                    Codex 推理层                         │
│ Package Loader · Codex Host · Skill/Tool Binding       │
│ Current Project · Same-thread Session                  │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                    证据与可靠性层                       │
│ Integrity · Provenance · Recovery · Receipts · Audit   │
└─────────────────────────────────────────────────────────┘
```

完整运行态为：

```text
Codex Host
+ exact Agent Package
+ 使用者当前 Project
+ 当前 Conversation
= Agent Session
```

Combo 不自行实现模型推理循环。Codex 负责推理和工具循环；Combo 负责编译、发布、加载和验证 Agent Package，并把它准确交给 Codex。

## 三、工程责任边界

| Module                                   | 责任                                                             | 当前仓库主要承载位置                                                                           | 服务的 Capability                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `MOD-CREATOR-BRIDGE` · Agent 制作入口    | 接收制作指令，绑定对话、Project 或工作旅程并创建 Authoring Task  | 需要新增 Combo Plugin 或等价 Agent handoff                                                     | `CAP-010` · 创作来源绑定                                                                     |
| `MOD-CREATOR-UI` · 创作者体验            | Agent Studio、创建进度、审阅修订和发布动作                       | `apps/web/`、可复用 `apps/runtime-web/` 的 Studio 外壳                                         | `CAP-030` · Studio 审阅试跑、`CAP-040` · Package 发布                                        |
| `MOD-AUTHORING` · Agent 创作             | 来源读取、Draft 提取和 Package 编译编排                          | `apps/authoring/`；Agent Package 编译核心需要正式接入                                          | `CAP-010` · 创作来源绑定、`CAP-020` · Draft 提取与 Package 编译、`CAP-030` · Studio 审阅试跑 |
| `MOD-PACKAGE` · Package 核心             | Agent Package 协议、构建、摘要、加载和只读快照                   | `packages/creator-agent-protocol/`、`apps/creator-worker/` 中的 Package 构建器、发布器与加载器 | `CAP-020` · Draft 提取与 Package 编译、`CAP-070` · Package 推理运行                          |
| `MOD-REGISTRY` · Package 注册            | 保存不可变 Package、发布版本和解析 digest                        | `apps/authoring/`、`db/`、对象存储端口；需要新增 Package Release 语义                          | `CAP-040` · Package 发布、`CAP-050` · 双入口分享、`CAP-080` · 安装与会话恢复                 |
| `MOD-SHARE` · 分享服务                   | 生成分享链接与能力获取指令，并把两者解析到 exact Release         | `apps/web/`、`apps/authoring/`；需要新增 Package Entry Resolver                                | `CAP-050` · 双入口分享、`CAP-060` · Agent 能力接收                                           |
| `MOD-RECEIVER` · Agent 能力接收          | 接收链接或能力获取指令，校验并加载对应 Agent Package             | 需要新增 Combo Plugin Receiver 或等价 Agent handoff                                            | `CAP-060` · Agent 能力接收、`CAP-070` · Package 推理运行                                     |
| `MOD-WEB-PREVIEW` · Web 试跑预览         | 在网页中展示试跑过程、对话和产物                                 | `apps/runtime/`、`apps/runtime-web/`                                                           | `CAP-030` · Studio 审阅试跑                                                                  |
| `MOD-CODEX-HOST` · 原生 Codex Agent 运行 | 正式加载 Package、挂载 Skill、绑定当前 Project 并维持 Codex 线程 | `apps/creator-worker/` 中的 Agent Package Session 与 Bundled Codex Host                        | `CAP-070` · Package 推理运行、`CAP-080` · 安装与会话恢复                                     |
| `MOD-SHARED` · 共享基础设施              | 跨服务合同、认证、存储、事件和错误模型                           | `packages/shared/`、`db/`、`infra/`                                                            | `CAP-010` · 创作来源绑定至 `CAP-080` · 安装与会话恢复的跨模块基础设施                        |

当前 `Capability`、旧 `AgentVersion` 或 Catalog 数据可以作为迁移来源、管理投影或历史兼容层，但不能与 Agent Package 并列成为新的交付真相。

## 四、当前工程基线

当前基线由同一仓库内两条尚未形成产品闭环的工程线组成：

- Web、Authoring API、Runtime、数据库、对象存储端口和既有 Capability 发布链路构成现有产品服务线。
- `apps/creator-worker/` 与 Creator Agent 相关 packages 已实现 Agent Package 创作、正式加载和原生 Codex Session，并经过真实流程测试，但尚未接入 Web、Authoring API、Registry 和分享链路。

两条工程线各自已有模块级或独立真实流程测试；跨线 E2E 尚未运行，不能等价为跨用户产品闭环已经完成。

### 已经具备或已被验证的核心机制

- Web、Authoring、Runtime、Runtime Web、数据库和基础设施骨架。
- 来源导入、后台任务、进度事件、能力发布和公开页的既有实现基础。
- Agent Package 的内容寻址协议、固定构建、完整性校验和正式重载机制。
- `AGENT.md` 注入、Package Skill 注册、私有只读运行快照。
- Bundled Codex 的同一线程多轮推理。
- Source Project 与 Consumer Project 分离的真实流程测试。

### 尚未形成产品闭环的部分

- 对话、Project 或工作旅程通过 Agent 制作指令进入 Agent Studio 的直接入口。
- Agent Package Draft 的可视化查看、修订和重新编译。
- Agent Package 与 Authoring API、Web、数据库和对象存储的正式连接。
- `AgentPackageRelease`、云端 Package Registry、稳定分享链接和能力获取指令。
- 分享链接与能力获取指令到使用者 Agent 的 Receiver Handoff。
- 两种入口解析并加载同一 exact Package 的正式消费流程。
- 已安装 Agent 的缓存、列表、升级、移除和 Session 恢复。
- 多 Skill、references、assets、scripts、Tool、MCP 和 App 要求的完整编译与绑定。

因此，当前状态应表述为：**Agent Package 与本地推理内核已经存在，完整的跨用户产品流程尚未闭合。**

## 五、开发路线

### `P0` · 目标与追踪合同

用户结果：团队对最终交付形成唯一理解。

工程工作：

- 以 `PROJECT.md` 中的 `G-001@v1` · 可分享 Agent 作为仓库内唯一产品目标。
- 建立 Journey、Capability、Module、Acceptance 和 Invariant 的稳定 ID。
- 在 PR 和 CI 中校验目标引用与验收证据。

完成标准：任何开发项都能回答它推进了哪个用户旅程，以及如何证明。

### `P1` · 接收者最小闭环

用户结果：其他用户第一次真正收到并使用一个 Agent。

工程工作：

- 用一个固定 Agent Package 建立最小 Package Registry。
- 生成可公开访问的分享链接、Agent 页面和能力获取指令。
- 实现同时接受分享链接与能力获取指令的 Agent Receiver。
- 校验并加载同一 exact Package，随后复用同一 Agent 对话。

完成标准：用户 B 通过链接、用户 C 通过能力获取指令，都能加载用户 A 发布的同一 Package digest，并分别连续完成两轮真实任务。

### `P2` · 创作者最小闭环

用户结果：创作者能从一段 Agent 对话、一个 Project 或一段工作旅程直接生成 Agent。

工程工作：

- 建立 Agent 制作指令到 Authoring Task 的 Creator Bridge，并支持对话、Project 和工作旅程三类来源。
- 将 Agent Package Authoring 接入 Agent Studio。
- 展示提取进度、Agent 身份、能力、来源和试跑结果。
- 支持修订 Draft，并重新编译出新的 Package digest。

完成标准：创作者把制作指令交给自己的 Codex 后即可进入 Studio，完成 exact Package 编译、正式重载和真实试跑。

### `P3` · 发布链路闭环

用户结果：创作者生成的 Agent 可以直接交付给其他用户。

工程工作：

- 建立 `AgentPackageRelease` 和不可变对象存储。
- 将 Studio 的发布动作连接到 Registry 和 Share Service。
- 让 `P2` · 创作者最小闭环生成的链接和能力获取指令直接进入 `P1` · 接收者最小闭环已通过的接收链路。

完成标准：从创作者来源到 Package Release，再分别经链接和能力获取指令进入其他用户 Agent 的两条完整 E2E 一次通过。

### `P4` · Agent Package 能力扩展

用户结果：Agent 可以携带更完整的方法、资源和工具能力。

工程工作：

- 多 Skill 规划与按需路由。
- references、assets 和 scripts 的生成、展示与消费。
- Tool、MCP、App 要求及实际权限绑定。
- Package 评测、来源映射和版本差异展示。

完成标准：富 Package 的每个声明文件和能力都能被加载、验证和真实使用。

### `P5` · 平台化与可靠性

用户结果：用户能长期管理、更新和恢复自己的 Agent。

工程工作：

- 安装、缓存、列表、更新、移除和版本选择。
- Session 持久化、恢复、撤销和跨设备交付。
- 发布治理、访问控制、计费、使用收据和运营能力。

完成标准：创建、发布、安装和运行在中断与重试后仍保持一致。

## 六、产品不变量

| Invariant                             | 规则                                                     | 必须提供的证明                                                        |
| ------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| `INV-010` · 唯一分享工件              | Agent Package 是唯一分享工件                             | 分享链接与能力获取指令都解析到同一 exact Package digest               |
| `INV-020` · 发布内容不可变            | 已发布 Package 的内容不可变                              | 同一 Release 在任意时间加载得到相同 bytes 和 digest                   |
| `INV-030` · 会话版本锁定              | 使用者运行的是接收时锁定的 Package                       | Session receipt 记录 Release 与 Package digest                        |
| `INV-040` · 创作来源不外泄            | 分享内容不携带创作者的原始对话、Project 或完整工作旅程   | Package inventory、Release payload 与公开对象存储扫描通过             |
| `INV-050` · 使用上下文与 Package 分离 | 使用者当前 Project 和对话是运行上下文，不是 Package 内容 | Package digest 不因使用者上下文变化而改变，运行收据单独记录上下文绑定 |
| `INV-060` · 已完成产物可恢复          | 已完成产物在后续失败时仍可恢复                           | 故障测试能够重新打开已生成 Package 或 Release                         |
| `INV-070` · 重试幂等                  | 重试不会重复创建、发布或安装                             | 幂等测试得到同一对象或明确冲突                                        |
| `INV-080` · 旅程验收不可替代          | 模块测试不能替代完整用户旅程验收                         | Release Gate 单独展示 Contract、E2E、Host、Security、UAT 状态         |

这些规则约束实现，但不改写唯一产品目标。

## 七、验收体系

### 验收类型

- `ACC-UNIT-*` · 模块单元验收：模块内部行为。
- `ACC-CONTRACT-*` · 协议完整性验收：协议、状态机和 Package 完整性。
- `ACC-E2E-*` · 端到端产品验收：完整产品链路。
- `ACC-HOST-*` · 真实 Codex Host 验收：真实 Codex Desktop 与 Bundled Codex。
- `ACC-SEC-*` · 安全隔离验收：隐私、权限和隔离。
- `ACC-RECOVERY-*` · 故障恢复验收：中断、重试与恢复。
- `ACC-UAT-*` · 真实用户体验验收：真实用户完成目标体验。

### 总目标完成条件

`ACC-E2E-G001` · 完整跨用户产品闭环

只有下面这条链路在真实环境中完整通过，`G-001@v1` · 可分享 Agent 才能标记为实现：

```text
用户 A 把 Agent 制作指令交给自己的 Codex，并选定一段对话、一个 Project 或一段工作旅程
→ Agent Studio 展示并真实试跑 exact Agent Package
→ 用户 A 发布并同时获得分享链接与能力获取指令
→ 用户 B 打开链接并点击“在 Codex 中使用”
→ 用户 C 把能力获取指令交给自己的 Agent
→ 两种入口加载同一个 exact Agent Package
→ 用户 B 和用户 C 分别在同一 Codex 对话中连续完成两轮真实任务
```

证据至少包含：

- 精确代码提交 SHA。
- Agent Package digest 与 Release ID。
- 创建、发布、两种接收方式和运行环境。
- 脱敏的创作来源收据与两组两轮运行收据。
- 创作来源、Package 与两个使用者上下文的完整性和隔离证明。
- 失败与恢复结果。

页面能打开、接口返回 `200`、单元测试全绿或 Fake Runtime 成功，都不能单独证明目标完成。

## 八、PR 与 CI 追踪规则

每个产品功能 PR 必须声明：

```text
Goal: G-001@v1 · 可分享 Agent
Journey: J-040 · 通过链接使用
Capabilities: CAP-050 · 双入口分享, CAP-060 · Agent 能力接收, CAP-070 · Package 推理运行
Modules: MOD-SHARE · 分享服务, MOD-RECEIVER · Agent 能力接收
Acceptance: ACC-HOST-040 · 分享链接接收 — NOT_RUN · 尚未运行
Invariants: INV-010 · 唯一分享工件, INV-020 · 发布内容不可变, INV-030 · 会话版本锁定
Evidence: <run or artifact URL>
```

合并规则：

- 产品功能没有对应 Journey 或 Capability，不得合并。
- Capability 没有责任 Module 和 Acceptance，不得标记完成。
- 影响产品不变量但没有对应测试，不得合并。
- `PASS` · 验收通过没有环境、提交 SHA 和证据产物，不得接受。
- 基础设施或重构可以不直接完成 Journey，但必须说明服务的 Module。
- 修改 `G-001@v1` · 可分享 Agent 的目标文本，CI 必须失败。

建议 CI 增加：

1. `goal-lock`：校验唯一目标文本摘要。
2. `trace-schema`：校验 ID、状态和必填字段。
3. `trace-integrity`：拒绝没有上游目标或下游验收的孤立节点。
4. `change-coverage`：根据代码路径检查 PR 是否声明对应 Module。
5. `acceptance-evidence`：生成带提交 SHA、环境、Package digest 和状态的证据文件。

## 九、文档权威关系

1. [PROJECT.md](./PROJECT.md) 中的 `G-001@v1` · 可分享 Agent 是仓库内唯一产品目标。
2. 具体 PRD、交互稿和飞书文档负责解释某一阶段的用户行为，不得改写唯一目标。
3. `packages/creator-agent-protocol/`、共享 Schema 和数据库迁移负责实现合同，不得反向定义产品目标。
4. 测试计划和测试报告负责证明完成状态，不得用测试数量替代用户旅程结果。
5. 历史 Capability、旧 AgentVersion 和既有 Runtime 文档属于迁移背景；与本文冲突时，以 `PROJECT.md` 中已确认的目标、体验和唯一产物模型为准。

---

一句话使用本文件：**Goal 决定为什么做，Journey 决定用户经历什么，Capability 决定系统必须会什么，Module 决定代码由谁负责，Acceptance 决定我们凭什么说它已经完成。**
