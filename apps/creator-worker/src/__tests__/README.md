# 测试职责

- `worker-serial-pump.test.ts` 覆盖 prepare、start、sealed success、fact handoff、取消竞态、并发 tick、
  command/fact 跨库 exact replay、owner 续租、driver deferred/blocked、非法 command fail-closed、
  transport-incompatible sealed envelope 的 commit 前拒绝、明文不落盘、忽略 AbortSignal 的 resolver
  与保守停止。

测试使用真实 Node 24 `node:sqlite` 文件和真实 R1 adapter controller；Broker driver 只替换 flush 端口，
不会证明公网身份、Cloud durability 或生产部署。
