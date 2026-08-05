# bootstrap 应用组装

这个目录把平台层和业务模块组装成可监听端口的 Fastify 应用。

## 文件

- `app.ts` 加载环境变量，创建数据库、对象存储、Redis 事件设施和可选 SandboxBackend，并把基础设施与 TurnRunner 挂到 Fastify。它注册严格 `PUBLIC_APP_ORIGINS` 白名单的凭据型 CORS、Cookie 解析、发布版本路由、健康检查、统一错误处理和结构化请求完成日志。关闭时，Turn 中止、远程清理、数据库和 Redis 共用一个绝对截止时间。
- `routes.ts` 汇总 Capability、Session、Artifact 和 Agent Revision Test/Release Session 端点，并在共享 API 前缀下注册浏览器事件端点。`ALL_ENDPOINTS` 供测试核对方法、路径和守卫。

`processes/api.ts` 调用 `buildApp` 启动服务。测试可以直接构建应用。浏览器身份由平台层读取 PostgreSQL 不透明会话；写路由在身份查询前验证精确来源。
