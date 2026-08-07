# Runtime 源码测试

这个目录保存 Runtime 单元测试、忠实假件和显式启用的集成测试。默认测试不连接外部服务；PostgreSQL 与 Redis 集成用例只在提供专用测试地址时运行，不能使用生产资源。

## 主要覆盖

- `auth-session.test.ts` 验证环境专属 Cookie、摘要查询、账号停用、普通与 SSE 守卫，以及 401、403、503 边界。
- `browser-origin.test.ts` 验证凭据型 CORS 和所有 Cookie 写请求只接受精确公开 origin。
- `env-auth.test.ts` 验证生产配置要求 PostgreSQL、Runtime 基础设施、公开 origin 和发布身份，同时不包含远端身份服务或开发登录配置。
- `version.test.ts` 验证发布元数据和 `/version.json`。
- `health.test.ts`、`http-logging.test.ts` 与 `observability-redaction.test.ts` 验证依赖状态、低敏日志和追踪脱敏。
- `routes.test.ts` 验证端点声明、鉴权与来源守卫、owner 隔离、普通与 Studio Session、UI 恢复和 Artifact 读取。
- `artifact.test.ts`、`session-detail.test.ts`、`session-repo.test.ts` 和 `session-consistency.integration.test.ts` 验证 Artifact 来源、详情快照、会话仓储、UI 晋升和事务约束。
- `modules/agent-project/repo.test.ts` 验证 Test 启动租约、技术终态、质量状态联查，以及技术、质量和当前 Head 共同决定的发布资格。
- `billing.test.ts` 验证免费三次、owner 免计费、钱包结算、`usageId` 幂等、余额不足、失败释放和清扫补偿。
- `billing.pg.test.ts` 仅在 `BILLING_PG_TEST=1` 且同时提供专用 `BILLING_TEST_DATABASE_URL` 和 `BILLING_RUNTIME_TEST_DATABASE_URL` 时运行。管理员连接只准备与核对随机测试数据，真实 service SQL 必须通过最小 `combo_runtime` 身份执行；用例覆盖免费额度的成功结算与失败释放，也验证同一 Session 或跨 Session 并发提交时，同一用户的 `usageId` 只产生一条用量、一个 Turn 和一笔扣费。测试不清理不可变资金流水，数据库应由外层 fixture 整体重建。
- `build-agent.test.ts`、`run-turn.test.ts`、`stream-events.test.ts`、`turn-control.test.ts`、`turn-repo.test.ts` 和 `terminal-fence.integration.test.ts` 验证 Pi Agent、Turn 生命周期、Redis 补发与终态栅栏。
- `sandbox-backend.test.ts`、`sandbox-capability.test.ts`、`sandbox-client.test.ts`、`sandbox-config.test.ts` 和 `sandbox-tools.test.ts` 验证 Kubernetes 后端、内部能力令牌、远程协议、配置门禁和四个模型工具。
- `fakes.ts` 提供与当前 SQL 守卫一致的内存数据库、Redis 事件日志、对象存储和 Pi Agent 假件。

生产源码不反向引用本目录。
