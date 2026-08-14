# Creator Worker Broker Client

这个包实现 Creator Worker 主动连接 Combo Broker 的真实 WebSocket transport。生产地址只接受 `wss://`，路径必须精确为 `/v1/worker/connect`；只有显式测试开关允许连接回环 `ws://` Fake Broker。客户端不开放入站端口，也不接收 Cookie、Bearer Token 或 URL query 凭据。

## 文件职责

- `src/worker-broker-client.ts` 管理单 installation 连接所有权、canonical handshake、outbound WebSocket、Lease 驱动的 Heartbeat、严格 sequence、断线重连、有界 backoff、frame/queue/stop 上限和脱敏诊断事件。
- `src/sqlite-durable-transport.ts` 实现真实文件型 SQLite durable transport。每个 DB 只绑定一个 installation；它校验 `0700` 全路径父目录和 `0600` DB/WAL/SHM/commit-watermark（拒绝 symlink/hardlink），并持久化 installation owner/epoch、连接、Lease/Fence、双向 cursor、inbound command、ACK effect、sequence gap 和 outbound outbox。
- `src/index.ts` 导出客户端、DeviceSigner、Challenge 与 durable transport 端口。
- `src/worker-broker-client.integration.test.ts` 通过真实回环 WebSocket socket 和 Fake Broker 验证 `Real Worker transport ↔ Fake Broker` 契约。
- `src/sqlite-durable-transport.test.ts` 使用真实 SQLite 文件、独立子进程和真实回环 `AgentGateway` 验证 WAL/FULL 回读、文件权限、owner CAS、事务/abort、SIGKILL 窗口、WAL 单独丢失、opaque command references、迁移重入、最大 backlog 重组、bounded retention、字节配额及 AEAD-only 落盘。

## 必需端口

- `BrokerChallengePort` 返回一次性 Challenge ID，并在生产路径同时返回可信 `cloudTime`。客户端用 Challenge 往返时延形成保守的 Cloud-time upper-bound；只有显式不安全回环测试可以省略这个锚。OAuth 和短期 Worker Session 交换不在 transport 中实现。
- `DeviceSignerPort` 只签 `brokerHandshakeSigningBytes` 产生的 RFC 8785 canonical bytes。生产适配器必须使用已注册的 Secure Enclave P-256 key；本包没有软件 key、Keychain key 或自动降级实现。
- `WorkerBrokerDurableTransportPort` 由 `SqliteWorkerBrokerDurableTransport` 实现。它启动时逐项回读 WAL、`synchronous=FULL`、foreign keys、busy timeout、application id、schema version、page/WAL limits 与 quick/integrity/foreign-key check，并交叉验证 schema、authority、envelope、effect、delivery、row-set accumulator 和 DB 外 commit watermark。每个事务在持有 SQLite write lock 时先 fsync+原子替换 watermark，再 COMMIT；因此 DB commit 与文件更新之间崩溃会进入 fail-closed/UNCERTAIN，而不会静默把较旧 main DB 当作最新事实。它原子提交 inbound cursor 与 command/ACK effect，并在返回 outbound frame 前持久化 sequence。同一 connection 的 exact command replay 只会把该 command 唯一绑定、已经 `WRITTEN` 但尚未 `CLOUD_COMMITTED` 的 response 原子恢复为 `PENDING`；message ID、canonical body、sequence、owner/fence 都不变，已经 Cloud commit 或 supersede 的 response 永不复活。`releaseConnection` 幂等处理“activate 已提交但响应丢失”；断线时只有 logical body 不变的 `message.ack` 能以同一 message ID 绑定到新 connection，旧 lease/heartbeat/control event 会被删除为不可重放事实，不会伪装成新 lease 的事件。客户端每一帧都重新读取 durable state；SQLite row 是 retention 期内的 replay authority，1,024-entry cursor 只是 bounded cache，不能否定更古老的 exact durable replay。

