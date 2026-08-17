<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-025: 采用至少一次传输、幂等、Fence、UNCERTAIN，不宣称 exactly once

- Status: accepted
- Owner: Protocol
- Decision date: 2026-08-13
- Architecture decision: D005 — 采用至少一次传输、幂等、Fence、UNCERTAIN，不宣称 exactly once

## Decision

Codex dispatch 前采用 at-least-once delivery 和幂等处理；dispatch 后只允许 at-most-once automatic execution。Lease/Fence 阻断 stale Worker；无法证明是否越过 dispatch 或无法确认终态时进入 UNCERTAIN，不自动二次执行。Codex/模型 Provider 未证明按平台 idempotency key 去重，因此不宣称 exactly-once inference。

## Alternatives considered

- 宣称 exactly-once inference；拒绝，因为 Host/Provider 没有可验证的端到端去重保证。
- 将超时或断线直接视为可重试失败；拒绝，因为可能覆盖已经发生的真实执行和费用。

## Evidence

- creator-hosted-agent-vnext-architecture.md §2.4
- creator-hosted-agent-vnext-architecture.md §11.5
- creator-hosted-agent-vnext-architecture.md §12.1-12.7

## Privacy and security impact

幂等、Lease/Fence 和两本 Durable Journal 限制重放与 stale 写入；UNCERTAIN 防止故障恢复导致重复推理、重复 final 和重复收费。

## Reversal triggers

- 只有 Codex 与模型 Provider 提供可验证的端到端 idempotency receipt 后，才可重新评审 exactly-once 表述。

## Affected protocol versions

- combo.invocation-state-machine/1
- combo.creator-broker/1
- combo.worker-journal/1
