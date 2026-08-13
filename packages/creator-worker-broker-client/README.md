# Creator Worker Broker Client

这个包实现 Creator Worker 主动连接 Combo Broker 的真实 WebSocket transport。生产地址只接受 `wss://`，路径必须精确为 `/v1/worker/connect`；只有显式测试开关允许连接回环 `ws://` Fake Broker。客户端不开放入站端口，也不接收 Cookie、Bearer Token 或 URL query 凭据。

## 文件职责

- `src/worker-broker-client.ts` 管理单 installation 连接所有权、canonical handshake、outbound WebSocket、Lease 驱动的 Heartbeat、严格 sequence、断线重连、有界 backoff、frame/queue/stop 上限和脱敏诊断事件。
- `src/index.ts` 导出客户端、DeviceSigner、Challenge 与 durable transport 端口。
- `src/worker-broker-client.integration.test.ts` 通过真实回环 WebSocket socket 和 Fake Broker 验证 `Real Worker transport ↔ Fake Broker` 契约。

## 必需端口

- `BrokerChallengePort` 只返回一次性 Challenge ID；OAuth 和短期 Worker Session 交换不在 transport 中实现。
- `DeviceSignerPort` 只签 `brokerHandshakeSigningBytes` 产生的 RFC 8785 canonical bytes。生产适配器必须使用已注册的 Secure Enclave P-256 key；本包没有软件 key、Keychain key 或自动降级实现。
- `WorkerBrokerDurableTransportPort` 必须由生产 SQLite Journal/Outbox 适配器实现。它原子提交 inbound cursor 与 command/ACK 效果，并在返回 outbound frame 前持久化 sequence。`releaseConnection` 必须幂等处理“activate 已提交但响应丢失”，并把 written-but-unacknowledged outbox 恢复为下一连接可重组/重投的 durable 状态。每个端口方法必须把 `AbortSignal` 传到底层事务，并保证 abort 胜出后不提交。客户端每一帧都重新读取 durable cursor；重连时不会用内存 Map 伪造恢复事实。

端口返回的 Prompt、delta 和 final 只能是 `@cb/creator-agent-protocol` 已校验的 AEAD envelope。客户端没有正文 logger；诊断只输出固定事件名，不输出 frame、URL、ID、路径、Token、Prompt 或回答。

## Lease 与恢复边界

Heartbeat 只在 Cloud `lease.grant` 授予的窗口内运行。窗口长度由 Cloud `sentAt` 与 `leaseExpiresAt` 的差值确定，再锚定本机 monotonic timer；发送 Heartbeat、收到普通 ACK 或本机 wall clock 变化都不能延长权限。只有新的合法 `lease.grant` 可以续期。stale connection、stale fence、revoke 和 sequence conflict 会 fail closed。

断线后，客户端重新取得 Challenge 并建立新连接；未 ACK frame 是否重投、使用哪个 connection sequence、command 是否已经持久化，都只由 durable port 回答。网络写成功只记 `written`，不冒充 `PERSISTED` 或 `CLOUD_COMMITTED`。

## 验证边界

```bash
pnpm -F @cb/creator-worker-broker-client typecheck:test
pnpm -F @cb/creator-worker-broker-client test
```

这些测试属于 `E3 Contract/Fake System`：WebSocket 客户端与回环 socket 是真实实现，Broker、Challenge、DeviceSigner 和 durable port 都是测试替身。它们不证明 Secure Enclave、真实 OAuth、真实 SQLite WAL/FULL fsync、PostgreSQL、公网 TLS、NAT、Test Cloud 或 Gate 3/4。
