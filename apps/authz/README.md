# apps/authz — V2 用户体系

这个服务负责终端用户的登录、session 管理和身份断言签发，是平台四个中台里的「用户体系」。登录方式是邮箱验证码：production 强制配置 Resend 并只接受当前邮件挑战；非 production 未配置 Resend 时可以用 `AUTHZ_DEV_OTP_CODE` 生成固定码挑战，但同样受次数、时限与邮箱/客户端双维限流约束，不存在无挑战万能旁路。微信授权在后续迭代接入。终端用户身份域使用 `v2_` 前缀的表，与 V1 创作者域的 `auth_` 表互不引用。

## 文件

- `src/index.ts` 是进程入口，加载配置、装配 PostgreSQL 连接池、Redis 客户端、OTP 限流与 Resend 发信端口，启动 HTTP 监听并处理优雅停机；启动日志说明当前是真实发信还是固定开发码模式。
- `src/env.ts` 解析并校验全部环境变量，进程其余部分只读结构化配置。
- `src/crypto.ts` 是认证原语：邮箱规范化（trim、小写、单 @ 与 IDNA ASCII 域名校验）、目标与验证码的域分离 HMAC 摘要、随机六位码生成、不透明会话 Cookie 的生成与摘要。数据库和 Redis 只接触摘要。
- `src/service.ts` 是登录与 session 的业务逻辑：请求 OTP 前执行目标级限流；配发信通道时供应商受理才落库随机挑战，永久拒绝返回统一受理结果，暂时或配置故障返回 503；非 production 未配发信时挑战写固定开发码摘要。所有验证码都消费正常挑战。会话每次由 PostgreSQL 核对撤销事实，Redis 只提供缓存提示，因此缓存删除失败也不能恢复已注销 Cookie。
- `src/rate-limit.ts` 用 Redis Lua 原子维护验证码请求与校验的邮箱目标、客户端地址双维计数。邮箱和可信代理解析出的客户端地址分别做域分离 HMAC，Redis 不保存原文；限流器故障时认证入口 fail-closed。
- `src/resend.ts` 是 Resend HTTP 适配器（全局 fetch，无新增依赖）：只对白名单内的收件人错误读取有界错误摘要，投递结果分为受理/永久拒绝/暂时故障/配置故障四类，不把收件人、验证码、密钥或供应商正文交给日志。
- `src/repo.ts` 是持久层端口在 pg.Pool 上的实现，SQL 与 `db/v2-migrations/0012_v2_end_user_identity.sql` 及 `0014_v2_email_login.sql` 一一对应。
- `src/cache.ts` 是会话读路径的 Redis 缓存实现，所有方法吞错降级，缓存永远不当事实源。
- `src/assertion.ts` 签发 JWT(EdDSA) 断言并导出 JWKS 公钥。断言只带身份（sub 是用户主键、aud 是 agent_id、iss、exp），不带权益。
- `src/login-page.ts` 是最简登录页：自包含 HTML（内联 CSS/JS，无框架无构建），以及 `next` 参数的站内路径收敛（防开放跳转）。
- `src/app.ts` 装配 Fastify 路由与 Cookie，进程入口和测试共用同一份装配。
- `src/__tests__/` 是不依赖外部服务的 vitest 测试，`fakes.ts` 提供复刻持久层、缓存与发信端口语义的内存假实现；`resend.test.ts` 用 fetch 桩断言发信请求形态与错误映射。

## 接口

- `GET /authz/login` 返回登录页（邮箱 + 验证码两步，页面调 OTP 接口）。`?next=` 只接受同站相对路径，外域、协议相对与畸形值一律收敛为 `/`；已登录用户访问直接 302 到 next。
- `POST /authz/otp/challenges` 按邮箱创建验证码挑战（202）。配置 Resend 时随机码经邮件投递，供应商永久拒绝也返回统一 202（不暴露邮箱可达性）；非 production 未配置时把固定开发码摘要写入挑战。挑战五分钟有效、同一邮箱同一时间最多一个未完成挑战；同一邮箱六十秒冷却且每小时最多五次，同一客户端每小时最多二十次。Redis Lua 先检查客户端预算，已超限时不再创建任意目标键；超限返回 429 与实际剩余 `Retry-After`。
- `POST /authz/otp/verifications` 校验验证码（200）。错误码 401、格式错误 400；成功后种共享域会话 Cookie（`cb_v2_session`，不透明 token，七天），首次登录自动建号。同一邮箱十分钟最多校验十次，同一客户端十分钟最多五十次；数据库内单挑战仍最多五次。超限返回 429。
- `POST /authz/logout` 撤销会话并清除 Cookie（200），无会话与重复调用都成功。
- `GET /authz/assert?agent_id=...` 验会话 Cookie 并签发断言（200）。断言同时放在响应头 `x-combo-assertion`（供 Traefik ForwardAuth 的 authResponseHeaders 注入）和响应体里；未登录 401、agent_id 缺失或非法 400。
- `GET /.well-known/jwks.json` 暴露 Ed25519 验签公钥（含 kid），各 Agent 的 SDK 用它验签并强制 audience 等于自己的 agent_id。
- `GET /health` 与 `GET /ready` 是健康与就绪探针，就绪探针实际检查 PostgreSQL 与 Redis 可达性。

## 上下游

上游是 Traefik 的 ForwardAuth 与浏览器直连。下游是 PostgreSQL（`v2_users`、`v2_identities`、`v2_auth_challenges`、`v2_sessions`，使用专用角色 `combo_authz`）、Redis（session 缓存与 OTP 限流，key 分别使用 `authz:v2:session:` 与 `authz:v2:otp-rate:` 前缀）和 Resend（登录码邮件投递）。断言私钥从环境变量 `AUTHZ_ASSERTION_PRIVATE_KEY` 读入（PEM 或 base64 DER 的 Ed25519），固定开发码从 `AUTHZ_DEV_OTP_CODE` 读入（六位数字，production 明确拒绝），共享域从 `AUTHZ_SESSION_COOKIE_DOMAIN` 读入。Resend 配置与 V1 同名：`RESEND_API_KEY` 与 `RESEND_FROM_EMAIL` 必须同时配置；production 缺失时启动失败，`RESEND_API_BASE_URL` 缺省为官方端点 `https://api.resend.com`。
