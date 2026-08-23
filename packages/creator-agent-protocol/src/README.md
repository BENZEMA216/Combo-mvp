# 源码职责

- `primitives.ts`：Host 合约内部使用的最小、名义隔离值域。
- `canonical.ts`：内部 consistency fingerprint；拒绝循环、getter、稀疏数组、非有限数字和 malformed Unicode。
- `broker-transport.ts`：显式子路径的 canonical Worker/Broker wire frame、方向规则、语义 fingerprint 与完整 wire fingerprint。
- `agent.ts`：显式 `./agent` 子路径的 V1/V2 Agent Definition、按 revision 修订的不可变 DraftSnapshot、
  strict handoff 与不可变 AgentVersion；V1 保留 current-task handoff 兼容，V2 用 compact source ledger
  绑定 Project root digest、coverage counts、source citation digest 与执行可用性。该文件还定义固定 Git
  Project 快照、只读本机执行 profile、按 protocol 分派的 canonical serializer/parser 和
  domain-separated fingerprint。
- `host-contract.ts`：Host structural port、原子 outcome、handle-private controller 与 first-sent interrupt lineage。
- `host.ts`：消费者出口；不暴露 producer 或通用 canonical helper。
- `host-adapter.ts`：受信 Host adapter 出口；R2 接线时必须用 import-boundary gate 限制生产导入方。
- `index.ts`：与 `host.ts` 等价的显式根出口；不得使用通配导出。
- `__tests__/`：R1 Host 合约、R2C Broker canonical wire，以及 V1/V2 Agent canonical round-trip、兼容与
  fingerprint tamper 回归。

该目录不得导入应用、数据库、Broker、文件系统或部署代码。source ledger 是已扫描事实的 compact 合同，
不另存 full inventory 或 Project 文件附件，也不证明模型理解了每个字节；Draft 自由文本仍可能含 Project
摘录。Draft 只能通过新 revision 修订，每个 DraftSnapshot 本身不可变且不可执行；只有完整性校验通过的
AgentVersion 才能进入 Runtime，Runtime 仍只物化 commit-pinned tracked Git tree。
