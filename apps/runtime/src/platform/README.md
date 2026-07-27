# platform 平台层

平台层保存 Runtime 各业务模块共用的基础能力。

- `config/` 解析数据库、Redis、对象存储、发布身份、公开站点、模型和可选沙箱配置。
- `infra/` 封装 PostgreSQL、Redis、对象存储、不透明会话读取、模型选择和 SandboxBackend。
- `middleware/` 把 PostgreSQL 会话解析成请求鉴权守卫。
- `http/` 提供来源边界、路由声明、错误信封、健康检查、版本信息和浏览器事件端点。
- `observability/` 提供日志、追踪和敏感字段清理。

平台层不签发浏览器会话，也不依赖远端身份提供商。Sandbox 的短期能力令牌是 Runtime 与 sandboxd 之间的内部协议，不可用作用户认证。
