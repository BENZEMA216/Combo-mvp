<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-014: Security revoke forces cancellation or uncertainty

- Status: accepted
- Owner: Cloud/Broker
- Decision date: 2026-08-13

## Decision

Security revoke 以云端 effectiveAt 为界，原子停止新 dispatch、撤销 Worker session/Lease/Execution Capability并要求 Sandbox 销毁。effectiveAt 前已云端提交的 terminal 不改；其余 Invocation 进入 CANCEL_REQUESTED。能证明未执行或 interrupt confirmed 才 CANCELLED；可能已 dispatch 但证据不足在 5 分钟内对账，仍不明则 UNCERTAIN。effectiveAt 后 final 永不发布且不转 SUCCEEDED。

## Alternatives considered

- 等在途自然结束；拒绝，因为继续访问被撤销 Context/预算。
- 一律标 CANCELLED；拒绝，因为无法证明模型未执行。

## Evidence

- Invocation state machine cancellation evidence rules
- creator-hosted-agent-vnext-test-plan.md §9.3 and FLT-014/015/016

## Privacy and security impact

安全下线优先于可用性，同时保持终态事实不可篡改、不自动重跑。

## Reversal triggers

- Provider 提供可证明 atomic cancel-before-execute receipt，可缩短 UNCERTAIN 路径。

## Affected protocol versions

- combo.invocation-state-machine/1
- combo.creator-broker/1
- combo.execution-capability/1
