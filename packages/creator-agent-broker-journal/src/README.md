# Source responsibilities

- `effect-authority.ts`：reducer 签发 process-local start/interrupt effect，绑定 durable attempt ID 与 ordinal。
- `host-projection.ts`：在同一 effect wrapper 内调用并验证 exact R1 handle，再签发 process-local projection capability。
- `host-executor.ts`：唯一受信 executor 子路径；根出口不暴露 Host capability producer。
- `result-seal.ts`：把可信 sealer 包装为 receipt authority；seal 前不签发 SUCCEEDED terminal。
- `worker-invocation.ts`：纯执行 reducer；区分 durable write plan 与 commit 后 Host effect。
- `index.ts`：显式 package API；不得使用通配导出。
- `__tests__/`：状态矩阵、cancel/final race、lineage、foreign handle 与恢复回归。

生产源码不得导入 SQLite、文件系统、网络、应用或 Cloud 模块。回答正文只允许短暂存在于
`VerifiedWorkerHostOutcome` 并直接交给 seal port，不得进入 reducer state/effect。command replay、
fact delivery 和 retention 都是后续独立 reducer 的职责。
