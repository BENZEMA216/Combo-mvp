# platform/http — HTTP 公共工具

这个目录放路由注册、错误信封、认证请求边界、健康检查和浏览器观测上报等公共 HTTP 工具。

## 文件

- `_helpers.ts` 提供统一错误信封回复、端点声明和批量注册。端点声明可以附加请求期钩子、前置守卫、路由级请求体上限和 Fastify 路由配置。
- `auth-request.ts` 为四条认证路由在请求体解析前设置 `Cache-Control: no-store`，并要求三条认证 POST 使用 `application/json` 与四 KiB 请求体上限。
- `browser-origin.ts` 读取已经严格校验的 `PUBLIC_APP_ORIGINS` 列表，为 CORS 只反射其中的精确 origin，并要求认证接口及所有 Cookie 鉴权业务写请求携带列表中的完整 `Origin`。请求若带 `Sec-Fetch-Site`，其值只能是 `same-origin`；配对码鉴权的助手上传接口不使用这个浏览器守卫。
- `health.ts` 注册 `/health` 与 `/ready`。就绪探针检查 PostgreSQL、双 Redis 和 MinIO，大模型只影响降级状态；Resend 不参加就绪判定。
- `client-events.ts` 接收浏览器错误事件，但日志只保留事件类型、关联 traceId 和服务端固定的低基数路由桶。客户端 URL 与 route 只参与分类，原始 pathname、动态段、查询、消息和堆栈都不会写入日志；无法识别时只记录 `unknown`。
- `fastify.ts` 为 Fastify 声明基础设施容器和请求鉴权上下文类型。

## 上下游

`bootstrap/app.ts` 注册 CORS、错误处理和健康检查。四个业务模块通过 `_helpers.ts` 注册路由。浏览器接口返回安全错误信封，account 模块额外使用认证请求与来源守卫；billing 的支付通知使用乐收赢要求的固定成功或失败响应，不使用浏览器错误信封。共享包 `@cb/shared` 提供错误分类、traceId 和健康检查契约。
