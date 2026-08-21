# Source responsibilities

- `effect-authority.ts`：reducer 签发 branded raw start/interrupt/observe plan；transaction COMMIT 后的内部 marker 再把 exact raw plan 绑定到 invocation/revision/owner epoch，并签发 process-local committed wrapper。
- `host-projection.ts`：只解包 committed start/interrupt wrapper，在同一 scope 内调用并验证 exact R1 handle，再签发 process-local projection capability。
- `host-executor.ts`：唯一受信 executor 子路径；只暴露 committed 类型和执行函数，不暴露 commit marker。
- `result-seal.ts`：把可信 sealer 包装为 receipt authority；seal 前不签发 SUCCEEDED terminal，journal 只能通过 package-internal exact authority+receipt helper 读取 immutable envelope。
- `worker-invocation.ts`：纯执行 reducer；区分 durable write plan 与 commit 后 Host effect。
- `durable-codec.ts`：严格 canonical JSON、storage fingerprint 与可持久化 state/event/effect validator。
- `sqlite-schema.ts`：fresh-only v1 schema、application ID/version 与 catalog digest；不含升级分支。
- `sqlite-store-platform.ts`：0600/sidecar/SQLite PRAGMA、fresh create 与 existing open 的 fail-closed 平台边界。
- `sqlite-store-records.ts`：row codec、recovery/source binding、event chain 与 terminal/outbox/seal 交叉验证。
- `sqlite-store-types.ts`：`./sqlite-store` 的 owner/cursor/read/replay/commit 公共类型。
- `sqlite-store-internal.ts`：仅测试可见的 clock/fault hook symbol，不从 package exports 暴露。
- `sqlite-store.ts`：独占连接、owner epoch、CAS cursor、exact replay、原子 outbox/seal 与 post-COMMIT effect。
- `index.ts`：显式 package API；不得使用通配导出。
- `__tests__/`：状态矩阵、Host race，以及 fresh SQLite/回滚/重启/篡改回归。

根 reducer 与 Host executor 不得导入 SQLite、文件系统、网络、应用或 Cloud 模块；平台 I/O 只在
显式 SQLite 子路径内。回答正文只允许短暂存在于
`VerifiedWorkerHostOutcome` 并直接交给 seal port，不得进入 reducer state/effect。command replay、
state/outbox/seal atomicity 已由 store 负责；fact delivery ACK 和 retention 留给后续独立切片。
