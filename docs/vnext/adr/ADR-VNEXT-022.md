<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-022: 云端保存 Creator 明确确认的不可变 Snapshot

- Status: accepted
- Owner: Snapshot/Version
- Decision date: 2026-08-13
- Architecture decision: D002 — 云端保存 Creator 明确确认的不可变 Snapshot

## Decision

Creator 先预览文件数量、大小、阻断项和公开边界并明确确认；Worker 从一致 staging 生成 deterministic manifest/archive 和 digest，经私有加密对象上传及云端重新校验后形成不可覆盖的 Snapshot。只有 VERIFIED Snapshot 能创建不可变 AgentVersion，活 Project 后续变化不改变旧版本。

## Alternatives considered

- 运行时直接读取 Creator 活 Project；拒绝，因为会产生版本漂移和扫描/运行 TOCTOU。
- 让 Codex 充当 Context 长期存储；拒绝，因为 Context、Runtime 和 Model 必须分离。

## Evidence

- creator-hosted-agent-vnext-architecture.md §3.1
- creator-hosted-agent-vnext-architecture.md §5.1-5.5
- creator-hosted-agent-vnext-architecture.md §14.1

## Privacy and security impact

Snapshot 不可覆盖、按 digest 校验并限制路径、类型和大小；Creator 必须看见 Context 会上传 Combo 云且内容可能出现在回答中。

## Reversal triggers

- 若不再由云端保存权威 Snapshot，必须重新证明不可变身份、恢复、回滚和运行时不读取活 Project。

## Affected protocol versions

- combo.snapshot-manifest/1
- combo.snapshot-envelope/1
- combo.agent-version-manifest/1
