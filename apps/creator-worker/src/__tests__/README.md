# 测试职责

- `worker-serial-pump.test.ts` 覆盖 prepare、start、sealed success、fact handoff、取消竞态、并发 tick、
  command/fact 跨库 exact replay、owner 续租、driver deferred/blocked、非法 command fail-closed、
  transport-incompatible sealed envelope 的 commit 前拒绝、明文不落盘、忽略 AbortSignal 的 resolver
  与保守停止。
- `worker-runtime.test.ts` 覆盖 R2E 双库创建与 reopen、真实 loopback WebSocket lease/command/Cloud ACK、
  READY 门槛、Host 不重放、stop-time UNCERTAIN 的下一次启动 handoff、无 lease 时有界停止、启动期与
  运行期永久 command 失败的 BLOCKED 首因、Host late-start 补偿，以及 journal/transport sidecar 路径
  冲突的零副作用拒绝。

测试使用真实 Node 24 `node:sqlite` 文件和真实 R1 adapter controller；R2E 测试还使用真实 `ws` client /
server，但 Broker 只监听 `127.0.0.1`。这些证据不会证明公网身份、Cloud durability 或生产部署。
