# Agent Gateway

本目录实现 Creator-hosted Agent VNext 的 Worker WebSocket Gateway。Gateway 只处理连接、握手授权、每连接严格顺序、重复帧重放、会话替换和有界传输；它不保存 Prompt、回答或权威终态，也不在内存中假装替代 PostgreSQL、Worker SQLite 或 Broker Outbox。

`src/gateway.ts` 提供真实 WebSocket 服务和持久化端口。握手签名、Challenge 一次性消费、Worker allowlist、Outbox 领取以及 Event/ACK 的 PostgreSQL transaction 由端口实现，Gateway 在端口确认前不会激活连接。所有 authority 调用和发送操作都有硬超时；`authenticate` / `openSession` 实现必须把 `AbortSignal` 传到底层事务，并保证 abort 后不提交 Session、Lease 或 Outbox claim。同一实例是单次 start/stop 生命周期，滚动升级由进程编排创建新实例。公网 WSS 由 Test Ingress 终止 TLS；本包的本地测试使用真实回环 WebSocket socket，但不冒充 Test WSS、Redis 或 PostgreSQL E3 证据。

运行 `pnpm -F @cb/agent-gateway test` 执行传输契约测试。测试覆盖错误路由和 Origin、握手时限、一次性 Challenge、全局 Session ID 唯一性、严格 sequence、exact replay、gap、会话替换、过期/畸形/超限帧、authority 超时、端口失败以及有界关闭。

当前证据层仅为 `E3 Contract/Fake System` 的一侧：真实 socket + fake durable authority。它尚未证明公网 TLS、真实 PostgreSQL/Redis/Outbox、NAT 重连、两副本 rollout 或故障恢复。
