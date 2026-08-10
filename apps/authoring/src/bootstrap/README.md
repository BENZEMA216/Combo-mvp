# bootstrap — API 进程组装层

这个目录负责构建 Fastify 应用，注入基础设施容器，注册全局插件、统一错误处理、健康检查和全部业务路由。

## 文件

- `app.ts` 加载环境配置并构造 Fastify。它关闭默认原始请求日志，只记录方法、路由模板、状态和 traceId；认证与 OAuth 解析错误不把原始异常写入日志。应用注册 Helmet、精确 CORS、Cookie、根级 OAuth/MCP 路由和 `/api/v1` 浏览器业务路由。所有非测试运行模式的路由级限流都使用共享 `redis_hot`，按 `COMBO_ENVIRONMENT` 隔离 key，并在 Redis 故障时失败关闭；只有显式 `NODE_ENV=test` 的 inject 单测可选择进程内 store。支付启用且不是测试进程时，应用启动多副本安全的充值查单调度器；关闭时先停止调度，再释放数据库、Redis、队列和对象存储客户端。
- `routes.ts` 把 account、task、capability、agent-project、project-agent-share、codex-agent-share、billing 与浏览器观测路由统一挂到 `/api/v1`，并导出完整端点声明供测试核对；`external-mcp/routes.ts` 由 `app.ts` 直接挂根级规范路径。

## 上下游

`processes/api.ts` 调用 `buildApp` 后监听端口。`app.ts` 依赖 `platform/config/env.ts`、`platform/infra/index.ts`、`platform/http/`、`platform/observability/node.ts` 和 billing 查单调度器；`routes.ts` 依赖七个浏览器业务模块的路由声明。

组合根只负责接线，不实现账号、任务、能力项、Agent 创作或充值规则。第一方认证、Agent 编译和支付所需的 PostgreSQL、对象存储、Resend、Redis 与乐收赢端口都由基础设施容器提供，账号事务由 account 模块执行，Agent 创作事务由 agent-project 模块执行，充值与入账事务由 billing 模块执行。
