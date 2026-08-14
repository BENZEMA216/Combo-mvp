# Creator Agent Protocol

这个包是 Creator-hosted Agent VNext 的跨进程契约真源。云端服务、Creator Worker、Sandbox Supervisor、Creator Console、消费者页面和验收工具应从同一套运行时 Schema、TypeScript 类型与生成产物读取协议，不能在各自应用里复制另一份字段定义。

## 目录职责

- `src/` 定义共享协议（包括 Snapshot Manifest、archive/manifest 两类加密 Envelope、AgentVersion、Broker、Worker Conversation Ready/Invocation durable facts、Sandbox 与 HTTP）、RFC 8785 JSON 规范化、Invocation 状态机、稳定错误和重试策略、Evidence Bundle、不变量与测试注册表。
- `fixtures/` 保存 Schema、WSS、状态机、canonical digest 和 Evidence Bundle 的 golden vectors；`index.json` 绑定每个 fixture 的 SHA-256。
- `schemas/contract-schemas.v1.json` 是从运行时 Zod 真源生成的 JSON Schema bundle。
- `openapi/creator-agent-v1.openapi.json` 是 Creator 与 Consumer HTTP API 的 OpenAPI 3.1 契约。
- `scripts/` 负责生成、校验契约产物，以及用固定 seed 运行 Invocation 属性测试。

## 协议边界

包内冻结 `AgentVersionManifest/1`、`SnapshotManifest/1`、archive/manifest 两类加密 Envelope、Snapshot publication preparation/commit marker、`combo.creator-broker/1`、Invocation 状态机、`SandboxSpec/1`、`SandboxAttestation/1` 和 Creator/Consumer HTTP API。两类 Envelope 绑定最终对象 key、摘要、明文长度、KEK key id 和各自固定 binary framing，并要求同一 Snapshot 的 Creator、digest、wrapped DEK 一致且 nonce 不同。Snapshot upload API 只在 Worker 已完成两个密文对象后创建会话，并一次返回两个绑定 exact length、canonical base64 checksum、`If-None-Match` 和完整 metadata 的 Signed PUT。preparation marker 以 bounded canonical JCS 冻结首个已验证密文对，commit marker 只 hash-link exact preparation bytes并作为唯一读可见性权威；两者均使用 Creator/Snapshot 派生 fixed key 和 strict unknown-key contract。Schema 采用严格 unknown-key 策略；Broker JSON frame 还在运行时拒绝重复 JSON key和超限 frame。Fence 与 sequence 在 wire 上统一使用 canonical uint63 十进制字符串，避免 JavaScript number 精度损失。

`requestDigest`、`contentDigest` 和 `resultDigest` 使用按租户或版本密钥计算的 domain-separated HMAC-SHA-256；Snapshot 与公开构建产物继续使用普通 SHA-256 内容寻址。这些 digest 不代替 AEAD、签名、Lease 或 Execution Capability。

Worker 的 `prepared/started/succeeded/failed/cancelled/uncertain` 事实使用 `combo.worker-invocation-fact/1`。事实 ID 不是调用方任选值：prepared 固定使用 `prepareCommandId`，started 固定使用 `startCommandId`，全部 terminal fact 固定使用 `invocationId`；它不能复用会随 connection 重封装的 WebSocket `messageId`。事实内的 Lease/Fence 表示最初执行权威，重连后可以由新的外层传输 Lease/Fence 承载同一事实，但事实本身和 `factDigest` 不得改变。started 必须保存可查询的 Host `runtimeThreadId/runtimeTurnId`，succeeded 必须重复这两个 handle 并绑定 `startedFactDigest`。`factDigest` 对 Version、Snapshot、Execution Capability、原执行 Lease/Fence 及事件专属非敏感字段做 canonical SHA-256。Worker SQLite 与 PostgreSQL 必须分别重算并保存同一 digest，同 ID 不同 digest 只能 security-block，不能猜测或覆盖。

Worker 的 `conversation.ready` 事实使用独立且严格的 `combo.worker-conversation-ready-fact/1`。`sourceEventId` 固定等于产生该事实的 durable `openCommandId`；fact 同时冻结 Conversation、Deployment、AgentVersion ID/digest、Snapshot digest、原 Worker installation/session/Lease/Fence、Sandbox、Host runtime thread 与 ready evidence digest。Broker body 必须是这些 exact fact 字段加 canonical `factDigest`，不能加入 transport receipt 等旁路字段。外层 `messageId` 必须与 source 不同，`correlationId` 固定等于 `conversationId`；授权重连可以更换外层 connection/message/sequence/session/Lease/Fence，但不能改写原 fact 或强制原 Lease 等于当前外层 Lease。

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
