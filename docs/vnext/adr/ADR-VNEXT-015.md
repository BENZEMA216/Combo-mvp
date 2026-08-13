<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-015: Model quota exhaustion is degraded not online

- Status: accepted
- Owner: Cloud/Broker
- Decision date: 2026-08-13

## Decision

Worker 心跳正常但 Creator 模型 quota synthetic probe 失败时，desiredState 保持 ONLINE，observedState 变为 DEGRADED，lastErrorCode=MODEL_QUOTA_EXHAUSTED；Consumer 新消息在创建 Invocation/Outbox 前快速失败 503，已有 transcript 可读。连续一次受限 probe 成功且其他 readiness 全绿后自动回 ONLINE，不创建新 AgentVersion。

## Alternatives considered

- 继续显示 ONLINE，直到每次 turn 失败；拒绝，产生 false-online 和费用困惑。
- 标记 Worker OFFLINE；拒绝，掩盖真正故障层且阻碍诊断。

## Evidence

- DeploymentView observedState and stable error classification
- INV-020 readiness invariant

## Privacy and security impact

probe 使用最小固定预算、无用户正文且不泄漏凭据；quota 失败不得触发替代模型或降级 Runtime。

## Reversal triggers

- Provider 提供可信实时 quota API，可替换 synthetic probe但保持 DEGRADED 语义。

## Affected protocol versions

- combo.creator-agent-http/1
