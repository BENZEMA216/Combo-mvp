# modules 业务模块层

这个目录按领域保存 Runtime 业务代码。

- `capability/` 负责能力列表、权限判断、定义加载和格式校验。
- `session/` 负责普通与 Studio Session、Message 的仓储、输入校验和 HTTP 处理。
- `artifact/` 负责 Artifact 索引、正文对象、Studio HTML 契约、UI 快照和可信的 `upsert_artifact` 工具。
- `agent/` 负责单 Session 单运行 Turn、Pi Agent、Studio 终态提升、Redis 事件流和可选远程沙箱工具。
- `billing/` 负责每用户每 Agent 的免费额度、全局钱包预留、用量幂等和终态资金处理。
- `knowledge-agent/` 负责受控 Test 的 exact Agent Package 解析、固定知识检索、平台验证、原子终态和可信结果投影。

Session 处理器会调用 capability 加载器和 agent 编排器。legacy Agent 编排器在创建 Turn 前预留免费额度或钱包，随后读取 Session 历史并使用 Artifact 工具；Studio Session 还会使用独立提示协议，并在成功终态更新当前 UI。受控知识 Agent 会从 Registry 和固定 Package 对象解析知识资源，把 Release 与资源摘要冻结进 Session，并且只在平台验证通过后结算。启用沙箱时，legacy Agent 编排器会调用平台层的 SandboxBackend；知识工具不使用沙箱。Session、Turn、Message、SSE、Artifact、用量记录、receipt 和资金流水是执行与持久化真源。
