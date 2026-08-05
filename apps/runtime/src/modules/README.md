# modules 业务模块层

这个目录按领域保存 Runtime 业务代码。

- `capability/` 负责能力列表、权限判断、定义加载和格式校验。
- `session/` 负责普通与 Studio Session、Message 的仓储、输入校验和 HTTP 处理。
- `artifact/` 负责 Artifact 索引、正文对象、Studio HTML 契约、UI 快照和可信的 `upsert_artifact` 工具。
- `agent/` 负责单 Session 单运行 Turn、Pi Agent、Studio 终态提升、Redis 事件流和可选远程沙箱工具。
- `agent-project/` 负责 Revision-pinned Test、Test 终态收口和从当前 Release 创建固定版本会话。

Session 处理器会调用 capability 或固定 Agent Revision 加载器和 agent 编排器。Agent 编排器会读取 Session 历史并使用 Artifact 工具；Studio Session 还会使用独立提示协议，并在成功终态更新当前 UI。Agent Project 会话显式保存 Revision 和 Release，旧会话不追随新的 Head。启用沙箱时，Agent 编排器会调用平台层的 SandboxBackend。
