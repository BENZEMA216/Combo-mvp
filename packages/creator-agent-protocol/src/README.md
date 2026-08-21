# Source responsibilities

- `primitives.ts`：Host 合约内部使用的最小、名义隔离值域。
- `canonical.ts`：内部 consistency fingerprint；拒绝循环、getter、稀疏数组、非有限数字和 malformed Unicode。
- `broker-transport.ts`：显式子路径的 canonical Worker/Broker wire frame、方向规则、语义 fingerprint 与完整 wire fingerprint。
- `host-contract.ts`：Host structural port、原子 outcome、handle-private controller 与 first-sent interrupt lineage。
- `host.ts`：消费者出口；不暴露 producer 或通用 canonical helper。
- `host-adapter.ts`：受信 Host adapter 出口；R2 接线时必须用 import-boundary gate 限制生产导入方。
- `index.ts`：与 `host.ts` 等价的显式根出口；不得使用通配导出。
- `__tests__/`：R1 Host 合约以及 R2C Broker canonical wire、方向和 fingerprint 回归。

该目录不得导入应用、数据库、Broker、文件系统或部署代码。
