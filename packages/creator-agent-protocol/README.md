# @cb/creator-agent-protocol

这个包是 Creator-hosted Agent 重建链路的严格协议合约。根出口保持 R1 最小 Host
边界；显式 `broker-transport` 子路径提供 R2C Worker 与 Broker 之间的 canonical wire frame，
不承载数据库、WebSocket、密钥、进程管理或产品路由。

## R1 保证

- `HostThread` 必须携带 runtime ID、进程 generation，并确认 workspace roots 已被接受；generation 漂移就是另一条线程。
- `CreatorHost.startTurn()` 只有拿到完整 thread/generation/turn binding 后才返回 handle。消费者必须用 `verifyHostTurnHandle()` 验证 controller authority；start 拒绝也必须用 adapter factory 签发并经 `verifyHostTurnStartRejection()` 验证，裸 `new Error` 或结构体不是证据。
- `HostTurnHandle.outcome` 是唯一终态。成功结果与 SUCCEEDED 终态原子返回；FAILED/CANCELLED 不携带结果。该 handle 自己的 `verifyOutcome()` 会返回冻结 clone，terminal 不能脱离 result 单独验证。
- 每个 handle 只有一个私有 adapter controller，同时锁住一个终态和一条中断 lineage。`interrupt()` 只返回命令 disposition，不返回第二份终态。
- `SENT` 只能由同步 Host 写入线性化回调产生。第一个成功写出的 reason/request ID 被 latch，后续调用返回同一回执；确定 `NOT_SENT` 后才允许新尝试。终态先赢则返回 `TERMINAL_ALREADY_OBSERVED` 且不得写 Host。
- CANCELLED/TURN_TIMEOUT 必须绑定该 handle 唯一的同 thread、generation、turn、reason 和 request ID 回执。已发送中断不阻止稍后真实 SUCCEEDED/FAILED 终态胜出。
- thread ID、turn ID、message ID、request ID 与 generation 都是运行时校验且名义隔离的类型。

Host 结果与完整终态事实会生成 deterministic SHA-256 fingerprint。fingerprint
只用于一致性和变更检测，不认证 Host 来源。outcome 与回执由具体 handle 实例签发并且
不能跨 handle 验证；JSON 序列化后会被拒绝。这仍然信任创建该 handle 的 Host adapter，
不是安全沙箱。R2 必须锁定生产 composition/import boundary；若跨越 Worker/Broker 信任
边界，还要加入 MAC 或签名，不能把本 fingerprint 当作证明。

## 出口与信任边界

- `@cb/creator-agent-protocol` 与 `/host`：给组合根和消费者使用，只暴露严格输入、Host port、结果类型与 verify API。
- `@cb/creator-agent-protocol/host-adapter`：只给受信 Host adapter 使用，创建每个 turn 私有的 controller、start rejection，并接收同步 Host 写入线性化 callback。
- `@cb/creator-agent-protocol/broker-transport`：只暴露严格 canonical frame、四类 body、方向、fingerprint 与 transport-value canonicalizer；它不建立网络连接，也不签发 owner、Lease 或 Cloud authority。
- canonical JSON、通用 hash 和底层 primitives 仍是包内实现，不是公共产品 API。

本包明确不包含 Invocation reducer、错误/重试 HTTP 映射、Cloud/Worker journal、
WebSocket driver、Execution Capability、Snapshot、OpenAPI、生成 Schema 或大规模 corpus。

## 验证

```bash
pnpm -F @cb/creator-agent-protocol build
pnpm -F @cb/creator-agent-protocol typecheck:test
pnpm -F @cb/creator-agent-protocol test
```
