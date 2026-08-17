<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-030: Consumer 必须登录且受邀

- Status: accepted
- Owner: Product/Web
- Decision date: 2026-08-13
- Architecture decision: D010 — Consumer 必须登录且受邀

## Decision

Alpha Consumer 必须登录 Combo，并被 Creator 邀请或拥有 Agent access grant；只能读取自己的 Conversation。分享 URL slug 只定位 Agent，不是授权凭证；账号、IP、Agent 和 Conversation 四层限流与 WIP=1 同时执行。

## Alternatives considered

- 匿名无限公开聊天；拒绝，因为它是 Alpha 明确非目标且会扩大授权、费用与滥用风险。
- 把分享 slug 当作 bearer credential；拒绝，因为定位符不能替代登录、grant 和 owner authorization。

## Evidence

- creator-hosted-agent-vnext-architecture.md §1.2-1.3
- creator-hosted-agent-vnext-architecture.md §13.4
- creator-hosted-agent-vnext-architecture.md §15.4

## Privacy and security impact

登录、grant、owner authorization 和限流共同防止未授权读取、跨 Consumer 访问及 Creator 额度滥用；slug 泄漏不授予访问权。

## Reversal triggers

- 支持匿名公开访问前必须新增长期滥用、费用、隐私、内容安全和授权 Gate。

## Affected protocol versions

- combo.creator-agent-http/1
