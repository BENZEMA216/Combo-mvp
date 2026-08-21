# @cb/creator-agent-broker-journal

这个包的根出口是 R2 的 I/O-free Worker Invocation reducer；受信 `host-executor` 子路径只
负责把 reducer 签发的一次 after-commit effect 与一次 R1 abstract Host port 调用绑定。它们把
完整 thread/generation/turn 与终态 fingerprint 投影成低敏事实，并给后续 SQLite Journal
返回可原子提交的状态变更计划。

## R2A 保证

- 执行相位只有 `PREPARED`、`DISPATCHING`、`RUNNING` 与 `TERMINAL_READY`；Host 调用只能来自已提交的 durable intent。
- `DISPATCHING` 期间进程或 Host 证据丢失只能进入 `UNCERTAIN`，不能退回 `PREPARED` 后猜测重派。
- 每次 start/interrupt 外部动作都有 reducer 签发的 process-local effect、durable attempt ID 与 interrupt ordinal；Host 调用与 disposition 投影在同一 executor wrapper 内完成，晚到或重复回包不能改绑另一轮尝试。
- cancel intent 本身不等于 `CANCELLED`。只有 PREPARED 的零 dispatch 事实、R1 明确证明 start 未发生，或同一 handle 的 USER_CANCEL terminal 才能取消。
- USER_CANCEL 只接受 R1 `CANCELLED` lineage；TIMEOUT 只接受 `FAILED/TURN_TIMEOUT` lineage。真实 SUCCEEDED 或 TURN_FAILED 可以在 interrupt 后赢得竞态。
- 若 interrupted terminal 比同一次 interrupt disposition 更早入队，reducer 先持久暂存低敏 terminal；只有 exact SENT request 到达并逐字段匹配后才终结，重启则保守进入 `UNCERTAIN`。
- R1 outcome/disposition 只能通过同一个 handle 投影；JSON clone、普通结构体、foreign handle 与 generation/turn 漂移都会失败。
- SUCCEEDED 在 seal authority 返回 process-local receipt 前没有 reducer authority；authority 先复制并深冻结 plain-data envelope，terminal plan 原子携带 sealed result receipt，不保留回答正文或 caller-owned 引用。
- 所有 `UNCERTAIN` 终态保留 start attempt、binding 与完整 interrupt audit snapshot，不把 USER_CANCEL/TIMEOUT 或 request ID 抹平。
- execution terminal 与未来 fact delivery/Cloud ACK 正交；本状态机不存在 `CLOUD_COMMITTED`。

## 输出计划

`reduceWorkerInvocation()` 同时返回：

- `next`：下一份不可变执行快照；
- `durable`：后续 SQLite transaction 必须与快照一起写入的 started/terminal fact 计划；
- `afterCommit`：只有 transaction commit 后才能执行的 Host start、outcome observer 或 interrupt 动作。

pure reducer 不执行这些动作，也不处理 command replay；`host-executor` 只为后续 pump 把一次
effect 与一次 abstract Host port 调用封装在同一 attempt scope。R2B 必须用 command ID 与 semantic
fingerprint 在同一 SQLite transaction 内仲裁 exact replay/conflict；SUCCEEDED transaction
还必须通过同一 seal authority 读取 opaque envelope，与 snapshot、receipt 和 outbox 一起提交。

## 明确不包含

本包没有 SQLite、文件系统、WebSocket、Broker envelope、Cloud reducer、HTTP error map、
加密、Prompt/回答持久化、fact delivery ACK 或产品进程。R2B 才加入 fresh SQLite v1 与
durable outbox；R2C/R2D/R2E 再依次加入 transport、Host executor/pump 与唯一组合根。

根出口只暴露 pure reducer 与 attempt 值域。受信 effect executor、Host projection 和 result
seal authority 只从 `@cb/creator-agent-broker-journal/host-executor` 导入；普通 journal consumer
不能从根出口铸造 Host disposition 或 terminal capability。

## 验证

```bash
pnpm -F @cb/creator-agent-broker-journal build
pnpm -F @cb/creator-agent-broker-journal typecheck:test
pnpm -F @cb/creator-agent-broker-journal test
```
