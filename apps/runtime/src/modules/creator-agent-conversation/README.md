# Creator-hosted Agent Conversation 模块（默认关闭）

本目录是不可公开启用的 expand-only groundwork。`repo.ts` 使用 exact `combo_agent_consumer_api`，在单个 PostgreSQL transaction 中校验邀请授权、Deployment、serving AgentVersion、exact Worker Lease/Fence 和幂等请求，再调用窄 `creator_agent_create_opening_conversation_v2` definer 原子创建固定 Version/Worker 的 `OPENING` Conversation 与 payload-v1 `conversation.open` Outbox command。`handlers.ts` 只接受 ADR-VNEXT-033 的 canonical lowercase UUIDv4 `Idempotency-Key`，解析冻结 HTTP schema、调用仓储并返回稳定错误；Server ID 仍是 UUIDv7。`routes.ts` 定义当前唯一 VNext ingress `/v1/public/agents/:slug/conversations`；只有 `CREATOR_AGENT_PUBLIC_ENABLED=true` 才注册。该 route child plugin 只接受 case-insensitive `application/json`，可带至多一个 `charset=utf-8`（允许 OWS 与 quoted `utf-8`），Content-Encoding 只允许缺失或 `identity`；它用 Buffer content parser 在任何 preHandler 前执行 fatal UTF-8 decode 与 duplicate-key scan，再按 Origin、body schema、Auth 的顺序进入业务边界。其他 media type/parameter/encoding，以及 malformed、duplicate、unknown 或超限 body，都返回不附带 parser input/issues/cause 的 `INVALID_INPUT`，且不会进入 auth/Creator PostgreSQL 或 Conversation/Outbox transaction。parser 继续复用 Runtime 既有 4 MiB body ceiling；这不是新冻结的 VNext body-size policy。所有受支持部署都保持 false，false 时专用连接池不初始化且 readiness 不依赖它。

公开 slug 只用于定位 Agent。没有有效 `agent_access_grants` 行、Deployment 未真正 ONLINE、版本不可用或 Lease/Fence 不匹配时不会创建 Conversation。当前 route 的 body preHandler 使用 Protocol 提供的具名 public-request boundary；同一 boundary已覆盖冻结OpenAPI的9个request root并统一把任何Zod/refinement异常转换为不携带input、issues或cause的固定错误。未实现的8个root目前只形成Schema证据，不代表route或durable副作用已经实现。当前目录只实现默认关闭的 Conversation create groundwork；发送消息、读取 transcript、SSE、取消和重试由后续同一 VNext 模块补齐。

fresh create 还必须从 Runtime infrastructure 取得 `VisibleTranscriptDigester`。它把 RFC 8785 JCS `{protocol:'combo.visible-transcript/1',schemaVersion:1,agentVersionId,messages:[]}` 的 bytes 加在 exact domain `combo:vnext:visible-transcript:v1\0` 后交给 Creator + AgentVersion scoped KMS HMAC port；只接受 port 返回的 32-byte MAC、`keyId`、`keyVersion` 和 `keyRef`，并把格式化 digest 与 key metadata 传给同一 transaction 内的 v2 definer。公网 body 没有 digest 字段，数据库不存 key。

Runtime 目前只为 `COMBO_ENVIRONMENT=test` 接入 `test-k8s-secret-file`：它从只读 Secret volume 加载 versioned root key，并以独立 KDF domain 派生 Creator + AgentVersion scoped key。500ms 超时、严格 keyring、最低版本、keyRef prefix 和 readiness 都失败关闭；flag 关闭时零 keyring 读取。它不是 production KMS 或真实云 provider，因为 root key 仍进入 Runtime 内存。Preview/Production 无 provider；生产 HMAC authority 与真实凭据 contract test 仍然 BLOCKED，不能用本 adapter 或内存 fake 冒充上线证明。不存在 env raw key、默认 key或本地 fallback。

当前创建 `expires_at` 初值为 30 天，与 ADR-VNEXT-012 的「最后活动后 30 天」在线保留上限一致；参数只供内部测试注入，不来自 HTTP。发送消息模块仍须在同一事务里更新活动时间与到期时间，并在 Alpha 前补充独立 authority 决策，明确「可继续对话」与「只读保留」何时分界。

本切片不开放授权撤销写路径，也不授予 API 角色修改 `agent_access_grants` 的权限。后续撤销实现必须在一个权威事务中同时处理新 Conversation 禁止、已有 Conversation 只读/挂起、进行中 Invocation 取消及 Consumer 事件；在该原子状态机落地前，不能把单行 `ACTIVE -> REVOKED` 更新冒充完整撤销。

`creator_agent_commit_conversation_ready_fact(...)` 是 0017 的冻结 Gateway projector 边界：它以原始 `conversation.open` command、原始 Session/Lease authority 和 canonical ready fact 落 immutable receipt；exact fact replay 不依赖当前 replacement transport，冲突事实拒绝。0018 进一步把 original assignment authority 固定在 payload v1，同时把重连后的 current delivery Session/Lease 绑定在 outbound frame；同一稳定 command/message ID 可以跨 replacement Session 重投，Host/ready authority仍只提交一次。应用角色直接执行 `OPENING -> IDLE` 被数据库 trigger 拒绝。

任何环境改为 true 前，仍必须一次性完成并验证：

1. grant revoke 与 create/send/dispatch 的同事务锁序、能力撤销和已有 Conversation `SUSPENDED` 收敛；
2. 滑动 30 天 TTL、deadline 硬检查、20 turns 与 64 KiB visible-history 上限；
3. 公网 API/WSS、Cloud Journal、Worker sandbox open/ready 与 Consumer browser E2E。

因此本目录的测试只证明默认关闭边界、HTTP wire 契约、visible-transcript HMAC primitive、create/open/ready 的 PostgreSQL authority、并发幂等和 fault rollback；不证明 production KMS adapter 或 Consumer Experience Gate。

当前 raw-body 证据用真实 loopback HTTP 覆盖上述 media-type/encoding allowlist、五类 malformed UTF-8、BOM、root/nested duplicate、syntax、escaped surrogate/control、unknown key 与声明的 Content-Length 4 MiB + 1；helper 另以实际 N/N+1 bytes 锁定同一 ceiling。它没有新增压缩 Content-Encoding 接受语义，也不把 chunked/slowloris、Ingress proxy、public TLS 或负载测试冒充已完成 Gate。