缺失 Journal 默认 `JOURNAL_MISSING` 并 fail closed；首次创建必须显式传入与 installation、journal generation 绑定的 `NewWorkerJournalAuthorization`。该 capability 必须来自 DB 外的可信 Cloud reconciliation/本机安全状态，本适配器只校验并持久绑定它，不签发、不猜测，也不会把丢失的历史 Journal 自动重建成空库。

客户端把每个 durable port 调用的 monotonic deadline 传给适配器；适配器还施加自己的 operation deadline，并在真实 SQLite busy wait 返回后、external watermark 的阻塞 fsync 返回后以及进入 COMMIT 临界区前重新检查。若 fsync 跨过 deadline，它先原子恢复并验证 prior watermark，再 rollback SQLite；恢复失败会 poison 当前 adapter 并 fail closed。同步 native SQLite COMMIT 一旦进入便不能被 JavaScript timer 中断，因此 deadline 的线性化边界明确是“开始 COMMIT 之前”。真实 WorkerClient 反例分别覆盖另一个进程持有 write lock，以及 watermark durable-write 跨过 caller deadline；两者的 `operationTimeout` 都明显大于 client `portTimeout`。

Protocol 链路中的 Prompt、delta 和 final 必须是 `@cb/creator-agent-protocol` 已校验的 AEAD envelope；本适配器没有 plaintext Prompt/answer API。客户端没有正文 logger；诊断只输出固定事件名，不输出 frame、URL、ID、路径、Token、Prompt 或回答。`readPendingCommands` 只返回 `connectionId/sequence/messageId/type/canonicalDigest` 的 opaque reference，绝不返回 envelope、body、ciphertext 或 Execution Capability；因此本 transport 不能被当作 Host dispatch authority。Execution Capability 的 Cloud 公钥/撤销源/可信 Cloud-time 校验、durable PREPARED Invocation、exact prepare/start binding、`STARTING` CAS、Codex turn receipt、delta/final durable enqueue 与终态 reconciliation 必须由后续 Invocation Journal + Host Adapter 的不可绕过端口共同实现。

## Lease 与恢复边界

Heartbeat 只在 Cloud `lease.grant` 的剩余有效期内运行。客户端从 Challenge 的可信 Cloud time 和本机 monotonic timer 估算接收时刻；网络延迟不会把 `(leaseExpiresAt - sentAt)` 的完整时长重新授予本机，已过期的初始 grant 不会进入 READY。发送 Heartbeat、收到普通 ACK 或本机 wall clock 变化都不能延长权限，只有新的合法 `lease.grant` 可以续期。stale connection、stale fence、revoke 和 sequence conflict 会 fail closed。生产配置的 Heartbeat 周期下限为 10 秒；更短周期只允许显式不安全回环测试。

断线后，客户端在每次网络尝试前续取 installation ownership，并在 Challenge/签名完成后、创建 Broker socket 前再次 CAS；长时间 Challenge 后若另一进程已接管，loser 会在接触 Broker 之前 BLOCKED。随后才建立新连接；未 ACK frame 是否重投、使用哪个 connection sequence、command 是否已经持久化，都只由 durable port 回答。网络写成功只记 `written`，不冒充 `PERSISTED` 或 `CLOUD_COMMITTED`。

生产 SQLite owner lease 最短 60 秒，而生产 reconnect backoff、heartbeat 和单次 socket handshake 上限均不超过 30 秒；短 owner lease 与更快 reconnect 只允许显式测试开关。断网期间每次重试仍会续租，所以默认 60 秒离线不会让健康的唯一 Worker 因 backoff 自行失权；若 competitor 已在到期窗口完成 CAS，旧 Worker 的下一次 pre-network CAS 会失败。

新的 owner epoch 不会读取旧 epoch 的 `PERSISTED` business command；同一 owner replacement 也不会把旧 connection 的 command 自动转给新 connection。transport 保留这些事实供后续 reconciliation，但不暴露可直接发送给 Host 的对象，也不声称已经实现 `PERSISTED → STARTING → Host` 的 at-most-once 边界。真实 SIGKILL 测试覆盖“SQLite 已 PERSISTED、上层尚未处理”窗口；它不等于完整 Host dispatch 证据。

