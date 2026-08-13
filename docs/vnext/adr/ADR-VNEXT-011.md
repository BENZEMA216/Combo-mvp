<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-011: Snapshot envelope encryption format

- Status: accepted
- Owner: Security/SRE
- Decision date: 2026-08-13

## Decision

每个 Snapshot 用 CSPRNG 生成独立 256-bit DEK；每个加密对象独立生成唯一 96-bit CSPRNG nonce，同 DEK 下严禁 nonce 复用。Snapshot archive 使用 AES-256-GCM 和 16-byte tag；AAD 是 combo.snapshot-envelope/1 canonical JSON，精确绑定 protocol/schemaVersion/cipherObjectFormat/creatorId/snapshotDigest/archiveDigest/objectKey/plaintextBytes/keyId。archive 密文格式冻结为 combo.snapshot-binary/1，即 ASCII("CSNPENC1") || nonce[12] || ciphertext[plaintextBytes] || authTag[16]，不允许 trailing bytes；cipherBytes=plaintextBytes+36，cipherDigest覆盖完整对象，Envelope nonce/tag必须与内嵌段逐 byte 相等。DEK 用 RFC3394 AES-256-KW 在独立 KEK 下包裹，32-byte DEK 的 wrappedDek固定40 bytes；nonce/tag/wrappedDek使用canonical base64url。先校验长度、完整对象digest、magic、nonce/tag绑定和AEAD认证，再校验明文大小/archive digest，最后才交给parser。该版本的SnapshotArchiveEnvelope只覆盖archive；架构要求的encrypted manifest必须使用独立nonce和独立envelope，完成前Gate 1保持BLOCKED。

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
- combo.snapshot-binary/1
- combo.snapshot-manifest/1
