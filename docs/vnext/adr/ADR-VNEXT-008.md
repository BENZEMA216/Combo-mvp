<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-008: Worker SQLite migration and corruption recovery

- Status: accepted
- Owner: Creator Worker
- Decision date: 2026-08-13

## Decision

Worker Journal 使用 WAL、synchronous=FULL、foreign_keys=ON 和 forward-only schema version。迁移前 fsync 加密备份，迁移在单事务完成并跑 integrity_check/foreign_key_check；失败恢复原备份并 BLOCKED，禁止 downgrade schema。检测 corruption 时隔离原 DB、停止 READY/dispatch，不得创建空库冒充首次启动；仅从已验证加密备份恢复。若 Cloud 保留已 dispatch 的 PERSISTED Invocation 而本地 Journal/Host dispatch 证据永久丢失，唯一合法路径是 PERSISTED --LOSE_EXECUTION_EVIDENCE--> RECONCILING，在 5 分钟有界对账耗尽后进入 UNCERTAIN；该路径 Host 新调用必须为 0，新安装不得接管或重跑旧 invocationId。

## Alternatives considered

- corruption 后删除 DB 重建；拒绝，因为会把可能已执行的请求当未执行。
- 双向可逆 migration；拒绝，因为状态机语义回滚风险不可控。

## Evidence

- creator-hosted-agent-vnext-test-plan.md §11.1 and §11.6
- INV-014 and INV-015

## Privacy and security impact

防本地 journal 丢失导致重复推理、伪 terminal 或凭据混入备份；备份不含长期凭据。

## Reversal triggers

- 引入经验证的云端恢复协议，仍须保持 dispatch evidence 与 at-most-once 边界。

## Affected protocol versions

- combo.worker-journal/1
- combo.invocation-state-machine/1
