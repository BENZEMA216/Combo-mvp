# Runtime 源码测试

这个目录保存 Runtime 的单元测试、忠实假件和显式启用的集成测试。默认测试不会连接外部服务；Session 一致性用例只需显式提供测试 PostgreSQL，终态栅栏用例则必须同时提供测试 PostgreSQL 与 Redis。地址必须指向已经迁移的临时测试实例，不能使用生产资源。所有用例都不连接真实对象存储或 Kubernetes 集群。

## 文件职责

- `fakes.ts` 提供与当前仓储 SQL 守卫一致的内存数据库、Redis 事件日志、对象存储和 Pi Agent 假件。
- `artifact.test.ts` 验证 Artifact 暂存对象、运行中 Turn 条件提交、中断栅栏、Studio HTML 契约、UI revision 和 Session 快照。
- `build-agent.test.ts` 验证系统提示词、历史消息和模型接线。
- `loader.test.ts` 验证 Capability 归属、发布可见性和定义加载。
- `routes.test.ts` 验证 Runtime 端点声明、错误信封、普通与 Studio Session、会话归档、UI 恢复和 Artifact 内容读取。
- `session-detail.test.ts` 验证详情只使用一条 `REPEATABLE READ READ ONLY` 连接，在快照内重验 owner，并且不会退回池级并行查询。
- `session-consistency.integration.test.ts` 在显式提供的真实 PostgreSQL 上交错提交详情状态、并发复制 UI，并验证 UI 晋升和 Artifact 来源约束；它覆盖详情 MVCC 快照、Session 行锁、owner 隔离、Turn 终态及事务回滚。
- `run-turn.test.ts` 验证 Turn 创建、模型执行、Studio 成功提升、事件顺序、终态收尾、打断、超时和关闭截止时间。
- `session-repo.test.ts` 验证 Session 与 Message 的归属条件、排序和状态处理。
- `stream-events.test.ts` 验证 Redis Stream 编号、断线补发、实时缓冲和去重。
- `turn-control.test.ts` 验证单 Session 单运行 Turn、开轮提交窗口、关闭期间的开轮事务栅栏、遗留终态修复、公开错误文案、跨副本终态栅栏、功能启停混合副本和超时清扫。
- `turn-repo.test.ts` 验证 Turn 仓储的唯一冲突映射、条件收尾、最近持久终态读取和锁序。
- `terminal-fence.integration.test.ts` 在显式提供的真实 PostgreSQL 与 Redis 上验证双副本广播丢失、提交回滚、终态超时、迟到文本、迟到 Artifact、下一轮排序、冲突终态修复、匹配标记后的终态重排、逐字终态幂等、错误文案脱敏、旧版开放标记和有效期边界。
- `sandbox-backend.test.ts` 验证 Kubernetes Pod 身份、安全规格、PVC 原子分配、强制删除后的槽位隔离、节点终止 finalizer、迟到创建协调和有界关闭。
- `sandbox-capability.test.ts` 验证沙箱能力令牌的签名材料、声明绑定和有效期。
- `sandbox-client.test.ts` 验证 sandboxd 的认证请求、线路限制、命令流、取消和协议错误。
- `sandbox-config.test.ts` 验证沙箱默认关闭、启用必填项、四槽默认值和第五槽门禁。
- `sandbox-tools.test.ts` 验证四个 Pi 工具只调用 SandboxBackend，并把远端错误转换为稳定结果。
