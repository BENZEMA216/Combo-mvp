<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-011: Snapshot envelope encryption format

- Status: accepted
- Owner: Security/SRE
- Decision date: 2026-08-13

## Decision

每个 Snapshot 用 CSPRNG 生成独立 256-bit DEK 和 96-bit nonce，以 AES-256-GCM 加密、16-byte tag；AAD 是 combo.snapshot-envelope/1 canonical JSON，绑定 creatorId、snapshotDigest、archiveDigest、objectKey、plaintextBytes、keyId。DEK 用 RFC3394 AES-256-KW 在独立 KEK 下包裹，32-byte DEK 的 wrappedDek 固定 40 bytes；nonce/tag/wrappedDek 用 canonical base64url。先完整认证再把明文交给 parser。

## Alternatives considered

- 仅 MinIO 磁盘加密；拒绝，因为对象/备份泄露可读。
- 复用一个长期 DEK；拒绝，因为 nonce 管理和爆炸半径不可接受。

## Evidence

- creator-hosted-agent-vnext-test-plan.md §8.5 and §23.4
- ContextSnapshot envelope encryption architecture

## Privacy and security impact

bit flip、跨 Creator/Object swap、错误 KEK 均在解包前失败；KEK 与数据备份必须分故障域。

## Reversal triggers

- 迁移云 KMS 原生 wrap 算法或 Creator-held key；必须发布新 envelope version 和迁移方案。

## Affected protocol versions

- combo.snapshot-envelope/1
- combo.snapshot-manifest/1
