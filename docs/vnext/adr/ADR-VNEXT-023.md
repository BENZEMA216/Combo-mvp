<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-023: Alpha 中 Combo 可解密 Context 和聊天正文；明示且限制保留

- Status: accepted
- Owner: Security/SRE
- Decision date: 2026-08-13
- Architecture decision: D003 — Alpha 中 Combo 可解密 Context 和聊天正文；明示且限制保留

## Decision

Alpha 使用 Combo 管理的 envelope encryption；这能防普通磁盘、对象和备份泄露，但不能防 Combo 特权运维读取 Context。Consumer 聊天正文默认保留 30 天，日志禁止记录 Prompt、答案、Project 正文、Signed URL、Token、绝对路径、Host stderr 和隐藏 reasoning；产品必须明示模型服务仍会收到回答所需 Context。

## Alternatives considered

- 把当前方案描述成零知识或端到端加密；拒绝，因为 Alpha 的 Combo 管理密钥允许特权运维解密。
- Alpha 使用 Creator-held Context key；后置，因为设备迁移和恢复协议尚未设计。

## Evidence

- creator-hosted-agent-vnext-architecture.md §5.6
- creator-hosted-agent-vnext-architecture.md §16.5-16.6
- creator-hosted-agent-vnext-architecture.md §22.1

## Privacy and security impact

明确 Combo 的隐私责任、正文保留和删除边界；不得以磁盘加密扩大为 Combo 无法读取，也不得把正文写入普通日志。

## Reversal triggers

- 未来承诺 Combo 看不到 Context 时，必须另做 Creator-held key、设备迁移和恢复协议。

## Affected protocol versions

- combo.snapshot-envelope/1
- combo.message-envelope/1
- combo.creator-agent-http/1
