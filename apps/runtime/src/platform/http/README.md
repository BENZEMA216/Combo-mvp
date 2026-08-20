# platform/http HTTP 公共设施

这个目录保存不属于具体业务模块的路由工具、浏览器来源边界、统一错误回复、Fastify 类型增强、健康检查、发布版本和浏览器事件端点。

- `_helpers.ts` 定义端点声明、批量注册和共享错误信封。
- `browser-origin.ts` 用与 authoring 相同的严格语法解析 `PUBLIC_APP_ORIGINS`，为凭据型 CORS 只反射白名单成员，并拒绝其他跨站或同站子域发起的 Cookie 鉴权写请求。
- `fastify.ts` 为 Fastify 增加 `app.infra`、`app.turns` 和 `req.auth` 类型。
- `health.ts` 注册 `/health` 与 `/ready`，检查数据库、对象存储和 Redis。Creator Agent 公开 flag 开启时，专用数据库与 `visible_transcript_kms` 都是 required；keyring 缺失、超时或不合法会返回 503。flag 关闭时不探测 keyring。模型密钥缺失只产生降级状态。
- `version.ts` 从经过共享 schema 校验的发布元数据生成 `/version.json`。
- `client-events.ts` 只记录事件类型、traceId 和固定低基数路由桶，不保留原始地址、用户输入、查询参数或凭据。
- `vnext-json-body.ts` 只供 encapsulated VNext route plugin 注册 Buffer JSON parser：仅允许 `application/json` 加可选单一 UTF-8 charset及缺失/identity Content-Encoding，复用 Runtime 既有 4 MiB ceiling，fatal 解码 UTF-8、拒绝 duplicate key，并把所有失败清洗为无 input/issues/cause 的稳定 400。它不得注册到 root Fastify 或 legacy `/api/v1` sibling。

Runtime 不暴露浏览器可调用的沙箱管理端点。sandboxd 协议只在 Pod 网络内由 SandboxClient 使用。
