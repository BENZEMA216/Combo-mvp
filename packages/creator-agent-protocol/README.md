# @cb/creator-agent-protocol

这个包是 Creator-hosted Agent 重建链路的严格协议合约。根出口保持 R1 最小 Host 边界；显式
`broker-transport` 子路径提供 R2C Worker 与 Broker 之间的 canonical wire frame；显式 `agent` 子路径提供
Agent Draft、immutable AgentVersion 与 Project Context Compiler 的 compact source ledger。本包不承载
数据库、WebSocket、密钥、文件扫描、进程管理或产品路由。

## 智能体包

显式 `agent-package` 子路径定义新的 `combo.agent-package/1`，它与旧版 `AgentVersion` 完全隔离。最终工件
是一个内容寻址目录：规范化的 `agent.json` 是机器索引，根 `AGENT.md` 是智能体的语义总入口，
`skills/<name>/SKILL.md` 及同目录下的脚本、参考资料和资源文件是 Codex 原生技能内容。`agent.json` 保存
除自身外的完整排序文件清单、精确字节长度和原始字节 SHA-256 摘要；智能体包摘要是规范化 `agent.json`
的 UTF-8 字节摘要，因此间接绑定包内全部内容。缺失、额外、重复、大小写冲突、未声明技能、文件祖先
冲突、路径逃逸和非规范 JSON 都会被拒绝。V1 不把来源文件模式作为内容；运行时必须把已验证字节物化为
固定只读且不可执行的资源，脚本只能由明确的解释器调用。V1 只声明零个或一个原生技能；包内原生多技能
路由需要后续协议版本。

智能体包不保存项目、模型、Codex 安装路径、任务线程、超时、权限结果、凭据、Worker 命令或确认消息。
`AGENT.md` 也不是 Codex 自动发现的项目 `AGENTS.md`；Combo 运行时必须在创建原生 Codex 任务线程时显式
注入它，并用 Codex 技能注册表激活包内技能。智能体包摘要是内容完整性标识，不是发布者签名或运行成功
证明。

创作端可以生成一份含 Project 根摘要、覆盖统计与相对引用的私有来源回执。可分享 Package 不携带这份
回执、来源文件名或覆盖摘要，只在清单绑定的 `provenance.json` 中保存回执摘要和可选制作要求摘要；
因此 exact Package 仍绑定确定性的创作来源与意图，而消费者不能从 Package 直接读取创作者的来源清单。
制作要求摘要只是不可逆的一致性绑定，不是保密或身份认证证明；随机 Draft ID、revision 和 fingerprint
保留在私有创作状态中，不进入 Package 摘要。

显式 `agent-package-release` 子路径定义 `combo.agent-package-release/1`。一条 Release 只保存不可变
Release ID 和 exact Package digest，作为 Registry、分享入口与 Receiver 共同使用的最小公开引用。它不
复制 Package 清单、行为文本或来源信息，也不保存发布者资料、URL、Project、Prompt、权限、会话或运行
结果。Release ID 由 Registry 使用密码学安全随机数生成，是公开标识而不是授权凭据。Release 合同只绑定
身份与内容；无状态校验无法阻止同一个 Release ID 被重新配到另一摘要，Registry 必须用一次写入和冲突
比对实现不可变性。持久化、公开解析、下载授权和发布者认证属于后续 Registry 服务。

显式 `agent-package-draft` 子路径定义 `combo.agent-package-creator-request/1` 与
`combo.agent-package-draft/1`。前者只携带创作者的一句制作要求，不保存本机路径、任务标识或来源正文；
受信调用方负责把它绑定到已经确认的当前 Project，终端验证入口暂时只绑定当前工作目录，Combo Plugin 的
焦点 Project 绑定尚未接入。后者是 Package 创作期间可查看和修订的不可变快照，绑定
制作要求、Project 根摘要、来源引用、可编辑行为字段、revision 链和 draft fingerprint。修订请求必须带
exact base revision 与 fingerprint，过期编辑会被拒绝。Draft 不能直接运行或分享；只有从 exact Draft
确定性编译出的 `combo.agent-package/1` 才是可加载产物。

同一子路径并列定义 `combo.agent-package-creator-request/2` 与 `combo.agent-package-draft/2`，专门表达
`current_conversation` 来源。V2 request 仍只有固定 intent 与一句制作要求；V2 Draft 的来源投影只保存
`desktop_attested_active_current_task`、`before_direct_creator_item`、`user_visible_items_only`、完整性字面值、
per-run Host HMAC snapshot commitment、选中可见 item 数量和脱敏 coverage summary。它不接受 task、thread、session、item 标识、Project 路径、citation、
消息数组或 raw transcript。V1 与 V2 parser 互相拒绝，fingerprint domain 也彼此独立；现有 Project
Creator、Bridge、Package builder 与来源回执继续只认 V1，不会因为 V2 合同出现而获得对话读取或编译能力。
V2 provenance 只证明 Draft 内部字段一致，不证明 Desktop 已提供真实当前任务、快照完整或用户可见边界。

