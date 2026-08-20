<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-032: Apple Container 为首选候选，Lima/VZ 为备选；均需 Gate

- Status: accepted
- Owner: Runtime/Sandbox
- Decision date: 2026-08-13
- Architecture decision: D012 — Apple Container 为首选候选，Lima/VZ 为备选；均需 Gate

## Decision

External Alpha 首选候选是精确 pin 的 Apple container；Lima/VZ 是 Linux Codex 兼容性和独立 VM 备选，并必须关闭默认 mounts/forwarding。Spike A 验证 Linux arm64 Codex 可运行，Spike B 验证 Apple Container 隔离；任一支持组合都必须通过真实 Runtime 与 Isolation Gate，失败不得回退 Native macOS。

## Alternatives considered

- Colima 或 Docker；仅用于 trusted internal prototype，不能作为 External Alpha 隔离证明。
- 自研 Virtualization.framework VMM；只有 Apple Container 失败且确有必要时再投资。
- Native macOS Runtime；外部消费者路径禁止。

## Evidence

- creator-hosted-agent-vnext-architecture.md §0.3
- creator-hosted-agent-vnext-architecture.md §7.6-7.7
- creator-hosted-agent-vnext-architecture.md §19.4 and §22.2

## Privacy and security impact

adapter 名称不等于隔离证据；必须真实验证 Host mount、Credential、网络、跨会话和资源边界，Apple container 1.0 前还必须 exact pin。

## Reversal triggers

- Apple Container Gate 失败时只能评估已冻结的 Lima/VZ 备选；若候选均未通过，External Alpha 不上线而不是回退 Native。

## Affected protocol versions

- combo.sandbox-spec/1
- combo.sandbox-attestation/1
