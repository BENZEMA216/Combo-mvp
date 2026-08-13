<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-010: Signed one-use model execution capability

- Status: accepted
- Owner: Runtime/Sandbox
- Decision date: 2026-08-13

## Decision

Cloud 以注册 P-256 key 对 canonical unsigned ExecutionCapability 作 ES256 IEEE-P1363 签名；精确绑定 Capability/Invocation/Conversation/Deployment/Version/Worker/Lease/Fence/providerRequestId/requestDigest/model/effort/budget/notBefore/expiresAt/nonce。Proxy 先验签再绑定，durable use ledger 仅允许 UNUSED→DISPATCHED→DURABLE_RESULT 或 REVOKED；exact replay 只查询旧状态/结果，任何变化安全阻断，provider upstream count<=1。

## Alternatives considered

- Caller 传入 capabilityValid boolean；拒绝，因为无法证明签名或字段绑定。
- 可重复 bearer token；拒绝，因为第二 turn 和预算重放不可控。

## Evidence

- ExecutionCapabilitySchema, verifier and 100000-run use property model
- creator-hosted-agent-vnext-test-plan.md §9.4 and §16.2

## Privacy and security impact

capability 最坏权限仅为一个 Invocation 的一次限定模型预算；不可访问 Combo API、MinIO、任意 URL 或刷新自身。

## Reversal triggers

- 改用硬件签名或外部 capability service；必须保持 exact binding 和 durable one-use proof。

## Affected protocol versions

- combo.execution-capability/1
- combo.creator-broker/1