同一子路径还定义 `combo.agent-package-creator-bootstrap-handoff/1`。Combo Plugin 先对白名单中的官方
创建指南地址完成路由，再把地址归一化成固定指南版本；handoff 只携带该版本、已有的制作要求和
`codex_host_current_saved_project` 绑定声明。它不允许 Project 路径、Project ID、任务 ID、线程 ID 或
网页地址进入跨进程数据。Creator Bridge 的成功输出直接是规范 `combo.agent-package-draft/1`，不会再包一层
临时结果合同。

显式 `creator-authorization` 子路径只定义 `combo.creator-authorization/1` 的 path-free 授权卡语义：
thread、turn、item、Host opaque Project binding、制作要求摘要、exact executor 摘要、最长五分钟以及固定
一次的 Draft-only scope。它不是 bearer token、签名、IPC wire、redemption receipt，也不证明用户已经看到
或批准授权卡；字面值 `issuer=codex_host` 本身也不是 Host 身份证明。

授权 scope 明确披露选定 Creator Project 上下文会进入 Codex 模型服务，当前读取隔离为
`same_uid_unisolated_not_os_enforced`，Combo 只接收 Draft 和相对引用，Project mutation 固定为 `none`，
终态产物固定为 `draft_only`。Project 路径、device、inode 和 workspace generation 不进入 public claims。
真实一次性签发、拒绝、过期、撤销、重放、原子 redemption，以及 redemption 到来源首读之间的当前
workspace generation 核对，必须由未来的受认证 Host ledger/lease 完成；本包不提供 mint、handle、consume
或私有 Project authority API。

旧版 `agent` 子路径中的 Agent Draft 通过新 revision 修订但不能执行；每个 DraftSnapshot 本身都是不可变
值。旧版 AgentVersion 从一个精确 Draft revision 冻结，并以 canonical fingerprint 绑定行为、starter
prompts、source ledger，以及 Git
Project snapshot 或明确的无 Project binding。它不保存本机绝对路径、运行 prompt 或回答；当前版本对
skills 与动态工具保持空集，不把尚未实现的能力写进合同。

## Agent V1、V2 与 V3

V1 的 `combo.creator-agent-definition/1`、`combo.creator-agent-draft/1`、
`combo.creator-agent-draft-handoff/1` 和 `combo.creator-agent-version/1` 保持原字节与解析兼容。V1 handoff
包装完整且已 fingerprint 的 DraftSnapshot，要求 `authoringSource=codex_current_task` 且
`rawStored=false`。它继续服务手工 current-task 诊断路径，不会被原地扩宽成 Project 扫描合同。

Project Context Compiler 使用独立的 `combo.creator-agent-definition/2`、`combo.creator-agent-draft/2`、
`combo.creator-agent-draft-handoff/2` 和 `combo.creator-agent-version/2`。V2 Definition 的
`authoringSource` 固定为 `project_context_compiler`，并嵌入
`combo.creator-agent-project-source-ledger/1`。通用 parser、serializer 和 freeze dispatcher 会按明确的
protocol 字段分派 V1、V2 或 V3；未知协议会 fail-closed。

V2 compact source ledger 只保存扫描 profile、完整 Project root digest、coverage counts，以及最多 32 个
被引用 source 的相对路径、内容 digest 和 `FIXED_GIT_TREE` 或 `AUTHORING_ONLY` 可用性。它不另存 full
inventory 或 Project 文件附件；Draft 自由文本仍可能含 Project 摘录。它也不声称模型理解了全量索引中
的每个字节。`rawStored=false`、fingerprint 和引用 digest 都是一致性合同，不是来源认证、模型服务保密
或自动脱敏证明。

V2 创建时可以让 hidden、ignored、untracked、日志、task/session、`.env` 和物理 `.git` 内容参与
authoring，但 Runtime 仍只使用 Version 绑定的 commit-pinned tracked Git tree。标为 `AUTHORING_ONLY` 的
证据可以影响已冻结行为，却不会成为运行 snapshot 中可读取的文件。

当 formal Project 根不能形成受支持的 canonical Git snapshot 时，Project Context Compiler 使用独立的
V3 Definition、Draft、handoff 与 Version。V3 固定 `projectBinding=none` 和 `BEHAVIOR_ONLY_V1`，并在协议
层要求全部 citation 为 `AUTHORING_ONLY`、authoring-only coverage 等于完整 entry coverage。Runtime 因此
只能使用冻结行为和本轮用户输入，不能重新挂载 authoring corpus，也不能自动选择某个嵌套仓库。

`combo.creator-agent-version/1`、`combo.creator-agent-version/2` 和 `combo.creator-agent-version/3` 都是 local unpublished execution
contract。它们不等同于公开分享协议 `combo.codex-agent-share/1`，也不等同于旧
`CapabilityDefinition`。本包没有声明这些体系的兼容、继承或迁移关系；后续必须通过显式投影或迁移合同
连接，不能靠相似字段或名称隐式转换。

## R1 保证

