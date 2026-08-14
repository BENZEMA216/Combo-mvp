# Creator Worker Broker Client

这个包实现 Creator Worker 主动连接 Combo Broker 的真实 WebSocket transport。生产地址只接受 `wss://`，路径必须精确为 `/v1/worker/connect`；只有显式测试开关允许连接回环 `ws://` Fake Broker。客户端不开放入站端口，也不接收 Cookie、Bearer Token 或 URL query 凭据。

## 文件职责

- `src/worker-broker-client.ts` 管理单 installation 连接所有权、canonical handshake、outbound WebSocket、Lease 驱动的 Heartbeat、严格 sequence、断线重连、有界 backoff、frame/queue/stop 上限和脱敏诊断事件。
- `src/sqlite-durable-transport.ts` 实现真实文件型 SQLite durable transport。每个 DB 只绑定一个 installation；它校验 `0700` 全路径父目录和 `0600` DB/WAL/SHM/commit-watermark（拒绝 symlink/hardlink），并持久化 installation owner/epoch、连接、Lease/Fence、双向 cursor、inbound command、ACK effect、sequence gap 和 outbound outbox。
- `src/sqlite-invocation-journal.ts` 在上述同一个 `journal-v1.sqlite`/WAL 中实现 schema v3 的 Worker Invocation 与 `conversation.ready` authority：READY Conversation、immutable ready fact/logical outbox、PREPARED/STARTING/RUNNING/FINAL_READY/CLOUD_COMMITTED/UNCERTAIN、append-only facts/outbox、一次性 Host dispatch permit、Worker-Keychain Prompt/result AEAD、当前 Session 上行转封装和 exact Cloud ACK receipt。
- `src/index.ts` 导出客户端、DeviceSigner、Challenge 与 durable transport 端口。
- `src/worker-broker-client.integration.test.ts` 通过真实回环 WebSocket socket 和 Fake Broker 验证 `Real Worker transport ↔ Fake Broker` 契约。
- `src/sqlite-durable-transport.test.ts` 使用真实 SQLite 文件、独立子进程和真实回环 `AgentGateway` 验证 WAL/FULL 回读、文件权限、owner CAS、事务/abort、SIGKILL 窗口、WAL 单独丢失、opaque command references、迁移重入、最大 backlog 重组、bounded retention、字节配额及 AEAD-only 落盘。
- `src/sqlite-invocation-journal.test.ts` 验证 100 路 prepare 幂等、同一 command 跨 connection 重封装、prepare/start/final exact replay、Host 一次性 dispatch、STARTING crash→UNCERTAIN、Prompt/result AEAD、ACK 丢失、七天 retention、pinned-reader sensitive checkpoint 与 raw DB/WAL/SHM canary 清除。
- `src/postgres-sqlite-vertical.pg.test.ts` 在显式测试开关下连接 disposable PostgreSQL，以真实 P-256 握手、真实 Gateway、真实 Worker 客户端和真实文件 SQLite 验证 Cloud-time Lease 续约、Gateway 重启重连、Fence 提升、Journal 重开、双向 message ID/digest 对账、WebSocket payload 原字节重复与 PostgreSQL COMMIT-response-loss 恢复。

## 必需端口

