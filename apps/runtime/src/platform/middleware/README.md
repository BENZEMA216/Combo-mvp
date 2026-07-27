# platform/middleware —— 鉴权中间件

这个目录把共享浏览器会话校验封装为可挂在业务端点前的守卫。守卫按 `SESSION_COOKIE_SECURE` 选择 Cookie：true 只接受主机限定的 `__Host-cb_session`，false 只接受 `cb_session`，并把查到的业务用户身份挂到 `req.auth`。它不会在两个 Cookie 名之间回落。

## 文件

- `auth.ts` 提供 `requireAuth` 和 `requireSseAuth`。普通请求和流式请求带任何 `Authorization` 头，或带 `token` 与 `access_token` 查询参数，都会返回 401，不会回落到 Cookie。流式请求会在建立响应流之前完成同一套 PostgreSQL 会话查询。缺失、畸形、未知、过期或已撤销会话返回 401，停用账号返回 403，数据库不可用返回 503。有效请求保留共享 `AuthContext` 的 `userId`、`account` 与 `roles`。

## 上下游

能力、会话和产物路由把守卫放在各自的前置处理链中。会话流路由使用流式请求专用守卫，其余业务路由使用普通守卫。

本目录调用 `platform/infra/auth-session.ts` 读取会话，并使用 `platform/http/_helpers.ts` 返回统一错误信封。鉴权上下文与 Cookie 常量来自 `@cb/shared`。
