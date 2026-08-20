<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-006: Conversation history limits close without truncation

- Status: accepted
- Owner: Product/Web
- Decision date: 2026-08-13

## Decision

Alpha 最多 20 个已接受用户 turn，visible history 是所有已持久化 USER/ASSISTANT 正文 UTF-8 bytes 之和，最大 65536。若新 USER 正文会使任一上限超出，在写 Message/Invocation/Outbox 前返回 CONVERSATION_CONTEXT_LIMIT，使 Conversation SUSPENDED/read-only并提示创建新 Conversation；不截断、不总结、不静默丢历史。

## Alternatives considered

- 滑动窗口丢弃最旧消息；拒绝，因为改变多轮语义且无法向用户证明。
- 模型自动总结；拒绝，因为摘要不确定且会创建隐藏执行。

## Evidence

- RuntimePolicy maxConversationTurns/maxVisibleHistoryBytes
- creator-hosted-agent-vnext-architecture.md §7.3-7.4

## Privacy and security impact

在执行前限制 token/费用 DoS，且避免截断导致安全指令或授权上下文消失。

## Reversal triggers

- 有版本化、可见、可审计的 summarization contract 并通过语义/费用 Gate。

## Affected protocol versions

- combo.agent-version-manifest/1
- combo.creator-agent-http/1
