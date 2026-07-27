# apps/runtime（能力运行与界面设计后端）

Runtime 是 Capability 试用与 Studio 编辑的独立后端。它管理普通与 Studio Session、Turn、Message、Artifact、当前 UI 指针和 Redis SSE，并在接收请求的实例内异步运行 Pi Agent。同一个 Session 同时最多只有一个 `running` Turn，并发提交返回稳定的 `SESSION_BUSY` 409 错误信封。

## 服务边界

Runtime 与 authoring 共用 PostgreSQL 和对象存储，但不引用 authoring 源码。它只读 `users`、`auth_sessions` 和 Capability 定义，读写 `sessions`、`turns`、`messages`、`artifacts`，并且只能更新 `capabilities.ui_artifact_id`。浏览器认证只接受 authoring 签发的不透明会话 Cookie：`SESSION_COOKIE_SECURE=true` 时读取 `__Host-cb_session`，为 false 时读取 `cb_session`。Runtime 只计算 Cookie 摘要并查询 PostgreSQL，不签发会话、不创建用户，也不接受 Bearer 或查询参数令牌。

所有浏览器写请求必须来自 `PUBLIC_APP_ORIGINS` 的严格白名单。凭据型 CORS 也只反射其中的精确 origin。Preview 与 Production 必须使用 Secure Cookie；以 production 模式运行的 Test 可以显式使用非 Secure Cookie。模型、模型凭据、Pi 会话和流式事件都留在 Runtime 内。

## 源码结构

- `src/platform/` 保存配置、数据库、Redis、对象存储、不透明会话读取、模型选择、沙箱后端、HTTP 公共设施和观测接线。
- `src/modules/capability/` 负责 Capability 列表、归属判断、发布可见性和定义加载。
- `src/modules/session/` 负责普通与 Studio Session、Message、详情快照和 HTTP 处理。
- `src/modules/agent/` 负责 Turn 生命周期、Pi Agent、Redis 事件流、Studio 模式和模型工具。
- `src/modules/artifact/` 负责 Artifact 索引、对象正文、Studio HTML 契约、UI revision 和 `upsert_artifact`。
- `src/bootstrap/` 组装 Fastify、基础设施、TurnRunner 和路由。
- `src/processes/api.ts` 是唯一 HTTP 进程入口，默认监听 3100。

## Turn、Artifact 与恢复

Turn 创建受数据库部分唯一索引保护。终态状态、错误和消息先在 PostgreSQL 事务中提交，随后才按 `runId` 幂等写入 Redis 终态。普通事件在写入前确认对应 Turn 仍为 `running`；刷新连接可按 `Last-Event-ID` 补发后继续直播。

`upsert_artifact` 先写不可变对象，再只在绑定 Turn 仍运行时提交带来源 Turn 的索引。Studio Turn 只有完整成功后，最后一个合格 HTML revision 才能在同一终态事务中晋升为 Capability 当前 UI。详情只展示种子副本、每个成功 Turn 的最终 revision 和 active Turn 的最新候选；失败或中断 Turn 的 Artifact 不进入历史。普通 Session 会复制创建时的 UI 隔离副本，不随之后的 Studio 修改漂移。

详情的 owner 复验、Message、Artifact、当前 UI 和 active Turn 来自同一条 `REPEATABLE READ READ ONLY` PostgreSQL 快照。Capability 定义在快照结束后再从对象存储读取。

## 可选沙箱工具

`SANDBOX_TOOLS_ENABLED` 默认关闭。开启后，模型的 `read`、`write`、`edit` 和 `bash` 只调用独立 sandboxd Pod，不访问 Runtime 宿主文件系统，也没有宿主回退。镜像必须由 SHA-256 摘要固定，RuntimeClass 固定为 `gvisor`，能力令牌按 Session、Pod UID、Turn、操作和正文摘要短期签发。

普通容量是四个固定 PVC 槽位。第五槽只在独立维护清单和显式验证开关都生效时允许分配。节点终止无法确认时，PVC 保持隔离，不能被其他副本复用。

## 验证

```sh
pnpm -F @cb/shared build
pnpm -F @cb/runtime typecheck
pnpm -F @cb/runtime typecheck:test
pnpm -F @cb/runtime test
```

需要 PostgreSQL 或 Redis 的集成测试只有在显式提供专用测试连接时运行，不能指向生产资源。
