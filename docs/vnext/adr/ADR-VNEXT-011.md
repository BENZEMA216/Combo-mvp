<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-011: Snapshot envelope encryption format

- Status: accepted
- Owner: Security/SRE
- Decision date: 2026-08-13

## Decision

每个 Snapshot 用 CSPRNG 生成独立 256-bit DEK，archive 与 canonical manifest 共享该 DEK、各自使用唯一 96-bit CSPRNG nonce，严禁复用。两者均为 AES-256-GCM、16-byte tag、cipherBytes=plaintextBytes+36、cipherDigest覆盖完整对象；archive 使用 combo.snapshot-envelope/1 与 ASCII("CSNPENC1")，AAD 绑定 creatorId/snapshotDigest/archiveDigest/final objectKey/plaintextBytes/keyId；manifest 使用 combo.snapshot-manifest-envelope/1 与 ASCII("CSNPMAN1")，AAD 绑定 creatorId/snapshotDigest/final manifest objectKey/plaintextBytes/keyId。DEK 用 RFC3394 AES-256-KW 包裹，32-byte DEK 的 wrappedDek固定40 bytes；nonce/tag/wrappedDek使用canonical base64url。Worker 必须先完成两个加密对象，再以完整 Envelope、cipherBytes、cipherDigest和canonical base64 checksum创建upload session；云端一次返回两个绑定temp key、长度、checksum、If-None-Match和完整metadata的15分钟Signed PUT。Verifier先完整读取并认证两个temp对象并重算manifest/archive/snapshot digest；随后以If-None-Match写固定 preparation marker，冻结首个已验证的双Envelope、checksum、计数和selectedUploadId，再条件物化两个正式密文，完整读回验证后才以固定commit marker原子发布。Reader只以commit marker为可见性权威，preparation或单/双final存在但无commit时均不可见。preparation body是data-flow allowlist明确授权的私有wrapped-key Envelope控制元数据；wrappedDek/keyId不得进入S3 user metadata、URL、日志、浏览器、Gateway或模型输入，普通reader无unwrap authority。崩溃恢复优先重放所选temp；原temp丢失时，新上传必须先用自己的Envelope完成双AEAD、canonical manifest/archive/逐文件和全部明文身份验证，随后只允许用prepared DEK/nonce/AAD对同一明文做exact replay，并在PUT前匹配原tag/cipherDigest/cipherBytes/checksum；任何身份/AAD不一致都必须在复用旧nonce前拒绝。真实RFC3394/KMS、正式IAM/Object Lock、PG inventory和DR仍是独立未完成Gate，不得由本协议或测试key冒充。

## Alternatives considered

- 仅 MinIO 磁盘加密；拒绝，因为对象/备份泄露可读。
- 复用一个长期 DEK；拒绝，因为 nonce 管理和爆炸半径不可接受。

## Evidence

- creator-hosted-agent-vnext-test-plan.md §8.5 and §23.4
- ContextSnapshot envelope encryption architecture
- Snapshot publication crash failpoints on fake S3 and disposable real MinIO

## Privacy and security impact

bit flip、跨 Creator/Object swap、错误 KEK 均在解包前失败；commit marker消除双final的部分可见窗口，preparation保留经授权的wrapped key ciphertext以无删除恢复；旧DEK/nonce只允许相同AAD和明文的exact replay。KEK 与数据备份必须分故障域，hash link不替代正式IAM/Object Lock或外部签名。

## Reversal triggers

- 迁移云 KMS 原生 wrap 算法或 Creator-held key；必须发布新 envelope version 和迁移方案。

## Affected protocol versions

- combo.creator-agent-http/1
- combo.snapshot-binary/1
- combo.snapshot-envelope/1
- combo.snapshot-manifest-binary/1
- combo.snapshot-manifest-envelope/1
- combo.snapshot-manifest/1
- combo.snapshot-object-storage/1
- combo.snapshot-publication-commit/1
- combo.snapshot-publication-preparation/1
