<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-001: Project staging mutation fails closed

- Status: accepted
- Owner: Snapshot/Version
- Decision date: 2026-08-13

## Decision

Project 在 enumerate/open/read/close/restat 任一阶段改变时，当前发布尝试以 SNAPSHOT_SOURCE_CHANGED 终止；不得在同一 upload、Idempotency-Key 或 staging 目录上自动重试。Creator 必须重新 Preview，并以新请求创建完整一致的 staging。错误分类为 NOT_RETRYABLE，意思是原请求不可重放，不妨碍用户明确发起新发布。

## Alternatives considered

- 自动重读变化文件直到稳定；拒绝，因为会混合时点且无法界定结束。
- 锁住或修改活 Project；拒绝，因为发布器承诺不改 Creator Project。

## Evidence

- creator-hosted-agent-vnext-test-plan.md §8.4 TOCTOU barriers
- SNAPSHOT_SOURCE_CHANGED stable error classification

## Privacy and security impact

防止恶意 rename/symlink race 把 Host canary 或新旧混合 bytes 装入 Snapshot；失败信息不得包含绝对路径或正文。

## Reversal triggers

- 引入可证明的一致 filesystem snapshot primitive，且通过同一 TOCTOU corpus。

## Affected protocol versions

- combo.snapshot-manifest/1
- combo.creator-agent-http/1
