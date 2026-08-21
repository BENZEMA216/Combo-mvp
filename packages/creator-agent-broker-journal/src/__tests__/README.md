# Tests

Host 测试使用 R1 的真实 handle-private adapter controller 生成 outcome 与 interrupt receipt；
只 fake Host 行为，不 fake outcome authority。

`sqlite-store.test.ts` 在 Node 24 的真实 `node:sqlite` 上证明 fresh v1 catalog、0600/独占连接、
owner/cursor fencing、exact replay、事务 failpoint 回滚、COMMIT 歧义恢复、post-COMMIT Host gate、
sealed success 原子性、outbox 因果顺序和损坏/跨行篡改拒绝。它不证明 WebSocket/Cloud ACK、真实
Codex Host、跨机器 rollback protection 或产品组合根。
