# apps/authz — V2 用户体系

这个服务负责终端用户的登录、session 管理和身份断言签发，是平台四个中台里的「用户体系」。验证期的登录方式是开发态 OTP（万能码），真实短信通道与微信授权在后续迭代接入。终端用户身份域使用 `v2_` 前缀的表，与 V1 创作者域的 `auth_` 表互不引用。

## 文件

- `src/index.ts` 是进程入口，加载配置、装配 PostgreSQL 连接池与 Redis 客户端，启动 HTTP 监听并处理优雅停机。
- `src/env.ts` 解析并校验全部环境变量，进程其余部分只读结构化配置。
- `src/crypto.ts` 是认证原语：手机号规范化、目标与验证码的域分离 HMAC 摘要、不透明会话 Cookie 的生成与摘要。数据库和 Redis 只接触摘要。
- `src/service.ts` 是登录与 session 的业务逻辑：请求 OTP、校验 OTP（首次登录自动建用户与手机号身份）、解析会话（Redis 缓存优先，未命中回源 PostgreSQL 并回填）、登出撤销。依赖以端口注入，测试用内存假实现。
- `src/repo.ts` 是持久层端口在 pg.Pool 上的实现，SQL 与 `db/migrations/0012_v2_end_user_identity.sql` 一一对应。
- `src/cache.ts` 是会话读路径的 Redis 缓存实现，所有方法吞错降级，缓存永远不当事实源。
- `src/assertion.ts` 签发 JWT(EdDSA) 断言并导出 JWKS 公钥。断言只带身份（sub 是用户主键、aud 是 agent_id、iss、exp），不带权益。
- `src/login-page.ts` 是最简登录页：自包含 HTML（内联 CSS/JS，无框架无构建），以及 `next` 参数的站内路径收敛（防开放跳转）。
- `src/app.ts` 装配 Fastify 路由与 Cookie，进程入口和测试共用同一份装配。
- `src/__tests__/` 是不依赖外部服务的 vitest 测试，`fakes.ts` 提供复刻持久层与缓存语义的内存假实现。

## 接口

- `GET /authz/login` 返回登录页（手机号 + 验证码两步，页面调 OTP 接口）。`?next=` 只接受同站相对路径，外域、协议相对与畸形值一律收敛为 `/`；已登录用户访问直接 302 到 next。
- `POST /authz/otp/challenges` 按手机号创建验证码挑战（202）。开发态把万能码摘要写入挑战，挑战五分钟有效、同一手机号同一时间最多一个未完成挑战。
- `POST /authz/otp/verifications` 校验验证码（200）。错误码 401、格式错误 400；成功后种共享域会话 Cookie（`cb_v2_session`，不透明 token，七天），首次登录自动建号。
- `POST /authz/logout` 撤销会话并清除 Cookie（200），无会话与重复调用都成功。
- `GET /authz/assert?agent_id=...` 验会话 Cookie 并签发断言（200）。断言同时放在响应头 `x-combo-assertion`（供 Traefik ForwardAuth 的 authResponseHeaders 注入）和响应体里；未登录 401、agent_id 缺失或非法 400。
- `GET /.well-known/jwks.json` 暴露 Ed25519 验签公钥（含 kid），各 Agent 的 SDK 用它验签并强制 audience 等于自己的 agent_id。
- `GET /health` 与 `GET /ready` 是健康与就绪探针，就绪探针实际检查 PostgreSQL 与 Redis 可达性。

## 上下游

上游是 Traefik 的 ForwardAuth 与浏览器直连。下游是 PostgreSQL（`v2_users`、`v2_identities`、`v2_auth_challenges`、`v2_sessions`，使用专用角色 `combo_authz`）和 Redis（session 缓存，key 前缀 `authz:v2:session:`）。断言私钥从环境变量 `AUTHZ_ASSERTION_PRIVATE_KEY` 读入（PEM 或 base64 DER 的 Ed25519），万能码从 `AUTHZ_DEV_OTP_CODE` 读入（六位数字，未配置时登录接口返回 503），共享域从 `AUTHZ_SESSION_COOKIE_DOMAIN` 读入。