- `BrokerChallengePort` 返回一次性 Challenge ID，并在生产路径同时返回可信 `cloudTime`。客户端用 Challenge 往返时延形成保守的 Cloud-time upper-bound；只有显式不安全回环测试可以省略这个锚。OAuth 和短期 Worker Session 交换不在 transport 中实现。
- `DeviceSignerPort` 只签 `brokerHandshakeSigningBytes` 产生的 RFC 8785 canonical bytes。生产适配器必须使用已注册的 Secure Enclave P-256 key；本包没有软件 key、Keychain key 或自动降级实现。
- `WorkerBrokerDurableTransportPort` 由 `SqliteWorkerBrokerDurableTransport` 实现。它启动时逐项回读 WAL、`synchronous=FULL`、foreign keys、busy timeout、application id、schema version、page/WAL limits 与 quick/integrity/foreign-key check，并交叉验证 schema、authority、envelope、effect、delivery、row-set accumulator 和 DB 外 commit watermark。每个事务在持有 SQLite write lock 时先 fsync+原子替换 watermark，再 COMMIT；因此 DB commit 与文件更新之间崩溃会进入 fail-closed/UNCERTAIN，而不会静默把较旧 main DB 当作最新事实。它原子提交 inbound cursor 与 command/ACK effect，并在返回 outbound frame 前持久化 sequence。`replayPendingConversationReady` 是每次 Lease activation 后、客户端进入 READY 前必须成功的窄 reducer；它只读取本地 immutable ready outbox，以当前 Session/Lease/Fence 重封装，不接受调用方提供的 arbitrary body/source。ready 的 `CLOUD_COMMITTED` ACK 在 `commitInbound` 同一事务内写 receipt 与 `CLOUD_COMMITTED`，`SECURITY_BLOCK` 则单独写 `CLOUD_REJECTED`，不存在裸 source/digest ACK API。`lease.accepted` / `lease.renewed` 的 `correlationId` 固定为所确认的 exact inbound `lease.grant.messageId`，并与 durable `response_to_message_id` 交叉校验；deployment ID 不能冒充 grant 关联。同一 connection 的 exact command replay 只会把该 command 唯一绑定、已经 `WRITTEN` 但尚未 `CLOUD_COMMITTED` 的 response 原子恢复为 `PENDING`；message ID、canonical body、sequence、owner/fence 都不变，已经 Cloud commit 或 supersede 的 response 永不复活。`releaseConnection` 幂等处理“activate 已提交但响应丢失”；断线时只有 logical body 不变的 `message.ack` 能以同一 message ID 绑定到新 connection，旧 lease/heartbeat/control event 会被删除为不可重放事实，不会伪装成新 lease 的事件。客户端每一帧都重新读取 durable state；SQLite row 是 retention 期内的 replay authority，1,024-entry cursor 只是 bounded cache，不能否定更古老的 exact durable replay。

缺失 Journal 默认 `JOURNAL_MISSING` 并 fail closed；首次创建必须显式传入与 installation、journal generation 绑定的 `NewWorkerJournalAuthorization`。该 capability 必须来自 DB 外的可信 Cloud reconciliation/本机安全状态，本适配器只校验并持久绑定它，不签发、不猜测，也不会把丢失的历史 Journal 自动重建成空库。

客户端把每个 durable port 调用的 monotonic deadline 传给适配器；适配器还施加自己的 operation deadline，并在真实 SQLite busy wait 返回后、external watermark 的阻塞 fsync 返回后以及进入 COMMIT 临界区前重新检查。若 fsync 跨过 deadline，它先原子恢复并验证 prior watermark，再 rollback SQLite；恢复失败会 poison 当前 adapter 并 fail closed。同步 native SQLite COMMIT 一旦进入便不能被 JavaScript timer 中断，因此 deadline 的线性化边界明确是“开始 COMMIT 之前”。真实 WorkerClient 反例分别覆盖另一个进程持有 write lock，以及 watermark durable-write 跨过 caller deadline；两者的 `operationTimeout` 都明显大于 client `portTimeout`。

Protocol 链路中的 Prompt、delta 和 final 必须是 `@cb/creator-agent-protocol` 已校验的 AEAD envelope；transport 没有 plaintext Prompt/answer API。客户端没有正文 logger；诊断只输出固定事件名，不输出 frame、URL、ID、路径、Token、Prompt 或回答。`readPendingCommands` 只返回 `connectionId/sequence/messageId/type/canonicalDigest` 的 opaque reference，绝不返回 envelope、body、ciphertext 或 Execution Capability；因此 transport 本身不能被当作 Host dispatch authority。`SqliteWorkerInvocationJournal` 必须注入 Capability、可信 Cloud clock、Sandbox READY、Host receipt、Worker-Keychain AEAD 和 Cloud ACK authority，且只在同一 SQLite transaction 内 exact 回读 opaque reference 后推进状态。公开 Host 边界只有一次性 `dispatchOnce`；Prompt 明文只传入注入的 trusted Host port，不返回调用方。

