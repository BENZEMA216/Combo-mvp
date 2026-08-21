# @cb/creator-worker

本应用包实现 R2D 的显式串行 pump。调用方主动执行 `tick()`；包内没有隐藏轮询、进程入口或部署
接线。pump 把 Broker command 先提交到 Invocation Journal，再把 command 标为已应用，最后才启动
journal 签发的 Host after-commit effect。Host 回包只重新进入同一 mutation 队列，不会在队列中等待
turn outcome，因此运行中的取消命令不会被长任务阻塞。

`invocation.start` 只持久化 `inputRef` 与 `inputFingerprint` 所在的 Broker command。resolver 返回的
fingerprint 必须逐字匹配，真实输入还要通过 R1 `HostStartTurnInputSchema`；prompt 只存在于一次
`Host.startTurn()` 调用的局部变量。resolver 同时收到 pump 生命周期 `AbortSignal`，并受默认 10 秒的
内部有界 timeout 约束；即使 resolver 忽略 signal，`stop()` 也不会无限等待。STARTED/TERMINAL fact
以 `factId + payloadFingerprint` 幂等写入独立 transport SQLite，成功 terminal 同时携带 sealed
envelope。sealer envelope 会在 terminal journal commit 前通过 R2C payload schema；不兼容输出会让
pump fail-closed，并把 Invocation 留在 RUNNING，不会产生无法 handoff 的 terminal poison。此失败不在
同一 pump 内重试 Host 或 seal；组合根应停止并按保守 recovery 处理。只有 transport enqueue 已提交
后，journal 才标记 handoff 完成。

本包不拥有 Host、WebSocket driver 或两个 SQLite store 的启动、停止与关闭。组合根必须先获取两个
owner，把 R2B acquire 返回的 PREPARED cursors 传入，并持续调用 `tick()`；每个 tick 会续租 R2B
journal owner。R2C transport owner 只由 WebSocket driver 续租，pump 不会形成第二个续租权威。pump
每 tick 都请求 driver flush，并把 `BLOCKED` 状态视为永久失败；组合根仍须独立监控 driver 生命周期。
`stop()` 只把非 PREPARED 内存上下文按“无 handle 的进程恢复”保守收敛，不会调用 `Host.stop()`、
driver stop 或 store close，也不会伪造 Host session 丢失。本切片仍是 Test-only，不包含 OAuth、
Secure Enclave、正式 Broker challenge、Gateway、Cloud PostgreSQL 或部署。
