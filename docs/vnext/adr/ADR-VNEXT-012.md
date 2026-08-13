<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-012: Evidence backup chat and snapshot retention

- Status: accepted
- Owner: Security/SRE
- Decision date: 2026-08-13

## Decision

Chat 正文在线保留至 Conversation 最后活动后 30 天；Snapshot 在 serving/Conversation 引用期间保留，最后引用释放后再保留 30 天；Worker 已 CLOUD_COMMITTED terminal/outbox 保留 7 天。PG/MinIO 加密备份滚动保留 30 天，WAL 连续归档保留 7 天；Evidence Bundle 和脱敏审计 metadata 保留 90 天，Evidence Vault synthetic raw 最长 7 天。到期删除可验证，legal/security hold 必须单独审计和披露。

## Alternatives considered

- 全部永久保留；拒绝，扩大隐私和密钥暴露面。
- terminal 后立即删除；拒绝，破坏恢复、对账和 Consumer transcript。

## Evidence

- data-flow-allowlist/1
- creator-hosted-agent-vnext-test-plan.md §23 and §20.1

## Privacy and security impact

正文始终 AEAD，备份删除延迟最多到 30 天滚动窗口；hold 不得成为无期限默认。

## Reversal triggers

- 法律辖区或正式付费产品改变保留义务；须更新用户披露与删除演练。

## Affected protocol versions

- combo.vnext-data-flow-allowlist/1
- combo.vnext-evidence-bundle/1
- combo.creator-agent-http/1
