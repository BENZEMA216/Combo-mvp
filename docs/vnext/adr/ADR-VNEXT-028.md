<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-028: Worker offline 时快速失败；online busy 时 bounded queue

- Status: accepted
- Owner: Cloud/Broker
- Decision date: 2026-08-13
- Architecture decision: D008 — Worker offline 时快速失败；online busy 时 bounded queue

## Decision

Worker 离线时不接受新队列，直接向消费者返回 Agent offline。Worker online 且 busy 时使用有界队列：Deployment 最多 10 个 queued Invocation、每 Consumer 最多 1 个、Conversation 内 WIP=1、Queue TTL 120 秒，并按 Conversation round-robin；到期在 dispatch 前进入 EXPIRED。

## Alternatives considered

- Worker 离线时继续积压请求；拒绝，因为 Creator-hosted Alpha 不承诺 24×7 且必须准确显示 offline。
- online busy 时使用无界队列；拒绝，因为会扩大费用、等待时间和资源 DoS。

## Evidence

- creator-hosted-agent-vnext-architecture.md §12.8
- creator-hosted-agent-vnext-architecture.md §15.2
- creator-hosted-agent-vnext-architecture.md §18.4

## Privacy and security impact

有界 queue、TTL、WIP 和公平调度限制资源/费用 DoS；offline 不能显示假在线或在无 Worker 时积压隐藏工作。

## Reversal triggers

- 转向 managed runtime、多 Creator 自动调度或新的容量模型时，重新冻结 presence、queue 和费用边界。

## Affected protocol versions

- combo.creator-agent-http/1
- combo.invocation-state-machine/1
