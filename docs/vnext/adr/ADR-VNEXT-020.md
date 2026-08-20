<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-020: Protection mode thresholds and recovery hysteresis

- Status: accepted
- Owner: Security/SRE
- Decision date: 2026-08-13

## Decision

root free<35GiB告警；root<25GiB或<15%阻止新Snapshot。data>70%告警，>80%阻止新发布并只允许安全Reclaimer，>90%再拒绝新Conversation。available RAM<2GiB停止后台Job/rollout；swap持续增长或OOM停止扩大Alpha。backup age>1小时或最近恢复演练失败立即记RPO breach并阻止发布，2小时后已有Conversation只读且拒绝新Invocation。恢复须 root>=30GiB且>=20%、data<=75%、RAM>=3GiB、backup<=1小时、恢复演练PASS并连续稳定15分钟。

## Alternatives considered

- 仅告警不自动阻断；拒绝，单节点资源耗尽会破坏权威数据。
- 阈值恢复即刻解除；拒绝，会在边界抖动。

## Evidence

- creator-hosted-agent-vnext-test-plan.md §22.4
- creator-hosted-agent-vnext-architecture.md §17.5

## Privacy and security impact

Protection Mode 不修改 terminal、不删除被引用 Snapshot、不以清理掩盖备份失败；动作和恢复均写脱敏审计。

## Reversal triggers

- 节点/磁盘拓扑、备份 RPO 或容量模型变化，需真实阈值 probe 重新定标。

## Affected protocol versions

- combo.creator-agent-http/1
- combo.vnext-evidence-bundle/1
