# Creator Agent Protocol

这个包是 Creator-hosted Agent VNext 的跨进程契约真源。云端服务、Creator Worker、Sandbox Supervisor、Creator Console、消费者页面和验收工具应从同一套运行时 Schema、TypeScript 类型与生成产物读取协议，不能在各自应用里复制另一份字段定义。

## 目录职责

- `src/` 定义共享协议（包括 Snapshot Manifest、Snapshot archive Envelope、AgentVersion、Broker、Sandbox 与 HTTP）、RFC 8785 JSON 规范化、Invocation 状态机、稳定错误和重试策略、Evidence Bundle、不变量与测试注册表。
- `fixtures/` 保存 Schema、WSS、状态机、canonical digest 和 Evidence Bundle 的 golden vectors；`index.json` 绑定每个 fixture 的 SHA-256。
- `schemas/contract-schemas.v1.json` 是从运行时 Zod 真源生成的 JSON Schema bundle。
- `openapi/creator-agent-v1.openapi.json` 是 Creator 与 Consumer HTTP API 的 OpenAPI 3.1 契约。
- `scripts/` 负责生成、校验契约产物，以及用固定 seed 运行 Invocation 属性测试。

## 协议边界

包内冻结 `AgentVersionManifest/1`、`SnapshotManifest/1`、`SnapshotArchiveEnvelope/1`、`combo.creator-broker/1`、Invocation 状态机、`SandboxSpec/1`、`SandboxAttestation/1` 和 Creator/Consumer HTTP API。Snapshot archive Envelope 绑定最终对象 key、三组摘要、明文长度、KEK key id 和固定 binary framing；架构要求的 encrypted Manifest Envelope 尚未实现，不能据此声明 Gate 1 完成。Schema 采用严格 unknown-key 策略；Broker JSON frame 还在运行时拒绝重复 JSON key和超限 frame。Fence 与 sequence 在 wire 上统一使用 canonical uint63 十进制字符串，避免 JavaScript number 精度损失。

`requestDigest`、`contentDigest` 和 `resultDigest` 使用按租户或版本密钥计算的 domain-separated HMAC-SHA-256；Snapshot 与公开构建产物继续使用普通 SHA-256 内容寻址。这些 digest 不代替 AEAD、签名、Lease 或 Execution Capability。

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
