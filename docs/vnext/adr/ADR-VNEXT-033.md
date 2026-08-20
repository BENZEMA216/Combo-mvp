<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-033: Client idempotency identity uses canonical UUIDv4

- Status: accepted
- Owner: Protocol
- Decision date: 2026-08-18

## Decision

Public Creator/Consumer HTTP 的九个 Idempotency-Key、send clientMessageId 与 retry clientMessageId 共用独立 ClientIdempotencyKeySchema，只接受36字符 canonical lowercase RFC 9562 UUIDv4；服务端 ID 继续使用 UUIDv7。send/retry 的 header 与 body alias 必须逐字相同。客户端对一次逻辑操作只生成并持久化一个 key，HTTP timeout、断网、double-submit 与 transport retry 必须复用；用户显式创建新消息或获准 Retry 时生成新的 UUIDv4，并另以 retryOfInvocationId 关联旧 Invocation。Key 是 opaque dedupe input，不是 credential、时间、排序或授权材料；唯一性按 authenticated principal 加 operation/resource scope 建立，并与 requestDigest 绑定，同 key 不同 digest fail closed。持久层可保留 bounded text/uuid 兼容形态以 exact replay 已有 Test-only legacy 行，但只有 replay 查询命中后可返回旧事实，fresh admission 必须通过 UUIDv4；public API 不暴露 legacy 例外。PostgreSQL uuid 类型会在 trigger 前规范化文本，因此 Conversation DB trigger只证明版本位，canonical lowercase由HTTP parser证明；Message text authority同时证明版本与canonical形式。日志只记录域分离hash，key不进入模型输入。

## Alternatives considered

- UUIDv7 only；拒绝，因为浏览器没有原生生成接口，客户端时钟与排序不具权威性，并会把服务端 ID 语义错误带入 dedupe input。
- UUIDv4 或 UUIDv7；拒绝，因为只为现有 Test fixture 扩大永久 public 验证面，并保留不可使用的时间排序暗示。
- Generic UUID 或任意字符串；拒绝，因为会接受无关版本、大小写别名和不一致 validator 语义，无法形成 exact contract。

## Evidence

- http-idempotency-key-boundaries.v1.json runtime JSON Schema and OpenAPI parity
- Nine OpenAPI headers share one component; send/retry aliases publish equivalent constraints and binding extensions
- 0022 fresh UUIDv4 and legacy replay-only PostgreSQL tests
- Browser timeout double-submit and offline retry key-reuse tests remain required with the future send/retry routes

## Privacy and security impact

UUIDv4 提供122位 CSPRNG 随机空间；碰撞或恶意复用只能命中同 scope 的 replay/conflict，不能覆盖旧 requestDigest、绕过 RLS/tenant FK、创建第二次推理或充当授权。Canonical lowercase 格式消除文本别名；key hash 仍不替代 AEAD、鉴权或 Execution Capability。

## Reversal triggers

- 新 public protocol version 提供迁移与兼容证据，并证明另一种 client identity 在真实规模下有必要且不会被用于排序或授权。
- 浏览器原生能力变化本身不足以反转；必须同时通过 runtime OpenAPI DB Broker Worker 和产品重试 Gate。

## Affected protocol versions

- combo.creator-agent-http/1
- combo.creator-broker/1
