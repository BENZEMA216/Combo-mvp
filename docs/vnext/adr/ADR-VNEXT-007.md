<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-007: SSE cursor retention and transcript recovery

- Status: accepted
- Owner: Product/Web
- Decision date: 2026-08-13

## Decision

terminal PG transaction 必须原子写 ASSISTANT message、Invocation terminal/resultDigest、append-only invocation event、Conversation IDLE/SUSPENDED 和恰好一条独立 consumer_event_outbox；broker_outbox、Redis、进程内 event 均不能代替。outbox 冻结字段为 cursor bigint identity PK、owner/conversation/invocation/source_event、event_type、strict allowlist payload、payload_digest、dedupe_key、PENDING|PUBLISHED、attempt/retry/publish/retain timestamps，UNIQUE(owner_id,source_event_id) 与 UNIQUE(owner_id,dedupe_key)，tenant composite FK + FORCE RLS。event_type 统一为 invocation.terminal；source_event_id 是同一 PG transaction 插入的 append-only Invocation Event bigint id，不是 Worker/Broker 的自由文本 sourceEventId。payload 只含 protocol/schema/type、Conversation/Invocation ID、terminalState、assistantMessageId、resultDigest、errorCode、occurredAt，禁止正文、delta、Credential。consumer_event_streams 以 owner+conversation 为 PK，保存 latest_cursor 与 expired_through_cursor。普通事件从 createdAt 精确保留 7 天；prune 只删除按 cursor 排序的连续到期前缀，并在同 transaction 推进 expired watermark，绝不越过仍保留的较小 cursor。legal/security hold 进入独立审计保留层，不能延长或改写普通 wire outbox row。publisher 只在 PG commit 后 SKIP LOCKED并以 at-least-once投影 Redis/SSE；PUBLISHED 必须清空 nextAttemptAt。decimal Last-Event-ID 非零且 <=expired_through 时返回 410 SSE_CURSOR_EXPIRED，否则按 owner+conversation+cursor严格递增 replay。token delta 可丢且不作为完成事实；过期后客户端 GET 权威 transcript/terminal 再从 latest durable cursor 重开，绝不从 partial delta 拼 final。

## Alternatives considered

- 永久保留所有 delta；拒绝，因为成本和敏感面不必要。
- cursor 过期后从 0 静默重放；拒绝，因为可能漏/重复并掩盖 retention。

## Evidence

- OpenAPI SSE endpoint and SSE_CURSOR_EXPIRED error policy
- ConsumerEventOutboxRecordSchema golden binding and replay-watermark tests
- creator-hosted-agent-vnext-test-plan.md §10.3 terminal transaction
- creator-hosted-agent-vnext-test-plan.md §18.3

## Privacy and security impact

cursor 仍受 Conversation owner/RLS 检查；猜测 cursor 不得跨租户读取。

## Reversal triggers

- 产品需要合规审计长回放并为加密存储、删除和成本建立新策略。

## Affected protocol versions

- combo.creator-agent-http/1
- combo.consumer-event-outbox/1
