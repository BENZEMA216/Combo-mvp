# Creator Agent Protocol

这个包是 Creator-hosted Agent VNext 的跨进程契约真源。云端服务、Creator Worker、Sandbox Supervisor、Creator Console、消费者页面和验收工具应从同一套运行时 Schema、TypeScript 类型与生成产物读取协议，不能在各自应用里复制另一份字段定义。

## 目录职责

- `src/` 定义共享协议（包括 Snapshot Manifest、archive/manifest 两类加密 Envelope、AgentVersion、Broker、Worker Conversation Ready/Invocation durable facts、Sandbox 与 HTTP）、RFC 8785 JSON 规范化、Invocation 状态机、稳定错误和重试策略、Evidence Bundle、不变量、测试注册表，以及 AgentVersion、Snapshot Manifest 总量、单文件、压缩对象和相对路径 UTF-8 bytes 的独立边界证据目录。
- `fixtures/` 保存 Schema、WSS、状态机、canonical digest、AgentVersion、Snapshot Manifest 总量、单文件、压缩对象数值与相对路径 UTF-8 bytes 资源边界和 Evidence Bundle 的 golden vectors；`index.json` 绑定每个 fixture 的 SHA-256。
- `schemas/contract-schemas.v1.json` 是从运行时 Zod 真源生成的 JSON Schema bundle。
- `schemas/broker-contract.v1.json` 独立冻结 Broker handshake、registration、wire Envelope、Conversation Open authority、逻辑命令摘要、JCS canonicalization、WSS connect path/frame 上限与完整 close code/reason map；注册与握手携带它的 RFC 8785 SHA-256，但该产物自身不写入 digest 值。
- `openapi/creator-agent-v1.openapi.json` 是 Creator 与 Consumer HTTP API 的 OpenAPI 3.1 契约。
- `scripts/` 负责生成、校验契约产物，以及用固定 seed 运行 Invocation、Conversation Ready 与 Conversation Open 属性测试。

## 协议边界

包内冻结 `AgentVersionManifest/1`、`SnapshotManifest/1`、archive/manifest 两类加密 Envelope、Snapshot publication preparation/commit marker、`combo.creator-broker/1`、Invocation 状态机、`SandboxSpec/1`、`SandboxAttestation/1` 和 Creator/Consumer HTTP API。两类 Envelope 绑定最终对象 key、摘要、明文长度、KEK key id 和各自固定 binary framing，并要求同一 Snapshot 的 Creator、digest、wrapped DEK 一致且 nonce 不同。Snapshot upload API 只在 Worker 已完成两个密文对象后创建会话，并一次返回两个绑定 exact length、canonical base64 checksum、`If-None-Match` 和完整 metadata 的 Signed PUT。preparation marker 以 bounded canonical JCS 冻结首个已验证密文对，commit marker 只 hash-link exact preparation bytes并作为唯一读可见性权威；两者均使用 Creator/Snapshot 派生 fixed key 和 strict unknown-key contract。Schema 采用严格 unknown-key 策略；Broker JSON frame 还在运行时拒绝重复 JSON key和超限 frame。Fence 与 sequence 在 wire 上统一使用 canonical uint63 十进制字符串，避免 JavaScript number 精度损失。

Worker registration capability 与 Broker handshake 复用同一份 strict schema。两者都必须携带单个 `brokerContractDigest`；该字段属于 unsigned handshake 的固定字段并进入 DeviceSigner 的 canonical signing bytes。接收方必须将 registration、handshake 与 `currentBrokerContractDigest()` 精确比较，缺失、未知字段或任一 digest 漂移都应 fail closed。

`requestDigest`、`contentDigest` 和 `resultDigest` 使用按租户或版本密钥计算的 domain-separated HMAC-SHA-256；Snapshot 与公开构建产物继续使用普通 SHA-256 内容寻址。这些 digest 不代替 AEAD、签名、Lease 或 Execution Capability。

Creator/Consumer OpenAPI 中 11 个由服务端分配 ID 的路径参数统一引用 `ServerId`，其运行时与公开 Schema 都只接受 36 字符小写 UUIDv7。9 个公开 `Idempotency-Key` header 保持既有 generic UUID 契约；运行时 alias 的 UUID 版本语义仍需独立 ADR，本次边界收口不宣称二者已对齐。Evidence reviewer signoff 和不变量注册表的 Gate 集合最多包含 9 个且不得重复；reviewer signoff 继续要求词法递增，不变量注册表继续保留仅唯一、不强制排序的既有语义。

