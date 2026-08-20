<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-026: Alpha 模型额度由 Creator 承担

- Status: accepted
- Owner: Product/Web
- Decision date: 2026-08-13
- Architecture decision: D006 — Alpha 模型额度由 Creator 承担

## Decision

Alpha 的真实模型调用使用 Creator 的 OpenAI/Codex 凭据与额度；发布 Preview 必须明确展示该费用边界。邀请、配额、WIP、速率限制和一次性 Execution Capability 用于限制滥用；本版本不提供精细计费或 Marketplace。

## Alternatives considered

- Alpha 由 Combo 提供模型额度和精细计费；后置，因为精细计费和 Marketplace 明确不在本版本范围。

## Evidence

- creator-hosted-agent-vnext-architecture.md §14.1
- creator-hosted-agent-vnext-architecture.md §20.3
- creator-hosted-agent-vnext-architecture.md §22.1 and §24

## Privacy and security impact

Creator 模型额度是主要资产；Capability、邀请、限流和 WIP 必须防止消费者或重放路径产生未授权费用。

## Reversal triggers

- Creator 不接受承担模型额度和机器在线成本时触发 Product Kill/Pivot；新的付费方或计费模型须另行决策。

## Affected protocol versions

- combo.execution-capability/1
- combo.agent-version-manifest/1
