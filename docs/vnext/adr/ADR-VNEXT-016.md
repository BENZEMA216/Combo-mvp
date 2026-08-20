<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-016: Exact reconciliation reclaim and capability deadlines

- Status: accepted
- Owner: Cloud/Broker
- Decision date: 2026-08-13

## Decision

执行证据丢失时从首个 durable lost-evidence timestamp 起 300 秒内 reconcile，边界到达仍不明即 UNCERTAIN；孤儿 Sandbox/scratch/lease 立即回收并在 300 秒内完成或使 Deployment BLOCKED。Execution Capability expiresAt 不得晚于 Invocation deadlineAt+30秒，且 revoke 可更早失效；所有 deadline 用云端 UTC，测试覆盖前1ms、等于、后1ms。

## Alternatives considered

- 无限期 reconcile；拒绝，会永久 stuck 且保留权限。
- Lease 过期立即把在途标失败；拒绝，会覆盖真实已执行事实。

## Evidence

- creator-hosted-agent-vnext-test-plan.md §12.4 and §30.16
- Invocation reconciliation property rules

## Privacy and security impact

bounded capability 与资源寿命缩短重放窗口；超时不意味着可重跑。

## Reversal triggers

- 真实 provider/host receipt 能缩短窗口；延长必须重新评估费用和攻击面。

## Affected protocol versions

- combo.invocation-state-machine/1
- combo.execution-capability/1
- combo.creator-broker/1