资源边界 corpus 只证明运行时 parser 与公开 contract/OpenAPI 在已声明数值上的一致性，不替代产品政策冻结。Broker capacity corpus 以 0/1/2 冻结握手中的两个 singleton 容量字段，并覆盖 Protocol、真实 Gateway 回环 WebSocket/WS 与真实 Worker 出站握手；它不证明 TLS/WSS termination、public ingress、Creator/Conversation WIP、queue、PostgreSQL/SQLite admission、真实推理容量或 soak。Snapshot Manifest 的文件总数 2,000 与展开后 200 MiB 直接引用技术方案 5.2 和测试方案 SNP-002/003/006/007；独立的单文件 corpus 引用同一技术方案、SNP-004/005 和既有 ADR-VNEXT-003，并由 Snapshot 包使用真实非稀疏 UTF-8 文件补充 build-to-verify 机制证据。压缩对象 corpus 引用技术方案 5.2、SNP-008、ADR-VNEXT-003 与 ADR-VNEXT-011，只冻结 50 MiB 明文 metadata、36-byte AEAD framing 和公开数值 owner 的一致性，不构造 50 MiB archive，也不证明真实 tar/zstd 机制 Gate。相对路径 corpus 引用技术方案 5.2、SCH-004、SNP-009 和 ADR-VNEXT-004，以 ASCII/CJK/astral 混合路径冻结 512 UTF-8 bytes 完整路径 owner，并由 Snapshot 包补充真实文件系统 build-to-verify；文件系统 component 255-byte 政策尚未冻结。`Utf8TextSchema` 的 19 个 runtime source owner 与 47 个 contract/Broker/OpenAPI public node 已通过同一 portable scalar-control pattern 收口，并分别使用 ASCII、CJK 和 emoji 在 N-1/N/N+1 精确 UTF-8 byte 边界执行 594 个实际 owner 结果；所有超限错误均命中目标 byte issue 且不回显 canary。Snapshot path 继续使用独立且更严格的 pattern 与 owner 边界。Signed PUT URL 的 2 个 runtime target owner、4 个 response 语义 owner与 3 个物理公开节点也已在 WHATWG URL 解析前使用同一严格 scalar/no-control pattern，阻止控制字符或 surrogate 被静默规范化；该证据不新增 URL maxLength，也不扩张到一般 URL canonicalization。`UnicodeCodePointStringSchema` 的 29 个 runtime owner 与 47 个 contract/OpenAPI public node 已用同一 portable scalar-control pattern 收口，并以 68 个 compact probes 在 8 组 code-point helper 边界执行 5,700 个结果；其中 3 个 exact-derived object key owner 只证明全部 64 个非法 scalar/control 输入先被拒绝，不把派生相等约束误报为一般字符串接受能力。Compatibility、decoded/UTF-8/structural/resource corpus 的 22 个实际 plain metadata owner 已复用 required/optional strict scalar/no-control schema，保留合法 CJK/astral 与空 root pointer，同时拒绝 lone surrogate、NUL 和 C1；duplicate-JSON-key 错误也只保留稳定原因与 offset，不再回显原 key。Broker handshake/frame 与 Snapshot preparation/commit marker 四个公开 raw parser 已统一抛出只含固定 `name/message/code` 的 `ProtocolRawInputError`，不再暴露 Zod issues、unknown key、原始输入或 cause；generic Zod schema 的直接调用、完整 raw-byte ingress 证据与 Idempotency alias ADR 仍未完成，因此 `SCH-005` 与 `SNP-010` 保持 `planned`。AgentVersion `developerInstructions=32` 仍需资源上限 ADR。`SCH-004`、`SNP-008` 与 `SNP-009` 保持 `planned`。

Worker 的 `prepared/started/succeeded/failed/cancelled/uncertain` 事实使用 `combo.worker-invocation-fact/1`。事实 ID 不是调用方任选值：prepared 固定使用 `prepareCommandId`，started 固定使用 `startCommandId`，全部 terminal fact 固定使用 `invocationId`；它不能复用会随 connection 重封装的 WebSocket `messageId`。事实内的 Lease/Fence 表示最初执行权威，重连后可以由新的外层传输 Lease/Fence 承载同一事实，但事实本身和 `factDigest` 不得改变。started 必须保存可查询的 Host `runtimeThreadId/runtimeTurnId`，succeeded 必须重复这两个 handle 并绑定 `startedFactDigest`。`factDigest` 对 Version、Snapshot、Execution Capability、原执行 Lease/Fence 及事件专属非敏感字段做 canonical SHA-256。Worker SQLite 与 PostgreSQL 必须分别重算并保存同一 digest，同 ID 不同 digest 只能 security-block，不能猜测或覆盖。

Worker 的 `conversation.ready` 事实使用独立且严格的 `combo.worker-conversation-ready-fact/1`。`sourceEventId` 固定等于产生该事实的 durable `openCommandId`；fact 同时冻结 Conversation、Deployment、AgentVersion ID/digest、Snapshot digest、原 Worker installation/session/Lease/Fence、Sandbox、Host runtime thread 与 ready evidence digest。Broker body 必须是这些 exact fact 字段加 canonical `factDigest`，不能加入 transport receipt 等旁路字段。外层 `messageId` 必须与 source 不同，`correlationId` 固定等于 `conversationId`；授权重连可以更换外层 connection/message/sequence/session/Lease/Fence，但不能改写原 fact 或强制原 Lease 等于当前外层 Lease。

`conversation.open` body 必须携带 `openAuthority`，冻结原 Deployment、Installation、Worker Session、Lease 与 Fence。Open command 的 `correlationId` 固定等于 Conversation ID，`messageId` 与 Conversation ID 必须不同，当前外层 Deployment 必须等于原 Deployment；授权重封装只能改变 connection、sequence、时间和当前 Session/Lease/Fence。`brokerConversationOpenLogicalDigest()` 只 hash protocol、schema、kind、type、messageId、correlationId 与完整 body，不把这些外层传输字段混入稳定业务身份。

## 验证

```bash
pnpm -F @cb/creator-agent-protocol generate:contracts
pnpm -F @cb/creator-agent-protocol check:contracts
pnpm -F @cb/creator-agent-protocol typecheck
pnpm -F @cb/creator-agent-protocol typecheck:test
pnpm -F @cb/creator-agent-protocol test:g0
pnpm -F @cb/creator-agent-protocol test:property --seed 12648430 --runs 100000
```

`generate:contracts` 只在有意修改运行时真源或 fixture 时使用；持续集成运行 `check:contracts`，任何生成结果或 fixture digest 漂移都会失败。属性测试在失败时必须保留 seed；它证明状态机逻辑，不证明真实数据库、Broker、Codex 或 Sandbox。