Journal 默认把活跃 inbound/outbox admission 分别限制为 512 行；outbox 还保留一个新 connection control slot，所以最大 511 条 durable `message.ack` 能在重启后全部 reframe。1,024 条 cursor digest 不是 durable replay 上限：古老 PERSISTED inbound/PENDING outbox row 即使已离开 cursor window，仍可 exact replay；同 sequence 不同 canonical body 永久 security-block。7 天 archive 的逻辑上限分别为 1,000,000 行，但已 `APPLIED`/`ACKED` 的历史行不挤占活跃 admission。connection 上限 1,024 计算 ACTIVE+RELEASED 全部行；正常无业务 reconnect 会立即清掉 connection-scoped control/activation 行，含 retained PERSISTED fact 的 connection 不会被偷偷逐出，达到总上限时新 grant 在事务内完整回滚。retention 每次只删每类最多 128 行并持续取得进展，不在一次 admission 事务里全量清百万行。

默认物理配额是 main DB 256 MiB、WAL admission threshold 64 MiB、文件系统可用空间保留 64 MiB。适配器绑定并回读 `max_page_count`、`journal_size_limit`、`wal_autocheckpoint=256`。COMMIT 是调用线性化点：若长 reader pin 住 checkpoint，跨过 WAL threshold 的那一笔已提交调用返回成功并进入保护状态；下一笔在 `BEGIN` 前执行 PASSIVE/TRUNCATE，仍无法收缩才返回可重试 `CAPACITY_EXCEEDED`，所以不会出现“已经提交却向 caller 报本笔失败”的歧义，也不会部分推进下一笔 cursor/command。reader 释放后会 truncate 并恢复 admission。Node SQLite PRAGMA 不能证明 live WAL 物理硬上限，pin 期间 WAL 可以瞬时超过 threshold；这些配额是单 journal 本机 admission 保护，不是任意业务吞吐、长读事务、VFS quota 或整机磁盘 SLA。

## 验证边界

```bash
pnpm -F @cb/creator-worker-broker-client typecheck:test
pnpm -F @cb/creator-worker-broker-client test
```

标准 `test` 入口会先按依赖顺序构建 Protocol、Broker Journal 与 Gateway，避免 fresh
worktree 或刚集成提交时读取旧 `dist` 产生假绿/假红。

`worker-broker-client.integration.test.ts` 属于 `E3 Contract/Fake System`：WebSocket 客户端与回环 socket 是真实实现，Broker、Challenge、DeviceSigner 和 durable port 是测试替身。

`sqlite-durable-transport.test.ts` 提供本机 `E2 SQLite` 证据，并覆盖真实 Worker client ↔ 真实回环 Gateway 的纵向切片；Challenge、DeviceSigner 和 Gateway authority 仍是测试端口。它能证明真实文件上的 PRAGMA/事务/CAS、两进程竞争、1,050 次 clean reconnect、retained connection 总上限、512-row 最大 backlog、1,024+ 古老 durable replay、opaque command reference、owner/revoke isolation、重启、SIGKILL、同 connection 丢失 response 后 exact replay/重发/Cloud commit 终止、WAL 单独移除、pinned-reader WAL protection、row deletion 与 state tamper fail-closed、bounded prune、DB/WAL admission 配额和 AEAD-only bytes。`synchronous=FULL` 与 checkpoint 回读仍不等于真实断电/磁盘固件测试；同盘 watermark 也不等于 Cloud reconciliation 或异机备份恢复。它不证明 Secure Enclave、真实 OAuth、Cloud Execution Capability、完整 Invocation Journal/Host result reconciliation、加密备份恢复、PostgreSQL/Redis/MinIO Cloud Journal、公网 TLS、NAT、真实 Linux/Mac VM、Test Cloud、24h soak 或 Gate 3/4。
