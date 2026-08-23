# 源码职责

- `pump-contract.ts` 定义三种严格 command payload、pump 生命周期、resolver 和错误合同。
- `worker-serial-pump.ts` 串行执行两库 mutation，在 commit/mark 后发起 Host I/O，但不在 mutation
  队列内等待 Host promise；完成事件会重新入队。
- `runtime-contract.ts` 定义唯一组合根的 storage mode、READY/BLOCKED 生命周期、错误与依赖端口。
- `worker-runtime.ts` 创建/打开双库，按依赖顺序启动 Host、owner、driver、pump、owner heartbeat 与
  scheduler，并执行自动 BLOCKED 收敛和反向停止。
- `codex-app-server-protocol.ts` 只解析 bundled Codex 0.148 中 R1 Host 所需的窄协议子集。
- `codex-app-server-process.ts` 固定并校验 ChatGPT.app 内的 Codex，建立私有 auth bridge，管理有界
  NDJSON/RPC 与子进程停止；不从 PATH 选择可执行文件。
- `codex-app-server-host.ts` 把真实 thread/turn/interrupt/terminal 映射成 R1 handle-private authority；
  只有精确 workspace root、`:read-only` 与工具无网络回读同时成立才签发 Host thread，并要求调用方显式
  确认当前尚无 OS 级 Project-only 读隔离。
- `local-alpha-contract.ts` 定义单用户本地体验入口、结果、诊断与安全错误合同。
- `agent-local-contract.ts` 定义 immutable AgentVersion 本地执行的公开输入、结果和 fail-closed 错误。
- `agent-local-runner.ts` 验证 AgentVersion 与本机 Git object 中的 exact commit/tree，仅从 blob
  materialize 私有 tracked-tree execution snapshot，再把固定 instructions/version binding 交给现有本地
  Worker 闭环；它不读取 mutable Draft、可变工作区、ignored 文件或 Codex task 原文。
- `local-alpha-broker.ts` 在随机 loopback 端口实现真实 R2C lease、command、PERSISTED ACK 与
  CLOUD_COMMITTED ACK，并严格绑定 terminal message、Host source、attempt 与 sealed-result marker；它不
  开放公网监听或 Cloud 身份能力。
- `local-alpha-runner.ts` 把本地 Broker、bundled Codex 与 R2E Runtime 组合成一次 fresh-state invocation；
  prompt 与回答只保留在内存，durable envelope 只写低敏关联 marker，旧 run state 不复用；内部 execution
  profile 允许 Agent runner 精确绑定一个已验证 Version，而普通 Local Alpha 仍使用固定默认 instructions。
- `local-alpha-cli.ts` 是 `combo-creator-worker` 进程入口，解析显式风险确认、终端 prompt 和 signal，并在
  完整停止后把回答写 stdout。
- `index.ts` 是应用包的唯一公共出口。
- `__tests__/` 使用真实两份 SQLite、真实本地 WebSocket 与真实 R1 handle authority 验证完整接线和
  崩溃边界。

`worker-runtime.ts` 仍是唯一允许创建 SQLite、建立 Worker WebSocket driver 并关闭这些资源的文件；
`local-alpha-broker.ts` 只拥有相反方向的 loopback server。bundled Codex 子进程只由
`codex-app-server-process.ts` 创建和停止，pump 继续只负责串行执行。本地 CLI 不代表公网身份接线或已部署。
