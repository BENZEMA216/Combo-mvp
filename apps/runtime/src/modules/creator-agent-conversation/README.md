# Creator-hosted Agent Conversation 模块（默认关闭）

本目录是不可公开启用的 expand-only groundwork。`repo.ts` 使用 exact `combo_agent_consumer_api`，在单个 PostgreSQL transaction 中校验邀请授权、Deployment、serving AgentVersion、exact Worker Lease/Fence 和幂等请求，再调用窄 definer 原子创建固定 Version/Worker 的 `OPENING` Conversation 与 normalized `conversation.open` Outbox command。`handlers.ts` 只解析冻结 HTTP schema、调用仓储并返回稳定错误。`routes.ts` 定义 `/v1/public/agents/:slug/conversations`；只有 `CREATOR_AGENT_PUBLIC_ENABLED=true` 才注册。所有受支持部署都保持 false，false 时专用连接池不初始化且 readiness 不依赖它。

公开 slug 只用于定位 Agent。没有有效 `agent_access_grants` 行、Deployment 未真正 ONLINE、版本不可用或 Lease/Fence 不匹配时不会创建 Conversation。当前目录只实现默认关闭的 Conversation create groundwork；发送消息、读取 transcript、SSE、取消和重试由后续同一 VNext 模块补齐。

当前创建 `expires_at` 初值为 30 天，与 ADR-VNEXT-012 的「最后活动后 30 天」在线保留上限一致；参数只供内部测试注入，不来自 HTTP。发送消息模块仍须在同一事务里更新活动时间与到期时间，并在 Alpha 前补充独立 authority 决策，明确「可继续对话」与「只读保留」何时分界。

本切片不开放授权撤销写路径，也不授予 API 角色修改 `agent_access_grants` 的权限。后续撤销实现必须在一个权威事务中同时处理新 Conversation 禁止、已有 Conversation 只读/挂起、进行中 Invocation 取消及 Consumer 事件；在该原子状态机落地前，不能把单行 `ACTIVE -> REVOKED` 更新冒充完整撤销。

`creator_agent_commit_conversation_ready(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)` 是冻结的 Gateway projector 边界：只有 current Deployment 的 exact ACTIVE Lease/Fence/non-revoked Worker、SENT open command 和 `OPENING` Conversation 可以在同一事务 append immutable receipt、ACK command 并转 `IDLE`；exact source-event replay 为 mutation-free `REPLAY`，stale/conflict 为 `REJECTED`。应用角色直接执行 `OPENING -> IDLE` 被数据库 trigger 拒绝。

任何环境改为 true 前，仍必须一次性完成并验证：

1. grant revoke 与 create/send/dispatch 的同事务锁序、能力撤销和已有 Conversation `SUSPENDED` 收敛；
2. 滑动 30 天 TTL、deadline 硬检查、20 turns 与 64 KiB visible-history 上限；
3. 公网 API/WSS、Cloud Journal、Worker sandbox open/ready 与 Consumer browser E2E。

因此本目录的测试只证明默认关闭边界、HTTP wire 契约、create/open/ready 的 PostgreSQL authority、并发幂等和 fault rollback；不证明 Consumer Experience Gate。
