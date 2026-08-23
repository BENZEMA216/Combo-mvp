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
  确认当前尚无 OS 级 Project-only 读隔离。它还提供仅供包内编译器使用的 fixed structured-output Host，
  会把经过大小、深度和值域校验的 detached JSON Schema 固定到每一次 turn。
- `local-alpha-contract.ts` 定义单用户本地体验入口、结果、诊断与安全错误合同。
- `agent-local-contract.ts` 定义 immutable AgentVersion 本地执行的公开输入、结果和 fail-closed 错误。
- `agent-local-runner.ts` 验证 V1 或 V2 AgentVersion 与本机 Git object 中的 exact commit/tree，仅从 blob
  materialize 私有 tracked-tree execution snapshot，再把固定 instructions/version binding 交给现有本地
  Worker 闭环；它不读取 mutable Draft、可变工作区或 ignored 文件，并提供冻结前 exact tree 可运行性预检。
- `project-context-index.ts` 对 canonical Project 的全部物理后代执行有界只读索引，哈希 regular file，记录
  symlink 本身而不跟随外部目标，并区分 tracked-clean、tracked-dirty、untracked、ignored、Git admin 与
  authoring-only evidence。它覆盖 hidden、日志、task/session、`.env` 和物理 `.git`，不会执行 Project 脚本
  或 Git clean filter；linked worktree 的 `.git` pointer 不会扩展到 Project 外的共享目录。
- `project-context-compiler.ts` 在编译前后核对完整 Project digest，把 fixed output schema 与有界 coverage
  摘要交给 bundled Codex；Codex 直接在只读 Project 中选择相关证据。编译器把严格输出转换为带 compact
  source ledger 的 V2 Draft 和 handoff，并在交付前执行 source citation、best-effort secret taint 与 Runtime
  物化预检。full inventory 只存在扫描器内存中，不序列化到临时文件或 Catalog。
- `agent-catalog-cli.ts` 是 `combo-creator-agent` 进程入口。它以 `create` 完成全量索引、bundled Codex 编译、
  terminal-safe 完整 review、可见 TTY 中一次 `FREEZE`、Catalog close/reopen 和可选 exact Version run；
  `init/import/review/freeze/run` 只保留作诊断与 V1 兼容。它不提供隐式 latest、force 或公开分享副作用。
- `local-alpha-broker.ts` 在随机 loopback 端口实现真实 R2C lease、command、PERSISTED ACK 与
  CLOUD_COMMITTED ACK，并严格绑定 terminal message、Host source、attempt 与 sealed-result marker；它不
  开放公网监听或 Cloud 身份能力。
- `local-alpha-runner.ts` 把本地 Broker、bundled Codex 与 R2E Runtime 组合成一次 fresh-state invocation；
  prompt 与回答只保留在内存，durable envelope 只写低敏关联 marker，旧 run state 不复用；内部 execution
  profile 允许 Agent runner 精确绑定一个已验证 Version，而普通 Local Alpha 仍使用固定默认 instructions。
- `local-alpha-cli.ts` 是 `combo-creator-worker` 进程入口，解析显式风险确认、终端 prompt 和 signal，并在
  完整停止后把回答写 stdout。
- `index.ts` 是应用包的唯一公共出口。
- `__tests__/` 使用真实 Catalog/Worker SQLite、真实本地 WebSocket 与真实 R1 handle authority 验证完整
  接线、Project Context Compiler、V1/V2 兼容和崩溃边界；opt-in real gate 还会调用真实 bundled Codex。

`worker-runtime.ts` 仍是唯一允许创建 SQLite、建立 Worker WebSocket driver 并关闭这些资源的文件；
`local-alpha-broker.ts` 只拥有相反方向的 loopback server。bundled Codex 子进程只由
`codex-app-server-process.ts` 创建和停止，pump 继续只负责串行执行。本地 CLI 不代表公网身份接线或已部署。
