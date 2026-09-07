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
| `J-011` · 当前对话生成 Draft  | 创作者在当前 Codex Desktop 任务中用一句自然语言把刚才的对话做成 Agent                    | Agent Package Draft                | `CAP-011` · Desktop 当前对话绑定、`CAP-012` · 当前对话 Draft 提取                                | `MOD-CREATOR-BRIDGE` · Agent 制作入口、`MOD-AUTHORING` · Agent 创作、`MOD-CREATOR-UI` · 创作者体验                                                                    | `ACC-CONTRACT-011A`、`ACC-UNIT-011B`、`ACC-SEC-011C`、`ACC-HOST-011D`、`ACC-UAT-011E` · 对话优先创作五层验收                   |
| `J-010` · 提交 Agent 创作来源 | 用户把一段 Agent 对话、一个 Project 或一段工作旅程交给自己的 Codex，并用制作指令启动创建 | Agent Package Draft                | `CAP-010` · 创作来源绑定、`CAP-020` · Draft 提取与 Package 编译                                  | `MOD-CREATOR-BRIDGE` · Agent 制作入口、`MOD-AUTHORING` · Agent 创作、`MOD-PACKAGE` · Package 核心                                                                     | `ACC-E2E-010` · 多来源创作启动：三类来源都能形成边界明确的 Draft，且无需用户理解内部文件和摘要                                 |
| `J-020` · Studio 生成与体验   | 用户看到 Agent 的身份、能力、来源和真实试跑结果，并可修订                                | Agent Package Draft、Agent Package | `CAP-020` · Draft 提取与 Package 编译、`CAP-030` · Studio 审阅试跑、`CAP-070` · Package 推理运行 | `MOD-CREATOR-UI` · 创作者体验、`MOD-AUTHORING` · Agent 创作、`MOD-PACKAGE` · Package 核心、`MOD-WEB-PREVIEW` · Web 试跑预览、`MOD-CODEX-HOST` · 原生 Codex Agent 运行 | `ACC-E2E-020A` · Package 编译试跑：正式重载后完成真实试跑；`ACC-UAT-020B` · Studio 审阅修订：完整展示内容，修订后生成新 digest |
| `J-030` · 发布并生成双入口    | 用户发布后同时获得分享链接和可复制的能力获取指令                                         | Agent Package Release              | `CAP-040` · Package 发布、`CAP-050` · 双入口分享                                                 | `MOD-CREATOR-UI` · 创作者体验、`MOD-REGISTRY` · Package 注册、`MOD-SHARE` · 分享服务、`MOD-SHARED` · 共享基础设施                                                     | `ACC-E2E-030` · 精确发布入口：链接与能力获取指令始终解析到同一 Package digest                                                  |
| `J-040` · 通过链接使用        | 使用者打开链接并将 Agent 加载到自己的 Codex                                              | Installed Agent                    | `CAP-050` · 双入口分享、`CAP-060` · Agent 能力接收、`CAP-070` · Package 推理运行                 | `MOD-SHARE` · 分享服务、`MOD-RECEIVER` · Agent 能力接收、`MOD-PACKAGE` · Package 核心、`MOD-CODEX-HOST` · 原生 Codex Agent 运行                                       | `ACC-HOST-040` · 分享链接接收：允许一次简要复制操作，最终在真实 Codex 中加载 exact Package                                     |
| `J-045` · 用一段话获取能力    | 使用者把能力获取指令交给自己的 Agent，该 Agent 获取并加载对应能力                        | Installed Agent                    | `CAP-050` · 双入口分享、`CAP-060` · Agent 能力接收、`CAP-070` · Package 推理运行                 | `MOD-SHARE` · 分享服务、`MOD-RECEIVER` · Agent 能力接收、`MOD-PACKAGE` · Package 核心、`MOD-CODEX-HOST` · 原生 Codex Agent 运行                                       | `ACC-HOST-045` · 自然语言能力获取：用户自己的 Agent 从指令解析 exact Release，完成校验和加载                                   |
| `J-050` · 持续使用            | 使用者在同一个 Agent 对话中持续使用已获取能力完成工作                                    | Agent Session                      | `CAP-070` · Package 推理运行                                                                     | `MOD-PACKAGE` · Package 核心、`MOD-CODEX-HOST` · 原生 Codex Agent 运行                                                                                                | `ACC-E2E-050` · 同线程两轮推理：同一 Package 与同一 Codex 线程连续完成两轮真实任务                                             |
| `J-055` · 余额不足后继续使用  | 使用者在收费调用被余额拦住后，通过 Combo 托管支付完成入账，并继续原业务请求              | Agent Session                      | `CAP-075` · 平台托管支付                                                                         | `MOD-PAYMENTS` · 支付中台、`MOD-CODEX-HOST` · 原生 Codex Agent 运行、`MOD-SHARED` · 共享基础设施                                                                      | `ACC-CONTRACT-055A`、`ACC-SEC-055B`、`ACC-RECOVERY-055C`、`ACC-HOST-055D`、`ACC-UAT-055E` · 支付接入五层验收                   |

