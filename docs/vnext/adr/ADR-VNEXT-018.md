<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-018: Data flow encryption RLS and service roles

- Status: accepted
- Owner: Security/SRE
- Decision date: 2026-08-13

## Decision

字段落点以 data-flow-allowlist/1 为唯一真源。Snapshot archive Context对象的AAD精确绑定archiveDigest/cipherObjectFormat/creatorId/keyId/objectKey/plaintextBytes/protocol/schemaVersion/snapshotDigest；Snapshot生成早于AgentVersion，不得伪造agentVersionDigest绑定。Chat/Worker result 用 AES-256-GCM、随机唯一96-bit nonce和JCS AAD；云端 AAD 绑定 ownerId/conversationId/messageId/role/schemaVersion，本地再绑定 installationId/invocationId/agentVersionDigest。Broker 中 prompt/delta/final 也必须使用 worker-session AES-256-GCM，AAD 精确绑定 protocol/schemaVersion/envelopeType/messageId/conversationId/invocationId/workerSessionId/role/keyId，并分别重算 aadDigest 与 nonce/ciphertext/tag 的 cipherDigest；frame 禁止敏感明文。tenant/version key 90天轮换，旧 key仅在保留期 decrypt。PG 对全部tenant表启用 FORCE RLS并加复合owner FK；事务 SET LOCAL app.creator_id/app.consumer_id，缺失即 deny。runtime roles固定 combo_agent_api、combo_agent_broker、combo_agent_reconciler，均非owner/NOBYPASSRLS；combo_agent_migrator仅DDL，combo_agent_maintenance为NOLOGIN受审break-glass。

## Alternatives considered

- 只靠 Repo owner filter；拒绝，漏一条 query 即跨租户。
- 单一 combo_app role；拒绝，不满足每服务最小权限和故障隔离。

## Evidence

- data-flow-allowlist.yaml executable schema
- creator-hosted-agent-vnext-test-plan.md §10.4, §20.2 and §22.6

## Privacy and security impact

RLS 与复合 FK defense-in-depth；Broker/Reconciler 跨租户工作只经限权 view/SECURITY DEFINER claim 后逐租户 SET LOCAL，不能直接读正文。密钥不进模型、argv/env/log。

## Reversal triggers

- 数据库拆分为物理 per-tenant 或服务边界变化；必须保持等价隔离与迁移负向测试。

## Affected protocol versions

- combo.vnext-data-flow-allowlist/1
- combo.message-envelope/1
- combo.creator-agent-http/1