Cloud durable `broker_outbox.command_id` 必须直接成为 Invocation command 的稳定 `messageId`。重连重投可以更换 `connectionId`、`sequence`、外层 Lease/Fence，并按新 `workerSessionId` 重加密敏感 body；稳定 command ID、canonical business semantics、Invocation/Capability binding 不得改变。Journal 的 prepared/started fact 分别固定引用 prepare/start command message ID；fact delivery 自己的 message ID 可以变化，不能冒充 source event。相同 command ID 的不同 business semantics 会 security-block。

Broker Session Prompt 在 prepare transaction 内先认证并按 `combo:vnext:request:v1` 的 Keychain HMAC 重算 `requestDigest`，再转封装到 `local_invocations.prompt_ciphertext`；本地 Prompt 与 result 均使用 `aes-256-gcm/v1`、`worker-keychain`，AAD 精确绑定 `agentVersionDigest/conversationId/installationId/invocationId/role/schemaVersion`。result 的 `resultDigest` 使用独立 `combo:vnext:result:v1` HMAC 域，不能复用 request/content digest。Host receipt/UNCERTAIN 后 Prompt 立即删除；Cloud exact ACK 后 Broker Session result wire 立即删除。本地 result 保留到 CLOUD_COMMITTED 后七天。所有这些删除在 COMMIT 后强制 `wal_checkpoint(TRUNCATE)`；若 pinned reader 阻止物理清除，live adapter poison/fail closed，后续 reopen 必须先成功 truncate 才能服务。

一次性 Host 边界没有异步授权缝隙：SQLite COMMIT、Prompt AEAD open、external watermark fsync 与敏感 checkpoint 完成后，Journal 在同一 JavaScript turn 内重新读取可信 Cloud time，并用持久化的 Capability 原文、binding、digest、撤销源、Capability 有效期和 Invocation deadline 同步复验，随后直接调用 trusted Host port，中间没有 `await`。这次复验失败时 Host 调用数保持 0，Prompt 在独立清理 transaction 中物理清除并落 `invocation.failed`；只有真正进入 Host port 后的异常才收敛为 `START_DISPATCH_UNKNOWN/UNCERTAIN`。

Journal 还保留真正的 terminal/reconciliation storage reserve，而不是按 operation name 绕过容量检查：`local_recovery_reserve_pages` fill/delete 后留下受保护 SQLite freelist 页；私有 `0600`、单 hardlink、实占块 `.recovery-reserve` 为 WAL 与 watermark 原子改写预留文件系统空间。普通 admission 必须在 COMMIT 前仍保有页池、WAL headroom 和 sidecar，压力下完整回滚；`readOutbound`、pending-fact/ACK polling、event enqueue、普通 inbound ACK/replay 都不能冒充 recovery。只有已经接纳的 Prompt one-use handoff、Host receipt、terminal/UNCERTAIN、exact Cloud receipt projection 和有界清理才可在真实压力下释放 reserve；每次已提交 lifecycle transaction 都会尝试重新建立 freelist 与物理 sidecar，补充失败则在下一次普通 admission 前 fail closed。强制 TRUNCATE 会在 `busyTimeout` 内同步有界重试；瞬时 reader 释放后继续服务，长期 pinned reader 到期仍 poison/fail closed。

## Lease 与恢复边界

