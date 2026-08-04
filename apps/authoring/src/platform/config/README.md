# platform/config — 环境配置

这个目录负责解析并校验 authoring 两个进程的环境变量，是服务配置的唯一入口。

## 文件

- `env.ts` 定义 PostgreSQL、双 Redis、MinIO、大模型、链路追踪、不可变发布身份、公开站点和邮箱认证配置。production 模式的 API 进程必须显式提供严格逗号列表 `PUBLIC_APP_ORIGINS`、布尔字符串 `SESSION_COOKIE_SECURE`、`RESEND_API_KEY`、精确发件身份 `Combo <auth@buildwithcombo.com>` 与不少于三十二字符的 `OTP_HMAC_SECRET`；worker 不要求也不消费这些认证密钥。开发和测试可为本地邮件 mock 使用语法有效的裸邮箱或带显示名邮箱，任何非空错误格式都会在启动时被拒绝。安全 Cookie 只与 HTTPS origin 搭配，本地开发的 HTTP Cookie 只与 HTTP origin 搭配；Test、Preview 与 Production 的 production 构建都强制使用安全 Cookie。生产模式把 Resend 基址固定为官方 HTTPS 地址。校验错误只列配置键名，不输出配置值。

## 上下游

API 与 worker 入口调用 `loadEnv`。`bootstrap/app.ts` 使用公开站点列表建立精确 CORS 边界，认证 handler 与中间件使用显式 Cookie 安全开关；`platform/infra/` 使用其余配置构造数据库、Redis、对象存储、邮件和大模型客户端。

开发和测试环境保留本地基础设施默认值，但邮箱认证调用仍需要显式注入 Resend 与 HMAC 配置。`RESEND_API_BASE_URL` 只允许在开发或测试环境指向本地 mock，生产环境不能覆盖官方基址。