当前 Creator Golden Path 只以 `J-011` 作为独立最小里程碑。`J-010` 中显式 Project 与工作旅程来源继续保留，但状态为
`DEFERRED`，不能阻塞 `J-011`，也不能用其测试结果替代 `J-011`。

`CAP-075` · 平台托管支付与 `CAP-080` · 安装与会话恢复都属于 `P5` · 平台化与可靠性，用于强化长期使用，不是最小产品闭环成立的前置条件。

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

| Module                                   | 责任                                                                                                                                 | 当前仓库主要承载位置                                                                                                                                           | 服务的 Capability                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `MOD-CREATOR-BRIDGE` · Agent 制作入口    | 接收制作指令，默认消费 Desktop attested active-task 对话来源；Project 与工作旅程作为独立显式来源                                     | 需要新增 Desktop current-task handoff，具体 Host / Plugin API 尚未冻结；旧 Hook / Bridge 只保留 Project 兼容职责                                               | `CAP-010` · 创作来源绑定、`CAP-011` · Desktop 当前对话绑定                                                                    |
| `MOD-CREATOR-UI` · 创作者体验            | Codex Desktop 内的创建进度、Agent Studio、审阅修订和发布动作                                                                         | 需要新增 Codex Desktop Creator / Studio surface；`apps/web/` 与 `apps/runtime-web/` 仅可复用展示能力                                                           | `CAP-030` · Studio 审阅试跑、`CAP-040` · Package 发布                                                                         |
| `MOD-AUTHORING` · Agent 创作             | 来源读取、Draft 提取和 Package 编译编排                                                                                              | `apps/authoring/`；Agent Package 编译核心需要正式接入                                                                                                          | `CAP-010` · 创作来源绑定、`CAP-012` · 当前对话 Draft 提取、`CAP-020` · Draft 提取与 Package 编译、`CAP-030` · Studio 审阅试跑 |
| `MOD-PACKAGE` · Package 核心             | Agent Package 协议、构建、摘要、加载和只读快照                                                                                       | `packages/creator-agent-protocol/`、`apps/creator-worker/` 中的 Package 构建器、发布器与加载器                                                                 | `CAP-020` · Draft 提取与 Package 编译、`CAP-070` · Package 推理运行                                                           |
| `MOD-REGISTRY` · Package 注册            | 保存不可变 Package、发布版本和解析 digest                                                                                            | `apps/authoring/`、`db/`、对象存储端口；需要新增 Package Release 语义                                                                                          | `CAP-040` · Package 发布、`CAP-050` · 双入口分享、`CAP-080` · 安装与会话恢复                                                  |
| `MOD-SHARE` · 分享服务                   | 生成分享链接与能力获取指令，并把两者解析到 exact Release                                                                             | `apps/web/`、`apps/authoring/`；需要新增 Package Entry Resolver                                                                                                | `CAP-050` · 双入口分享、`CAP-060` · Agent 能力接收                                                                            |
| `MOD-RECEIVER` · Agent 能力接收          | 接收链接或能力获取指令，校验并加载对应 Agent Package                                                                                 | 需要新增 Combo Plugin Receiver 或等价 Agent handoff                                                                                                            | `CAP-060` · Agent 能力接收、`CAP-070` · Package 推理运行                                                                      |
| `MOD-WEB-PREVIEW` · Web 试跑预览         | 在网页中展示试跑过程、对话和产物                                                                                                     | `apps/runtime/`、`apps/runtime-web/`                                                                                                                           | `CAP-030` · Studio 审阅试跑                                                                                                   |
| `MOD-CODEX-HOST` · 原生 Codex Agent 运行 | 正式加载 Package、挂载 Skill 并维持 Codex 线程；未来顶层 Desktop Host 还需提供不可伪造的当前 active task 来源边界和显式 Project 权限 | 当前 `apps/creator-worker/` 只承载 Agent Package Session、Project Creator 授权语义与自建 Bundled Codex Host；Desktop current-task handoff 为 `NOT_IMPLEMENTED` | `CAP-010` · 创作来源绑定、`CAP-011` · Desktop 当前对话绑定、`CAP-070` · Package 推理运行、`CAP-080` · 安装与会话恢复          |
| `MOD-PAYMENTS` · 支付中台                | 保存权威支付请求、订单、到账、资金预留和流水；向 Host 提供托管收银台；不保存或恢复业务请求                                           | `apps/billing/` 与 `packages/payment-protocol/` 已提供支付 API、身份校验、渠道与收银台模块；实际环境和 Host 验收仍未完成                                       | `CAP-075` · 平台托管支付                                                                                                      |
| `MOD-SHARED` · 共享基础设施              | 跨服务合同、认证、存储、事件和错误模型                                                                                               | `packages/shared/`、`db/`、`infra/`                                                                                                                            | `CAP-010` · 创作来源绑定至 `CAP-080` · 安装与会话恢复的跨模块基础设施                                                         |

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
- `CreatorAuthorization/1` 的 path-free Project 授权卡 claims、固定 Draft-only scope，以及未接线的内部
  redemption ordering / dispatch-scoped lease / scanner 首读绑定 seam；它只服务未来显式 Project 来源，当前没有
  生产 adapter 或可运行入口。
