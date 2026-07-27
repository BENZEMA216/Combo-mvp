# modules/capability — 能力项

这个模块负责能力项的查询与发布。能力项是提取流水线从对话历史里归纳出的可复用工作流，capabilities 表只存名称、摘要等轻量索引，完整可运行定义存在 MinIO 里（表里记对象键 storage_key）。

## 文件

- `routes.ts` 声明四个端点。两个 GET 查询要求登录；发布与取消发布先校验精确浏览器来源，再校验 Cookie 会话。
- `handlers.ts` 是薄壳：校验分页游标和参数，调 repo，包统一响应信封；publish 时生成加密随机的 URL 安全分享令牌（share_token）传给 repo。
- `index.ts` 是本域对外出口：业务域之间只能经它互引（当前只导出 insertCapability，供 task 域流水线落库）。
- `repo.ts` 收拢 capabilities 表 SQL：insertCapability（供流水线落库）、readCapabilityView、listCapabilityViews（按 id 倒序的游标分页）、publishCapability（置 published 并在没有 share_token 时补上，已有则保留旧值让分享链接稳定）、unpublishCapability（取消发布但保留 share_token）。所有查询都把 owner_user_id 写进 WHERE 条件，非本人和不存在同样返回 0 行，不暴露资源存在性。

## 上下游

被谁使用：路由由 `bootstrap/routes.ts` 挂载；`modules/task/pipeline.ts` 在流水线落库阶段经本域 `index.ts` 出口调 insertCapability；`modules/task/repo.ts` 的任务视图 SQL 里子查询统计本表的能力项数。

依赖什么：`platform/http/_helpers.ts`（错误信封）、`platform/http/browser-origin.ts`（浏览器写请求来源守卫）、`platform/middleware/auth.ts`（登录守卫）、`platform/infra/db.ts`（Queryable 类型与 toIso 时间格式化）。外部资源只有 PostgreSQL 的 capabilities 表；本模块自己不读写 MinIO，定义文件由流水线写入。

## 典型流程：POST /capabilities/:capabilityId/publish（发布能力项）

1. 请求先过 `platform/http/browser-origin.ts` 的来源守卫，再由 `platform/middleware/auth.ts` 校验不透明 Cookie 并把业务用户 id 注入 req.auth。
2. `handlers.ts` 的 publishHandler 从路径取 capabilityId，用 node:crypto 生成一个 24 字节的 base64url 分享令牌。
3. 调 `repo.ts` 的 publishCapability，一条 UPDATE 语句把该行（且 owner_user_id 等于当前用户）置为 published=true、写入发布时间，share_token 为空时才写入新令牌。
4. UPDATE 命中 0 行说明能力项不存在或不属于当前用户，handler 统一返回 404；命中则把发布状态和 share_token 包进响应信封返回 200。
