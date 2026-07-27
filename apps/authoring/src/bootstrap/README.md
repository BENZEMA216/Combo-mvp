# bootstrap — API 进程组装层

这个目录负责构建 Fastify 应用，注入基础设施容器，注册全局插件、统一错误处理、健康检查和全部业务路由。

## 文件

- `app.ts` 加载环境配置并构造 Fastify。它关闭默认原始请求日志，只记录方法、路由模板、状态和 traceId；认证解析错误不把原始异常写入日志。应用注册 Helmet、精确 CORS、Cookie 和路由级限流插件，认证与 Cookie 鉴权写路由共用同一来源边界，统一保留认证 413 与 415 状态，并在关闭时释放数据库、Redis、队列和对象存储客户端。
- `routes.ts` 把 account、task、capability 与浏览器观测路由统一挂到 `/api/v1`，并导出完整端点声明供测试核对。

## 上下游

`processes/api.ts` 调用 `buildApp` 后监听端口。`app.ts` 依赖 `platform/config/env.ts`、`platform/infra/index.ts`、`platform/http/` 和 `platform/observability/node.ts`；`routes.ts` 依赖三个业务模块的路由声明。

组合根只负责接线，不实现账号、任务或能力项规则。第一方认证所需的 PostgreSQL、Resend 和 Redis 端口都由基础设施容器提供，账号事务由 account 模块执行。
