<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-027: Codex Runtime、artifact 和 schema exact pin

- Status: accepted
- Owner: Protocol
- Decision date: 2026-08-13
- Architecture decision: D007 — Codex Runtime、artifact 和 schema exact pin

## Decision

AgentVersion 身份包含 Codex Runtime artifact digest 和 app-server schema digest；每个受支持的 Codex、image 和 Sandbox adapter 使用精确版本及 digest，并通过真实 app-server conformance、三轮多轮、interrupt、Proxy、隔离和资源证据后才能进入 Runtime RC。缺登录、版本不符或安全 probe 失败均为 BLOCKED。

## Alternatives considered

- 自动兼容任意 Codex 版本；拒绝，因为任意版本自动兼容是 Alpha 非目标，experimental protocol 升级可能破坏契约。
- 只固定版本字符串而不固定 artifact/schema digest；拒绝，因为不能阻断供应链替换和 schema 漂移。

## Evidence

- creator-hosted-agent-vnext-architecture.md §4.1
- creator-hosted-agent-vnext-architecture.md §7.6-7.7
- creator-hosted-agent-vnext-architecture.md §19.4 and §21.1

## Privacy and security impact

exact digest、SBOM、签名和 allowlist 限制 Runtime 供应链替换；未验证版本不得被 skip 或 fallback 冒充通过。

## Reversal triggers

- Codex 提供新的正式稳定接口时可以升级协议，但仍须形成新 pin 并重跑 conformance 与 Isolation Gate。

## Affected protocol versions

- combo.agent-version-manifest/1
- combo.sandbox-attestation/1
- combo.creator-broker/1
