# @cb/creator-agent-broker-journal

这个包的根出口是 R2 的 I/O-free Worker Invocation reducer；受信 `host-executor` 子路径只
负责把 journal 在 transaction COMMIT 后签发的一次 effect capability 与一次 R1 abstract Host
port 调用绑定。它们把
完整 thread/generation/turn 与终态 fingerprint 投影成低敏事实，并给后续 SQLite Journal
返回可原子提交的状态变更计划。

## R2A 保证

- 执行相位只有 `PREPARED`、`DISPATCHING`、`RUNNING` 与 `TERMINAL_READY`；Host 调用只能来自已提交的 durable intent。
- `DISPATCHING` 期间进程或 Host 证据丢失只能进入 `UNCERTAIN`，不能退回 `PREPARED` 后猜测重派。
- 每次 start/interrupt 外部动作都有 reducer 签发的 process-local effect、durable attempt ID 与 interrupt ordinal；Host 调用与 disposition 投影在同一 executor wrapper 内完成，晚到或重复回包不能改绑另一轮尝试。
- reducer 返回的 `START_HOST`、`INTERRUPT_HOST` 与 `OBSERVE_HOST_OUTCOME` 都是 branded raw plan，不能直接调用 Host。journal 只有在持久化 transaction 成功后，才能用内部 `commitWorkerAfterCommitEffects()` 将它们绑定到 exact invocation/revision/owner epoch；同一 raw plan 与同一 context 幂等，任何跨 context 重绑都会失败。
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
- `afterCommit`：尚未获得 I/O 权限的 raw Host start、outcome observer 或 interrupt 计划。

pure reducer 不执行这些动作，也不处理 command replay。journal 在 transaction COMMIT 后调用内部
marker 签发 process-local committed wrapper，`host-executor` 只接受该 wrapper，并为后续 pump 把
一次 effect 与一次 abstract Host port 调用封装在同一 attempt scope；raw effect、JSON clone 或
结构相同的伪造 wrapper 都会被拒绝。

## R2B SQLite 子路径

`@cb/creator-agent-broker-journal/sqlite-store` 提供 fresh-only SQLite v1 store：单一独占连接、
owner epoch/cursor capability、command ID + semantic fingerprint 重放仲裁，以及 state/event/outbox/
sealed result 的同事务提交。重启只重建 PREPARED cursor；未观察到 COMMIT 的 active turn 保守收敛为
`UNCERTAIN`，终态操作可用 replay-only API 恢复 exact response，且不会重新签发 Host effect。

Host effect 只有在 SQLite COMMIT 后才获得可执行 wrapper；wrapper 还绑定当前 live owner，close、
poison 或 owner 失效后会在 Host callback 前拒绝。SUCCEEDED transaction 通过同一 seal authority 读取
immutable opaque envelope，并与 terminal snapshot、receipt 和 outbox 逐字段交叉绑定。outbox 使用持久
自增序列保持因果顺序，不依赖可能相同或回拨的墙钟。

## 明确不包含

本包没有 WebSocket、Broker envelope、Cloud reducer、HTTP error map、Prompt/回答明文持久化、
fact delivery ACK 或产品进程。SQLite 只从显式 `./sqlite-store` 子路径暴露；根出口仍是 I/O-free
reducer。R2C/R2D/R2E 再依次加入 transport、Host pump 与唯一组合根；本切片不迁移 donor 的
SQLite v1-v5 历史或 legacy recovery 文件。

根出口只暴露 pure reducer、raw plan 类型与 attempt 值域。受信 effect executor、committed wrapper
类型、Host projection 和 result seal authority 只从
`@cb/creator-agent-broker-journal/host-executor` 导入；该子路径不暴露 commit marker。普通 consumer
不能铸造 committed effect、Host disposition 或 terminal capability。

## 验证

```bash
pnpm -F @cb/creator-agent-broker-journal build
pnpm -F @cb/creator-agent-broker-journal typecheck:test
pnpm -F @cb/creator-agent-broker-journal test
```
