# platform/infra 外部资源与沙箱客户端

这个目录封装 Runtime 使用的数据库、Redis、对象存储、不透明会话、模型选择和可选沙箱基础设施。功能关闭时只创建禁用的 SandboxBackend，不加载 Kubernetes 客户端，也不读取集群配置。

## 基础设施文件

- `index.ts` 组装数据库、对象存储、Redis 事件设施、SandboxBackend 和可选的 visible-transcript Test key binding。公开 flag 关闭时不加载 adapter 模块，也不读取 keyring。
- `db.ts` 封装 PostgreSQL 连接池、可取消事务、事务级锁等待和语句超时、就绪探针与关闭逻辑。VNext 专用池的 readiness 同时证明 exact `combo_agent_consumer_api` direct login、NOSUPERUSER/NOBYPASSRLS、双向零 role membership、当前数据库 `CONNECT=true`/`CREATE=false`/默认 session-local `TEMP=true`、零 public sequence capability，以及只允许 create-open-v2 与 Consumer message full-accept 两个 `SECURITY DEFINER` 的精确正负 capability 集。
- `auth-session.ts` 校验不透明 Cookie 格式，计算 SHA-256 摘要并只读联查 `auth_sessions` 与 `users`。未知、过期和撤销会话收口为无效状态，停用账号单独返回。
- `redis.ts`、`redis-interrupt-bus.ts`、`redis-event-log.ts` 和 `event-bus.ts` 负责 Redis 连接、跨实例打断、事件日志、终态栅栏和实时直播。
- `object-store.ts` 封装 MinIO 或 S3 对象读写，并把中止信号传给 S3 客户端。
- `llm.ts` 负责模型来源、模型编号和 Runtime 内凭据选择。
- `visible-transcript-test-kms.ts` 是仅限 `COMBO_ENVIRONMENT=test` 的 Kubernetes Secret 文件 adapter。它用 Node `fs` 只读加载严格、版本化 keyring，以 500ms 和调用方 `AbortSignal` 的较早者为截止时间；先用固定 KDF domain 将 root key 派生到 Creator + AgentVersion，再对已有 visible-transcript domain bytes 做 HMAC-SHA-256。每次操作重新读取 active version，readiness 也验证当前 keyring；异常只暴露稳定的无敏感信息错误。

这个 adapter **不是 production KMS，也不是真实云 provider**：root key 会在一次计算期间进入 Runtime 进程内存，只能用于 Test 集群联调。Preview 与 Production 没有对应 bootstrap provider。生产边界仍要求一个不导出 raw key、能在服务端完成 HMAC、支持租户/版本轮换和真实凭据 contract test 的外部 authority；在选定并验证腾讯云侧能力前，该项保持 BLOCKED，不能用内存 fake 或 Test Secret 文件替代。

## 沙箱文件

- `sandbox-backend.ts` 定义四个模型工具的远程端口、稳定错误和默认禁用实现，不提供宿主实现。
- `sandbox-capability.ts` 使用 Runtime 内的 Ed25519 私钥，为单次请求签发绑定 Session、Pod UID、Turn、操作和正文摘要的短期令牌。
- `sandbox-client.ts` 调用 sandboxd 的 JSON 与 NDJSON 协议，并限制超时、线路大小、帧数量和原始输出。
- `kubernetes-sandbox-backend.ts` 使用 PVC 资源版本竞争固定槽位，校验 Pod 身份与安全规格，并在节点确认容器终止后才释放槽位。

每次文件或命令操作前都会确认 owner、active Session 和 running Turn。取消、断流或协议失败后若无法确认远程清理，PVC 会保持隔离，当前 Turn 也不会错误释放。浏览器会话与沙箱能力令牌彼此独立。
