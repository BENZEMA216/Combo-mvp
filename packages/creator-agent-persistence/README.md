# Creator Agent Persistence

本包实现 Creator-hosted Agent VNext 的云端持久化边界。`message-crypto.ts` 使用消息级 AES-256-GCM，并把 Creator、Conversation、Message、role 和 schema version 写入 canonical AAD；正文关联摘要使用 tenant key 的 domain-separated HMAC。`cloud-journal.ts` 在一个 PostgreSQL 事务中提交用户消息、Invocation、Event、Broker Outbox 和 Conversation projection；成功终态事务原子提交助手密文、终态 Event、Conversation IDLE、独立 Consumer Event Outbox 和 durable cursor。

Consumer Event publisher 使用 `FOR UPDATE SKIP LOCKED` 有界领取，按 cursor/digest 幂等确认发布；重连直接按 `Last-Event-ID` 从 PostgreSQL 顺序回放。七天 retention 删除与 `expiredThroughCursor` 在一个 Reconciler transaction 中推进，非零过期 cursor fail closed 为 `SSE_CURSOR_EXPIRED`。Redis/SSE 只是 commit 后的 at-least-once 投影，不保存权威 final，也不持久化 token delta。

本包不持有 KMS 主密钥，不记录 Prompt 或答案，不把 Redis/WebSocket 当事实源。调用方负责在进入仓储前完成身份认证、Execution Capability 验签和密钥获取；仓储仍通过 transaction-local RLS identity、复合外键、Lease/Fence 精确绑定和数据库唯一约束再次校验。Consumer accept、Broker terminal/publisher 与 Reconciler retention 使用独立最小权限 PostgreSQL role/pool，不共用一个全能连接。
所有 deadline 判定以 PostgreSQL `now()` 为权威时间，不依赖 API 主机时钟。
