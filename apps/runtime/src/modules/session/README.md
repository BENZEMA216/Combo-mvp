# modules/session 会话域

这个目录管理普通与 Studio Session、Message、详情恢复和会话 HTTP 端点。所有查询都按已认证用户执行 owner 隔离，不存在与不属于当前用户的资源使用同一类响应。

## 文件

- `routes.ts` 声明 Session 端点。读取端点要求 PostgreSQL 不透明会话；POST、PATCH 和 DELETE 还要求请求 `Origin` 精确命中 `PUBLIC_APP_ORIGINS` 白名单。SSE 在建流前使用同一会话查询，并拒绝 Bearer 和查询参数令牌。
- `handlers.ts` 校验输入与 `usageId`、执行 owner 检查并加载 Capability。v2 开会话会先解析 exact Package，发消息时再与 Session 冻结绑定核对。余额不足时在 Turn、Message 和 charge 之前返回不含内部错误的 402 充值业务体。
- `repo.ts` 保存 Session 与 Message 的 SQL、Studio Session 原子复用、归档、锁定、UI 隔离副本和 knowledge Release/Package/resource 一次冻结。
- `detail.ts` 在一条 `REPEATABLE READ READ ONLY` 连接内读取 owner、Message、Artifact、当前 UI、active Turn 与权威 receipt。知识会话只投影 user Message 和验证过的 `knowledgeResults`，不从候选 assistant/tool transcript 猜测结果。
- `message-content.ts` 校验并规范化 Pi 原生消息块，拒绝无法持久化的内容。

Studio 详情展示种子副本、每个 completed Turn 的最终 Artifact 和 active Turn 的最新候选。失败或中断 Turn 的 Artifact 不进入 revision 历史。普通 Session 固定使用创建时复制的 UI，不随 Capability 当前 UI 变化。
