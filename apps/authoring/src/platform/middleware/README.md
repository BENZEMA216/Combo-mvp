# platform/middleware — 本地会话鉴权

这个目录放受保护请求的前置鉴权守卫。浏览器凭据只有一枚 PostgreSQL 不透明会话 Cookie。

## 文件

- `auth.ts` 提供 `requireAuth`、`requireSseAuth` 和资源归属判断。两个守卫按 `SESSION_COOKIE_SECURE` 只读取 `__Host-cb_session` 或 `cb_session` 中的一种，通过 `platform/infra/auth-session.ts` 查询有效会话与用户，并把业务用户编号、账号和角色写入 `req.auth`。安全入口不会回落到可由父域投放的无前缀 Cookie。缺失、畸形、未知、过期或已撤销会话返回 401，停用账号返回 403，数据库故障返回 503。任何 `Authorization` 头以及名为 `token` 或 `access_token` 的查询参数都被拒绝。

## 上下游

account 的 `/me`、task 与 capability 的受保护路由使用 `requireAuth`。任务进度事件流使用 `requireSseAuth`，因此失败发生在流式响应建立之前。中间件依赖本地 PostgreSQL 会话读取和统一错误信封，不访问邮件、Redis 或外部身份供应商，也不创建业务用户。