Heartbeat 只在 Cloud `lease.grant` 的剩余有效期内运行。客户端从 Challenge 的可信 Cloud time 和本机 monotonic timer 估算接收时刻；网络延迟不会把 `(leaseExpiresAt - sentAt)` 的完整时长重新授予本机，已过期的初始 grant 不会进入 READY。发送 Heartbeat、收到普通 ACK 或本机 wall clock 变化都不能延长权限，只有新的合法 `lease.grant` 可以续期。stale connection、stale fence、revoke 和 sequence conflict 会 fail closed。生产配置的 Heartbeat 周期下限为 10 秒；更短周期只允许显式不安全回环测试。

断线后，客户端在每次网络尝试前续取 installation ownership，并在 Challenge/签名完成后、创建 Broker socket 前再次 CAS；长时间 Challenge 后若另一进程已接管，loser 会在接触 Broker 之前 BLOCKED。随后才建立新连接；未 ACK frame 是否重投、使用哪个 connection sequence、command 是否已经持久化，都只由 durable port 回答。网络写成功只记 `written`，不冒充 `PERSISTED` 或 `CLOUD_COMMITTED`。

生产 SQLite owner lease 最短 60 秒，而生产 reconnect backoff、heartbeat 和单次 socket handshake 上限均不超过 30 秒；短 owner lease 与更快 reconnect 只允许显式测试开关。断网期间每次重试仍会续租，所以默认 60 秒离线不会让健康的唯一 Worker 因 backoff 自行失权；若 competitor 已在到期窗口完成 CAS，旧 Worker 的下一次 pre-network CAS 会失败。

新的 owner epoch 不会由 transport 裸读旧 epoch 的 `PERSISTED` business command；同一 owner replacement 也不会把旧 connection 的 command 自动变成可发送给 Host 的对象。Invocation Journal 只有在当前 transport authority、当前 transport Deployment 与已持久化 Invocation/Capability Deployment 完全相同、原始 Capability、版本/Snapshot 和 READY Sandbox 全部验证后才推进 `PREPARED → STARTING`；同 Installation 的跨 Deployment start 会在 Host 调用前终态失败。永久 deadline/capability expiry/revoke 会原子落 `invocation.failed`、outbox、Prompt purge 并释放 active WIP，只有 stale current transport 保持 `PREPARED` 等待合法重连。STARTING permit 一经持久化或 Host Prompt 一经 CAS 释放，重启/超时不会二次 dispatch；无可信 receipt 时只收敛到 UNCERTAIN。这个本地 reducer 仍需 Creator Worker 启动序列和 Cloud reconciliation 纵向接线，不能单独当成完整 Host/Cloud Gate。

Journal 默认把活跃 inbound/outbox admission 分别限制为 512 行；outbox 还保留一个新 connection control slot，所以最大 511 条 durable `message.ack` 能在重启后全部 reframe。1,024 条 cursor digest 不是 durable replay 上限：古老 PERSISTED inbound/PENDING outbox row 即使已离开 cursor window，仍可 exact replay；同 sequence 不同 canonical body 永久 security-block。7 天 archive 的逻辑上限分别为 1,000,000 行，但已 `APPLIED`/`ACKED` 的历史行不挤占活跃 admission。connection 上限 1,024 计算 ACTIVE+RELEASED 全部行；正常无业务 reconnect 会立即清掉 connection-scoped control/activation 行，含 retained PERSISTED fact 的 connection 不会被偷偷逐出，达到总上限时新 grant 在事务内完整回滚。retention 每次只删每类最多 128 行并持续取得进展，不在一次 admission 事务里全量清百万行。

默认物理配额是 main DB 256 MiB、WAL admission threshold 64 MiB、文件系统可用空间保留 64 MiB。适配器绑定并回读 `max_page_count`、`journal_size_limit`、`wal_autocheckpoint=256`。COMMIT 是调用线性化点：若长 reader pin 住 checkpoint，跨过 WAL threshold 的那一笔已提交调用返回成功并进入保护状态；下一笔在 `BEGIN` 前执行 PASSIVE/TRUNCATE，仍无法收缩才返回可重试 `CAPACITY_EXCEEDED`，所以不会出现“已经提交却向 caller 报本笔失败”的歧义，也不会部分推进下一笔 cursor/command。reader 释放后会 truncate 并恢复 admission。Node SQLite PRAGMA 不能证明 live WAL 物理硬上限，pin 期间 WAL 可以瞬时超过 threshold；这些配额是单 journal 本机 admission 保护，不是任意业务吞吐、长读事务、VFS quota 或整机磁盘 SLA。

