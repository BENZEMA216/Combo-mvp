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
  Codex 原生技能入口及全部智能体包文件的路径、长度和原始字节 SHA-256 摘要，并为 Project-history lane
  定义 Package 内规范 `starter-prompts.json`，使公开起始任务受 Package digest 约束；它还定义创作端私有来源
  回执与 Package 内不披露文件名的 opaque provenance 绑定；它不包含项目、会话或 Worker 运行字段，也不
  进入旧版 `AgentVersion` 分派器。
- `agent-package-draft.ts`：显式 `./agent-package-draft` 子路径的三套互斥合同。V1 继续绑定一句制作要求、
  当前 Project 来源、Creator bootstrap handoff、Package Draft 快照与 revision；V2 单独绑定当前对话制作
  要求、`current_conversation` 脱敏来源投影和独立 fingerprint domain。V2 不定义 Host snapshot wire，也不
  接受 task/thread/session/item ID、Project 路径、citation、消息数组或 raw transcript。V3 只表达用户显式
  选择 saved Project 后的 best-effort reduced-history typed candidate/counts，并固定 coverage、Host attestation
  与 source projection 为 `not_proven`；它最多选择并读取 20 个 eligible 任务，其余同 Project 任务
  计入上限 10,000 的 omitted 计数，不把 pinned 返回总数假定为 50；它还对明显 credential 模式 fail closed。三版都不把 Draft冒充可运行
  Package；Project-history builder 只从 exact V3 Draft 产生 Package。
- `agent-package-share.ts`：`combo.agent-package-share/2` 的 exact Package byte inventory、public share 和
  `COMBO_AGENT_PACKAGE_RUN/2`。它逐文件核对路径、排序、长度和摘要，并要求顶层 starter 与 Package 内
  digest-bound 规范 starter manifest 逐项一致；它为 Host 返回服务端验证的 cleartext
  runtime projection，并固定 `hostInstalledEnforcement=not_proven`。它另外生成/解析不超过 8 KiB 的严格
  receiver launch prompt；用户可见文本只包含公开 share URL、Package digest、Agent 名和 exact starter，
  不携带 JSON、runtime material 或内部 ID。
- `strict-json.ts`：在 canonicalize 或 Zod 前递归读取 property descriptor，拒绝 Proxy、accessor、symbol、
  cycle、giant key、过深/过多节点与超预算 UTF-8；Package V1 与 Share V2 共用同一实现。
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
  与篡改回归，以及 Project-history Draft V3、Package Share/Run、credential lexical guard 和 hostile JSON 回归。

该目录不得导入应用、数据库、Broker、文件系统或部署代码。source ledger 是已扫描事实的 compact 合同，
不另存 full inventory 或 Project 文件附件，也不证明模型理解了每个字节；Draft 自由文本仍可能含 Project
摘录。Draft 只能通过新 revision 修订，每个 DraftSnapshot 本身不可变且不可执行；只有完整性校验通过的
AgentVersion 才能进入 Runtime。V1/V2 Runtime 物化 commit-pinned tracked Git tree；V3 Runtime 使用空的
临时 Project，只运行冻结行为。
