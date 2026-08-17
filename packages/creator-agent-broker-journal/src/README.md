# Broker 与双 Journal 源码

这个目录保存 Creator-hosted Agent VNext Track C 和 Track D 的可执行参考语义。生产服务可以替换存储和传输适配器，但不能改变这些状态、不变量和对账结果。

## 文件职责

- `capability-authority.ts` 适配正式 Execution Capability 签名/绑定 verifier；package-public 的 SQLite Gate 把 verifier 与 `FULL` durable CAS 封为一个不可拆入口，内存 store 只供 E1 reducer/fault 测试。
- `protocol.ts` 通过正式 `parseBrokerFrame` 解析权威 Envelope，并定义 canonical uint63 fence、连接 sequence 去重、三层 ACK fact 和 Lease Registry。
- `invocation.ts` 只把包内事件名适配到 `@cb/creator-agent-protocol` 的权威 Invocation reducer，并保留终态 exact replay/本包错误映射；不维护第二份迁移图。
- `cloud-journal.ts` 定义 PostgreSQL 风格事务接口及内存参考实现。一次消费者接受事务同时写入用户消息、Invocation、Event、Broker Outbox 和 Conversation BUSY；Worker ACK 和 final 也通过原子事务更新。
- `worker-journal.ts` 定义 SQLite 风格单写者事务接口及内存参考实现。它执行 prepare/start、全局 WIP=1、本地 Outbox、dispatch 边界、final 先落本地和云端 ACK 收敛。
- `reconciliation.ts` 给出 Cloud、Local、Host 和 Lease 证据的纯函数决策。越过 dispatch 边界后证据不足只会得到 `MARK_UNCERTAIN`，不会返回自动重跑。
- `fault-model.ts` 完整分类二十个 failpoint；只对九个可由本适配器真正序列化和重建的窗口执行 simulated recovery，其余明确为 model-only 或 blocked。
- `index.ts` 是包的公开入口。
- `scripts/generate-reconciliation-golden.mjs` 维护不导入 production reducer 的独立 oracle；生成的 `test-fixtures/reconciliation-golden.json` 覆盖完整 13 Cloud × 10 Local × 6 Host × 3 Lease × 2 Capability × 2 Digest-binding = 9,360 行输入笛卡尔积（SHA-256 `844cc8f916a6b63c0b8558ee7ec865c3045c0e5ec1607987a8f54a44550e663c`）。
- `capability-upstream-count-boundaries.test.ts` 使用真实文件 SQLite 验证 Provider 上游计数 `0/1/2` 的接受、重启读取、公开 Gate 提交和表级拒绝边界。
- 其余 `*.test.ts` 验证协议、状态机、签名能力、双 Journal、对账、fault model 和固定 seed 的随机不变量。

## 安全边界

测试只使用 digest、opaque ID 和计数，不保存 Prompt、答案、Context、凭据或绝对路径。内存适配器名称和 E1 证据等级必须保留在报告中，不能把这些测试写成“真实 PostgreSQL、SQLite、Broker、VM、Provider 或 Gate 4 已通过”。