## 验证边界

```bash
pnpm -F @cb/creator-worker-broker-client typecheck:test
pnpm -F @cb/creator-worker-broker-client test
CREATOR_AGENT_VERTICAL_PG_SQLITE_TEST=1 \
  pnpm -F @cb/creator-worker-broker-client test:pg-vertical
```

标准 `test` 入口会先按依赖顺序构建 Protocol、Broker Journal 与 Gateway，避免 fresh
worktree 或刚集成提交时读取旧 `dist` 产生假绿/假红。

`worker-broker-client.integration.test.ts` 属于 `E3 Contract/Fake System`：WebSocket 客户端与回环 socket 是真实实现，Broker、Challenge、DeviceSigner 和 durable port 是测试替身。

`sqlite-durable-transport.test.ts` 与 `sqlite-invocation-journal.test.ts` 提供本机 `E2 SQLite` 证据，并覆盖真实 Worker client ↔ 真实回环 Gateway 的纵向切片；Challenge、DeviceSigner、Capability/Keychain/Host/Cloud ACK authority 和 Gateway authority 仍是测试端口。它们能证明真实文件上的 PRAGMA/事务/CAS、两进程竞争、1,050 次 clean reconnect、retained connection 总上限、512-row 最大 backlog、1,024+ 古老 durable replay、opaque command reference、owner/revoke isolation、v1→v2→v3 前置完整性验证、READY backfill 与真实 SIGKILL、同 connection 丢失 response 后 exact replay、Invocation 本地状态机、WAL 单独移除、pinned-reader sensitive purge、row deletion/state/AEAD tamper fail-closed、bounded prune、DB/WAL admission 配额和 raw DB/WAL/SHM 敏感 canary 清除。`synchronous=FULL` 与 checkpoint 回读仍不等于真实断电/磁盘固件测试；同盘 watermark 也不等于 Cloud reconciliation 或异机备份恢复。这一切只算 SQLite tranche，不证明 Secure Enclave、真实 OAuth、真实 Cloud Execution Capability/KMS/Host、加密备份恢复、PostgreSQL/Redis/MinIO Cloud Journal、公网 TLS、NAT、真实 Linux/Mac VM、Test Cloud、24h soak 或 Gate 3/4。

`postgres-sqlite-vertical.pg.test.ts` 提供本机 `E2 PostgreSQL + E2 SQLite + E3 loopback` 混合纵向证据。它使用真实 PostgreSQL authority 和数据库时钟、真实 P-256 签名、真实 WebSocket Gateway、真实 Worker 客户端与真实文件 SQLite，验证 Lease 续约越过初始 TTL、Gateway listener 重启后的新 Session/Fence、同一 Journal 重开，以及 Cloud/Local 双向 receipt 的 exact message ID/canonical digest。测试 relay 只重复完全相同的 WebSocket message payload bytes，不宣称 TCP 分片或 masking key 相同；定向 Pool fault 在目标 `ACCEPT_ENVELOPE` 已真实 COMMIT 后丢失响应，并验证 operation/frame receipt 各一、SQLite 最终 `CLOUD_COMMITTED` 且 transport 不重连。Challenge 仍通过进程内端口调用而不是 OAuth HTTP，P-256 私钥仍在测试进程内存中，连接仍是回环 `ws://`；该 Gate 不证明公网 TLS/NAT、Secure Enclave、Cloud Outbox publisher、完整 Invocation Journal/Host dispatch、真实 Creator Worker 或 Gate 3/4。
