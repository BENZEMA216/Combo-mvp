# modules 业务模块层

这个目录按领域保存 Runtime 业务代码。

- `capability/` 负责能力列表、权限判断、定义加载和格式校验。
- `session/` 负责普通与 Studio Session、Message 的仓储、输入校验和 HTTP 处理。
- `artifact/` 负责 Artifact 索引、正文对象、Studio HTML 契约、UI 快照和可信的 `upsert_artifact` 工具。
- `agent/` 负责单 Session 单运行 Turn、Pi Agent、Studio 终态提升、Redis 事件流和可选远程沙箱工具。

Session 处理器会调用 capability 加载器和 agent 编排器。Agent 编排器会读取 Session 历史并使用 Artifact 工具；Studio Session 还会使用独立提示协议，并在成功终态更新当前 UI。启用沙箱时，Agent 编排器会调用平台层的 SandboxBackend。沙箱工具不新增业务路由或数据表，现有 Session、Turn、Message、SSE 和 Artifact 仍是执行与持久化真源。
