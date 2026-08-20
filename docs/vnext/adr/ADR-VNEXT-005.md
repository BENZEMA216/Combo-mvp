<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-005: Grant revocation makes open conversations read only

- Status: accepted
- Owner: Product/Web
- Decision date: 2026-08-13

## Decision

Consumer grant 撤销对新请求立即生效。已打开 Conversation 保留消费者读取自己已提交 transcript 的权利，但进入 SUSPENDED/read-only，禁止新 Message、Invocation 和 reconnect dispatch；在途 Invocation 按 ADR-VNEXT-014 安全撤销。撤销前已在云端 durable commit 的 terminal/final 可读，撤销后迟到 final 不发布。

## Alternatives considered

- 已打开 Conversation 继续执行到关闭；拒绝，因为撤销不是新会话提示而是授权边界。
- 删除消费者历史；拒绝，因为会破坏用户可见事实和审计。

## Evidence

- creator-hosted-agent-vnext-test-plan.md §18.1 auth matrix
- INV-017 tenant isolation

## Privacy and security impact

消除旧 session/grant 继续花费 Creator quota 或读取 Context 的窗口，同时不伪造/删除已发生的用户事实。

## Reversal triggers

- 产品引入有时限的 offline grant token，且撤销 SLA、法律与费用模型另行评审。

## Affected protocol versions

- combo.creator-agent-http/1
- combo.invocation-state-machine/1