- `agent-package-creator-request/2` 与 `agent-package-draft/2` 的 current-conversation path-free 合同，以及
  未接线的内部 ambient lease ordering seam。它锁定 direct-user、active-task、user-visible-only、完整性、
  trigger 前快照边界、制作要求语义绑定、Host-owned verbatim/credential egress receipt、前后漂移核对、close
  和零 Project/Bridge/child-process import。V2 协议会随公开 `agent-package-draft` 子路径进入 production
  build；Worker ordering seam 与公开 production fail-closed facade 也进入 production build，但当前 composition
  只绑定固定 unavailable Host，没有真实 Host adapter 或 Studio surface。
- `desktop-current-conversation-run-receipt/1` 的 canonical Ed25519 验收收据与只读 verifier；它把 exact
  candidate、组件版本、脱敏 task binding、完整 visible-only 来源、Host egress 候选摘要、候选到 typed
  same-task Draft 的投影、事件 hash chain 和 Host 签名的端到端零旁路观测声明绑定到仓库外受信 Host key。
  当前 Desktop 尚不能签发，因此它是未来真实验收的验证合同，不是 Host/UAT PASS 证据；本合同不虚构尚未
  建立独立信任根的 Worker 第二签名。

### 尚未形成产品闭环的部分

- 顶层 Codex Desktop 对当前 active task 建立不可由业务调用方、Plugin 或 MCP 伪造的来源边界，并在同一任务展示
  Draft 的直接入口。具体 Host / Plugin API 尚未冻结；当前仓内 Bundled Host 只会自建线程，不能冒充该能力。
- 对话来源的 Desktop active-task attestation、完整性边界、缺失或压缩内容的停止语义，以及真实 Desktop UAT。
- 用户显式选择 Project 来源时所需的最小读取权限、workspace generation 核对和真实权限 UI。旧 Hook 只能作为
  Project 兼容路径，不能冒充普通用户入口或任何 `J-011` 验收证据。
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

用户结果：创作者先从当前 Codex Desktop 对话直接得到可审阅的 Agent Package Draft。

工程工作：

- 先完成 `J-011` · 当前对话生成 Draft：用户在当前 Codex Desktop 任务只输入一句自然语言制作指令，Desktop
  运行时把不可由调用方伪造的当前 active task 作为默认来源边界，不要求 Terminal、`/hooks`、手工 trust、
  Project 路径或内部 handoff。
