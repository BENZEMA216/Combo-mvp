# 源码职责

- `primitives.ts`：Host 合约内部使用的最小、名义隔离值域。
- `canonical.ts`：内部 consistency fingerprint；拒绝循环、getter、稀疏数组、非有限数字和 malformed Unicode。
- `broker-transport.ts`：显式子路径的 canonical Worker/Broker wire frame、方向规则、语义 fingerprint 与完整 wire fingerprint。
- `agent.ts`：显式 `./agent` 子路径的 V1/V2/V3 Agent Definition、按 revision 修订的不可变 DraftSnapshot、
  strict handoff 与不可变 AgentVersion；V1 保留 current-task handoff 兼容，V2 用 compact source ledger
  绑定 Project root digest、coverage counts、source citation digest 与固定 Git Project，V3 则固定无 Project
  binding 并要求所有 evidence 仅供 authoring。该文件还定义只读本机执行 profile、按 protocol 分派的
  canonical serializer/parser 和 domain-separated fingerprint。
- `agent-package.ts`：显式 `./agent-package` 子路径的独立内容寻址智能体包清单。它绑定根 `AGENT.md`、
  Codex 原生技能入口及全部智能体包文件的路径、长度和原始字节 SHA-256 摘要，并定义创作端私有来源
  回执与 Package 内不披露文件名的 opaque provenance 绑定；它不包含项目、会话或 Worker 运行字段，也不
  进入旧版 `AgentVersion` 分派器。
- `agent-package-draft.ts`：显式 `./agent-package-draft` 子路径的两套互斥合同。V1 继续绑定一句制作要求、
  当前 Project 来源、Creator bootstrap handoff、Package Draft 快照与 revision；V2 单独绑定当前对话制作
  要求、`current_conversation` 脱敏来源投影和独立 fingerprint domain。V2 不定义 Host snapshot wire，也不
  接受 task/thread/session/item ID、Project 路径、citation、消息数组或 raw transcript。两版都不把 Draft
  冒充可运行 Package，现有 Package builder 仍只认 V1。
- `agent-package-release.ts`：显式 `./agent-package-release` 子路径的不可变 Release 引用，只把稳定 Release
  ID 绑定到 exact Package digest，不保存分享链接、发布者资料、Package 内容或运行状态。
- `creator-authorization-contract.ts`：未来原生 Host 授权卡的 path-free claims、固定 Draft-only scope、
  最长五分钟语义和脱敏错误分类；它不实现 mint、handle、consume、IPC sealing 或私有 Project authority。
- `creator-authorization.ts`：公开语义子路径，只显式导出上述 schema、常量、类型与固定错误。
- `desktop-current-conversation-receipt.ts`：真实 Desktop current-task Draft 运行的签名证据合同。它把 exact
  candidate、组件版本、脱敏 per-run task binding、visible-only 完整快照、Host egress candidate、candidate
  到 typed same-task Draft 的投影、固定事件 hash chain 和 Host 端到端零旁路观测声明绑定到受信 Ed25519
  Host key；签名消息还绑定协议、算法、issuer 与 key ID。它不提供签发器、独立 Worker attestation 或 Host
  snapshot transport。snapshot commitment 与 task binding 都固定为 domain-separated per-run Host HMAC，不能
  使用 raw transcript SHA；签名能力只能从 Host-owned run state 组装 receipt，不能成为“签 caller payload”的
  通用 oracle。verifier 是无状态的；跨 artifact 重放由外部 evidence registry 原子拒绝 `(issuer,keyId,runId)`。
- `host-contract.ts`：Host structural port、原子 outcome、handle-private controller 与 first-sent interrupt lineage。
- `host.ts`：消费者出口；不暴露 producer 或通用 canonical helper。
- `host-adapter.ts`：受信 Host adapter 出口；R2 接线时必须用 import-boundary gate 限制生产导入方。
- `index.ts`：与 `host.ts` 等价的显式根出口；不得使用通配导出。
- `__tests__/`：R1 Host 合约、CreatorAuthorization 授权卡语义、R2C Broker 规范传输格式、V1/V2/V3
  智能体规范往返、Creator bootstrap handoff、Project Package Draft V1 与 current-conversation Draft V2
  的互斥解析、revision、domain-separated fingerprint，以及独立智能体包的规范字节、内容摘要、严格路径
  与篡改回归。

该目录不得导入应用、数据库、Broker、文件系统或部署代码。source ledger 是已扫描事实的 compact 合同，
不另存 full inventory 或 Project 文件附件，也不证明模型理解了每个字节；Draft 自由文本仍可能含 Project
摘录。Draft 只能通过新 revision 修订，每个 DraftSnapshot 本身不可变且不可执行；只有完整性校验通过的
AgentVersion 才能进入 Runtime。V1/V2 Runtime 物化 commit-pinned tracked Git tree；V3 Runtime 使用空的
临时 Project，只运行冻结行为。
