# platform — 平台层

这个目录放与具体业务规则无关的公共设施。

- `config/` 解析并校验进程配置。
- `http/` 提供路由注册、认证请求边界、健康检查、错误信封和浏览器观测入口。
- `infra/` 提供 PostgreSQL、Redis、队列、对象存储、Resend、认证软限流、本地会话读取和大模型网关。
- `middleware/` 使用 PostgreSQL 不透明会话保护业务路由。
- `observability/` 初始化链路追踪并提供 traceId 工具。
- `sse/` 实现任务进度事件流协议和 Redis 流桥。
- `text/` 提供会话噪声识别纯函数。

platform 被 bootstrap、modules 和 processes 使用，但不反向依赖业务模块。公共类型与端口契约来自 `@cb/shared`。身份创建、验证码消费和会话签发属于 account 模块，不放在平台层；平台层只提供外部依赖适配和会话只读能力。
