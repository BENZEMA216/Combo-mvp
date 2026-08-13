# Broker 与双 Journal 源码

这个目录保存 Creator-hosted Agent VNext Track C 和 Track D 的可执行参考语义。生产服务可以替换存储和传输适配器，但不能改变这些状态、不变量和对账结果。

## 文件职责

- `protocol.ts` 定义临时的 Broker Envelope 边界校验、canonical uint63 fence、连接 sequence 去重和 Lease Registry。正式共享协议合入后，只有边界类型和解析函数迁移，sequence 与 Lease 行为继续由本包测试。
- `invocation.ts` 定义云端 Invocation 状态机、终态单调规则和非法迁移错误。
- `cloud-journal.ts` 定义 PostgreSQL 风格事务接口及内存参考实现。一次消费者接受事务同时写入用户消息、Invocation、Event、Broker Outbox 和 Conversation BUSY；Worker ACK 和 final 也通过原子事务更新。
- `worker-journal.ts` 定义 SQLite 风格单写者事务接口及内存参考实现。它执行 prepare/start、全局 WIP=1、本地 Outbox、dispatch 边界、final 先落本地和云端 ACK 收敛。
- `reconciliation.ts` 给出 Cloud、Local、Host 和 Lease 证据的纯函数决策。越过 dispatch 边界后证据不足只会得到 `MARK_UNCERTAIN`，不会返回自动重跑。
- `fault-harness.ts` 定义测试方案中的二十个正式 failpoint、可注入控制器和参考恢复场景。
- `index.ts` 是包的公开入口。
- `*.test.ts` 验证协议、状态机、双 Journal、对账、二十个 fault 场景和固定 seed 的随机不变量。

## 安全边界

测试只使用 digest、opaque ID 和计数，不保存 Prompt、答案、Context、凭据或绝对路径。内存适配器名称和证据等级必须保留在报告中，不能把这些测试写成“真实 PostgreSQL、SQLite 或云端 E2E 已通过”。
