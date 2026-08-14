# modules 业务模块层

这个目录按领域保存 Runtime 业务代码。

- `capability/` 负责能力列表、权限判断、定义加载和格式校验。
- `session/` 负责普通与 Studio Session、Message 的仓储、输入校验和 HTTP 处理。
- `artifact/` 负责 Artifact 索引、正文对象、Studio HTML 契约、UI 快照和可信的 `upsert_artifact` 工具。
- `agent/` 负责单 Session 单运行 Turn、Pi Agent、Studio 终态提升、Redis 事件流和可选远程沙箱工具。
- `billing/` 负责每用户每 Agent 的免费额度、全局钱包预留、用量幂等和终态资金处理。
- `creator-agent-conversation/` 提供默认关闭的邀请制 Creator-hosted Agent create groundwork：consumer-only DB authority、Version/Lease/Fence 绑定、`OPENING + conversation.open` 原子创建、exact ready projector、幂等 Conversation 创建和 VNext HTTP 契约。所有受支持部署都保持 `CREATOR_AGENT_PUBLIC_ENABLED=false`，撤权、限额/TTL 与完整消息体验落地前不得启用。

Session 处理器会调用 capability 加载器和 agent 编排器。Agent 编排器在创建 Turn 前预留免费额度或钱包，在终态事务中结算或释放；随后读取 Session 历史并使用 Artifact 工具。Studio Session 还会使用独立提示协议，并在成功终态更新当前 UI。启用沙箱时，Agent 编排器会调用平台层的 SandboxBackend。沙箱工具不新增业务路由或数据表，现有 Session、Turn、Message、SSE、Artifact 和资金流水仍是执行与持久化真源。