- `HostThread` 必须携带 runtime ID、进程 generation，并确认 workspace roots 已被接受；generation 漂移就是另一条线程。
- `CreatorHost.startTurn()` 只有拿到完整 thread/generation/turn binding 后才返回 handle。消费者必须用 `verifyHostTurnHandle()` 验证 controller authority；start 拒绝也必须用 adapter factory 签发并经 `verifyHostTurnStartRejection()` 验证，裸 `new Error` 或结构体不是证据。
- `HostTurnHandle.outcome` 是唯一终态。成功结果与 SUCCEEDED 终态原子返回；FAILED/CANCELLED 不携带结果。该 handle 自己的 `verifyOutcome()` 会返回冻结 clone，terminal 不能脱离 result 单独验证。
- 每个 handle 只有一个私有 adapter controller，同时锁住一个终态和一条中断 lineage。`interrupt()` 只返回命令 disposition，不返回第二份终态。
- `SENT` 只能由同步 Host 写入线性化回调产生。第一个成功写出的 reason/request ID 被 latch，后续调用返回同一回执；确定 `NOT_SENT` 后才允许新尝试。终态先赢则返回 `TERMINAL_ALREADY_OBSERVED` 且不得写 Host。
- CANCELLED/TURN_TIMEOUT 必须绑定该 handle 唯一的同 thread、generation、turn、reason 和 request ID 回执。已发送中断不阻止稍后真实 SUCCEEDED/FAILED 终态胜出。
- thread ID、turn ID、message ID、request ID 与 generation 都是运行时校验且名义隔离的类型。

Host 结果与完整终态事实会生成 deterministic SHA-256 fingerprint。fingerprint
只用于一致性和变更检测，不认证 Host 来源。outcome 与回执由具体 handle 实例签发并且
不能跨 handle 验证；JSON 序列化后会被拒绝。这仍然信任创建该 handle 的 Host adapter，
不是安全沙箱。R2 必须锁定生产 composition/import boundary；若跨越 Worker/Broker 信任
边界，还要加入 MAC 或签名，不能把本 fingerprint 当作证明。

## 出口与信任边界

- `@cb/creator-agent-protocol` 与 `/host`：给组合根和消费者使用，只暴露严格输入、Host port、结果类型与 verify API。
- `@cb/creator-agent-protocol/host-adapter`：只给受信 Host adapter 使用，创建每个 turn 私有的 controller、start rejection，并接收同步 Host 写入线性化 callback。
- `@cb/creator-agent-protocol/broker-transport`：只暴露严格 canonical frame、四类 body、方向、fingerprint 与 transport-value canonicalizer；它不建立网络连接，也不签发 owner、Lease 或 Cloud authority。
- `@cb/creator-agent-protocol/agent`：暴露严格的 V1/V2/V3 Definition、Draft、handoff、Version、compact
  source ledger、freeze/verify 和 canonical 序列化；它不执行 Project 扫描，也不证明作者身份、模型读取
  覆盖、实际脱敏、用户确认、Git remote 可达或 OS 级 Project 隔离。
- `@cb/creator-agent-protocol/agent-package`：暴露独立的智能体包清单、原始文件摘要、智能体包摘要与规范化
  解析和序列化函数；它不导入或升级旧版 `AgentVersion`，也不读取文件系统或启动 Host。
- `@cb/creator-agent-protocol/agent-package-draft`：暴露一句制作要求、可修订 Package Draft、乐观 revision
  请求、Creator bootstrap handoff、Project V1 与 current-conversation V2 的 domain-separated draft
  fingerprint 和规范化解析；它不暴露 Host snapshot 或任务选择 API，不保存绝对 Project 路径或 raw
  transcript，也不执行提取、编译、发布或推理。
- `@cb/creator-agent-protocol/agent-package-release`：暴露不可变 Release ID 到 exact Package digest 的最小
  规范引用；它不保存或解析链接，不访问 Registry，也不复制 Agent 定义。
- `@cb/creator-agent-protocol/creator-authorization`：只暴露 path-free 授权卡 claims schema、固定 scope
  与脱敏错误分类；不暴露 mint、handle、consume、redemption transport 或 Project identity。
- `@cb/creator-agent-protocol/desktop-current-conversation-receipt`：只暴露真实 Desktop current-task Draft
  receipt 的 strict schema、domain-separated canonical message、parse/verify/digest API；验签必须由调用方
  提供仓库外受信 Host public key。它不暴露 signer、private key、Host snapshot transport，也不使一份 receipt
  自动成为 Host/UAT PASS 证据。receipt 要求 snapshot 与 task binding 使用 per-run Host HMAC commitment，禁止
  可跨运行关联或字典攻击的 raw transcript SHA；public key 必须来自 receipt 外的 pinned/revocable registry。
- canonical JSON、通用 hash 和底层 primitives 仍是包内实现，不是公共产品 API。

本包明确不包含 Invocation reducer、错误/重试 HTTP 映射、Cloud/Worker journal、
WebSocket driver、Execution Capability、文件物化或运行时 Snapshot capability、OpenAPI、生成 Schema
或大规模 corpus。

## 验证

```bash
pnpm -F @cb/creator-agent-protocol build
pnpm -F @cb/creator-agent-protocol typecheck:test
pnpm -F @cb/creator-agent-protocol test
```
