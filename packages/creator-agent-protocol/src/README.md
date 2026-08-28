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
- `agent-package-draft.ts`：显式 `./agent-package-draft` 子路径的一句制作要求、Package Draft 快照和乐观
  revision 合同。它也定义只含官方指南版本、当前 Project 绑定声明和制作要求的 Creator bootstrap
  handoff。它用 domain-separated fingerprint 绑定可编辑行为、来源摘要和 revision 链，不保存本机 Project
  绝对路径，也不把 Draft 冒充可运行 Package。
- `creator-authorization-contract.ts`：未来原生 Host 授权卡的 path-free claims、固定 Draft-only scope、
  最长五分钟语义和脱敏错误分类；它不实现 mint、handle、consume、IPC sealing 或私有 Project authority。
- `creator-authorization.ts`：公开语义子路径，只显式导出上述 schema、常量、类型与固定错误。
- `host-contract.ts`：Host structural port、原子 outcome、handle-private controller 与 first-sent interrupt lineage。
- `host.ts`：消费者出口；不暴露 producer 或通用 canonical helper。
- `host-adapter.ts`：受信 Host adapter 出口；R2 接线时必须用 import-boundary gate 限制生产导入方。
- `index.ts`：与 `host.ts` 等价的显式根出口；不得使用通配导出。
- `__tests__/`：R1 Host 合约、CreatorAuthorization 授权卡语义、R2C Broker 规范传输格式、V1/V2/V3
  智能体规范往返、Creator bootstrap handoff、Package Draft revision，以及独立智能体包的规范字节、内容
  摘要、严格路径与篡改回归。

该目录不得导入应用、数据库、Broker、文件系统或部署代码。source ledger 是已扫描事实的 compact 合同，
不另存 full inventory 或 Project 文件附件，也不证明模型理解了每个字节；Draft 自由文本仍可能含 Project
摘录。Draft 只能通过新 revision 修订，每个 DraftSnapshot 本身不可变且不可执行；只有完整性校验通过的
AgentVersion 才能进入 Runtime。V1/V2 Runtime 物化 commit-pinned tracked Git tree；V3 Runtime 使用空的
临时 Project，只运行冻结行为。