- 这句直接用户指令只授权使用当前任务的可见对话，不授权读取 Project。对话不可用、不完整、漂移或无法证明
  来自当前任务时必须停止，不得静默回退到 Project scan、raw session 文件或旧 Hook / Bridge。
- Project 与工作旅程作为后续独立来源选项。用户显式选择 Project 时默认排除 `.env`、日志、task/session、
  hidden 和 ignored 内容；只有扩大读取或披露范围时才使用 Host 原生权限机制。
- 将 Agent Package Authoring 接入 Agent Studio。
- 展示提取进度、Agent 身份、能力、来源和试跑结果。
- 支持修订 Draft，并重新编译出新的 Package digest。

当前最小完成标准：`J-011` 独立通过五层验收，创作者在同一 Codex Desktop 任务发出一句自然语言后看到可审阅
Draft。显式 Project、工作旅程、Package 编译、正式重载和真实试跑分别留在后续 Acceptance，不阻塞这一最小
里程碑。旧 Hook / Bridge、CLI、Fake Host 或独立 Bundled Codex thread 测试不得替代其中任何一层。

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
- 余额不足时由支付中台生成权威支付请求，Agent 只把平台支付凭证交给 Host；到账后由业务使用自己保存的请求继续执行。

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
| `INV-091` · 对话默认零 Project 读取   | 当前对话来源不得读取 Project 或 raw session 文件         | Host 事件与文件观测证明 Project read/write 都为零                     |
| `INV-092` · Desktop 是普通用户入口    | 普通用户只在 Codex Desktop 当前任务输入一句自然语言      | UAT 全程无 Terminal、`/hooks`、手工 trust、路径和内部协议             |
| `INV-093` · 来源授权最小化            | 直接指令只同意当前可见对话；扩大来源必须独立选择和授权   | 对话来源无二次授权，Project 扩权有 Host 权限证据且拒绝时零读取        |

这些规则约束实现，但不改写唯一产品目标。

旧 `INV-090` · 创作来源先授权是 Project-first Creator 的工程假设，不再作为当前对话 Golden Path 的活动不变量。
其一次性 Project 授权语义只保留给未来显式 Project 来源，不能要求普通用户为当前对话制作额外 trust 或授权卡。

## 七、验收体系

### 验收类型

- `ACC-UNIT-*` · 模块单元验收：模块内部行为。
- `ACC-CONTRACT-*` · 协议完整性验收：协议、状态机和 Package 完整性。
- `ACC-E2E-*` · 端到端产品验收：完整产品链路。
- `ACC-HOST-*` · 真实 Codex Host 验收：真实 Codex Desktop 与 Bundled Codex。
- `ACC-SEC-*` · 安全隔离验收：隐私、权限和隔离。
- `ACC-RECOVERY-*` · 故障恢复验收：中断、重试与恢复。
- `ACC-UAT-*` · 真实用户体验验收：真实用户完成目标体验。

### 当前优先验收：`J-011` · 当前对话生成 Draft

新流程以 `apps/creator-worker/creator-conversation-acceptance.v1.json` 为机器可读状态，并由
`apps/creator-worker/CREATOR_CONVERSATION_ACCEPTANCE.md` 规定真实证据。五层门禁必须独立报告：

| Acceptance                                | 证明内容                                                                                                 | 当前状态          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------- |
| `ACC-CONTRACT-011A` · 当前对话 Draft 合同 | source 明确为当前可见对话，禁止 Project 路径、Hook 字段、调用方 task/thread/session ID 和 raw transcript | `NOT_RUN`         |
| `ACC-UNIT-011B` · 对话提取                | 只使用选定对话，Project scanner、projection、Bridge 和 child process 为零                                | `NOT_IMPLEMENTED` |
| `ACC-SEC-011C` · 零旁路                   | 缺失、漂移、egress 拒绝或失败时不回退到 Project、raw session、Hook 或 Terminal                           | `NOT_IMPLEMENTED` |
| `ACC-HOST-011D` · Desktop 原生链路        | Desktop attested active-task 边界成立，当前任务一句话直接显示可审阅 Draft                                | `NOT_IMPLEMENTED` |
| `ACC-UAT-011E` · 普通用户体验             | 非开发用户仅操作 Desktop，并证明跨任务来源隔离                                                           | `NOT_RUN`         |

V2 协议、Worker ordering seam 与 production fail-closed facade 是实现准备，不是五层验收证据。公开 V2 合同
已经实现，但尚无绑定 exact candidate commit 的正式 `CONTRACT_TEST_REPORT`，所以 Contract 层为 `NOT_RUN`。
Production composition 只绑定固定 unavailable Host，没有 Desktop importer、真实 active-task snapshot 或同任务
Draft UI；因此 Unit、Security 与 Host 层继续为 `NOT_IMPLEMENTED`。不能用 source-level 单元测试或固定失败入口
把任一层直接改成 `PASS`。

只要任一层未通过，`J-011` 就保持 `BLOCKED`。机器合同测试通过只证明团队没有篡改验收定义，不证明产品路径存在。
机器合同要求每个 `PASS` 分别绑定该层 evidence kind、artifact digest、运行环境和同一个顶层 `candidateCommit`；
五层一起改成 `PASS` 但没有 evidence，或拼接不同 commit 的 evidence，都必须失败。观测窗口固定为
`DIRECT_USER_CREATOR_ITEM_ACCEPTED` 至
`DRAFT_TERMINAL_RESULT`，只统计该窗口内新增的 Creator Project scan/read/write、用户 Terminal 动作和 Creator
CLI / Bridge child process。`PROJECT_FIRST_CREATOR`、`PLUGIN_HOOK_OR_BRIDGE`、`CREATOR_CLI`、
`FAKE_HOST_OR_PORT`、`ISOLATED_BUNDLED_CODEX_THREAD` 全部是机器枚举的非产品证据，不能提升上述状态。

### `J-055` · 余额不足后继续使用

这条旅程只接受平台托管支付。Payment SDK 是无状态客户端：业务保存原请求、`operationId`、`callId`、状态和结果；
支付中台保存价格快照、支付请求、订单、回调、入账、资金预留和流水；Host 只解析 Combo 签发的短期支付凭证并打开
Combo 收银台。Agent 提供的网址、二维码、金额、用户或 Agent 标识都不是权威数据。

| Acceptance                             | 证明内容                                                                                                | 当前状态  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------- |
| `ACC-CONTRACT-055A` · 支付公共合同     | 标准 402、三字段 Host 消息、支付状态和 OpenAPI 使用同一严格协议，未知字段与非法值失败关闭               | `NOT_RUN` |
| `ACC-SEC-055B` · 支付身份与凭证隔离    | 每个 Agent 使用短期、限权身份；平台重新验证当前用户；Agent 不能改价、伪造 Host 地址或跨用户查询支付     | `PARTIAL` |
| `ACC-RECOVERY-055C` · 到账与原调用恢复 | 到账只入账一次并为原收费调用留出资金；业务用原 `operationId` 与 `callId` 继续，重复恢复不重复调用或扣费 | `PARTIAL` |
| `ACC-HOST-055D` · Combo 托管收银台     | Host 只接收短期支付凭证，使用当前登录用户向 Combo 解析并展示平台收银台                                  | `PARTIAL` |
| `ACC-UAT-055E` · 支付 SDK 盲交接       | Fresh 开发者和编码 Agent 仅凭锁定 SDK、规范文档与受限 Test 配置完成 402、支付、继续和重复恢复验收       | `NOT_RUN` |

公共协议、SDK 单元测试、Fake Payment 或本地 Reference Agent 不能单独把这条旅程标记为通过。正式 `PASS` 必须绑定同一候选提交、
SDK 工件校验值、真实 Host 身份、Test 支付中台和端到端收据。退款、订阅、分账、税务、多币种与主动充值不属于第一版。

当前支付 API、每 Agent 身份、到账与资金预留、渠道下单/验签/查单、收银台和 SDK 已有模块实现，并完成部分跨仓模拟验证。上述 PARTIAL 只表示实现进度：真实代理隔离、平台环境、Codex Host 接入、真实支付及盲交接证据仍缺失，不能据此关闭支付验收。

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
