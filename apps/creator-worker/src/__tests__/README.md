# 测试职责

- `worker-serial-pump.test.ts` 覆盖 prepare、start、sealed success、fact handoff、取消竞态、并发 tick、
  command/fact 跨库 exact replay、owner 续租、driver deferred/blocked、非法 command fail-closed、
  transport-incompatible sealed envelope 的 commit 前拒绝、明文不落盘、忽略 AbortSignal 的 resolver
  与保守停止。
- `worker-runtime.test.ts` 覆盖 R2E 双库创建与 reopen、真实 loopback WebSocket lease/command/Cloud ACK、
  READY 门槛、Host 不重放、stop-time UNCERTAIN 的下一次启动 handoff、无 lease 时有界停止、启动期与
  运行期永久 command 失败的 BLOCKED 首因、Host late-start 补偿，以及 journal/transport sidecar 路径
  冲突的零副作用拒绝。
- `codex-app-server-host.test.ts` 用受控假子进程覆盖固定版本/环境、workspace 权限回读、start 写入边界、
  fixed structured-output schema、乱序通知、原子成功/失败、中断 lineage、watchdog、恶意 NDJSON 与有界
  停止。
- `codex-app-server-host.real.test.ts` 仅在 `COMBO_REAL_CODEX_E2E=1` 时运行固定 bundled Codex，对临时
  sanitized Project 执行一轮真实只读回答，并验证项目内容未变化。
- `agent-package-loader.test.ts` 验证规范化智能体包目录、完整文件清单、原始字节摘要、`AGENT.md`、技能
  路径、额外或缺失文件、符号链接、非法 UTF-8 与无技能智能体包。
- `agent-package-session.test.ts` 用 R1 受信句柄验证一个主机、一个任务线程、顺序多轮、并发拒绝、终态
  失败、启动补偿和幂等关闭；它明确不创建 `Worker`、`Broker` 或 SQLite。
- `agent-package-session.real.test.ts` 仅在 `COMBO_REAL_CODEX_E2E=1` 时让真实内置 Codex 加载智能体包的
  `AGENT.md` 与原生技能。第一轮输出绑定只存在于技能中的随机规则，第二轮取回只存在于上一条消息的随机
  标记，从而同时证明技能激活与同一 Codex 任务线程的多轮上下文；项目与智能体包内容保持不变。
- `host-adapter-import-boundary.test.ts` 扫描应用与包源码，确保生产环境只有 bundled Codex adapter 能
  导入 R1 producer 子路径，测试代码之外的新增 authority mint 入口会直接让 CI 失败。
- `agent-layer-import-boundary.test.ts` 解析生产 TypeScript 的普通 import、re-export 与 dynamic import，
  确保 Agent 创作层、执行层和基础设施保持单向依赖，并要求每个 Creator Worker 生产文件都有明确分层。
- `local-alpha.test.ts` 用 Fake Host 但真实 Broker、双 SQLite、driver、pump 与 Runtime 连跑两次，覆盖
  fresh run、命令 ACK、Transport SQLite 中 exact terminal ACKED、强制断线换 lease 后继续、终态防伪、
  干净停止、旧/不完整/非空状态拒绝、signal/prepare 竞态、管道输入有界中断、CLI 参数与 prompt/回答
  不落库。
- `local-alpha.real.test.ts` 仅在 `COMBO_REAL_CODEX_E2E=1` 时运行完整本地闭环；它从 Broker command 一直
  经过真实 bundled Codex 到 terminal ACK，并验证 sanitized Project 零变化与两库无正文。
- `agent-local-runner.test.ts` 用 Fake Host、真实 Broker、双 SQLite、driver、pump 与 Runtime 证明同一 immutable
  AgentVersion 可运行两次且 instructions 不漂移。V1/V2 Host 只看到 blob materialize 的 fixed tree；V3 Host
  只看到空的 0500 临时目录，原 authoring Project 不存在也能运行，传入 Project path 会在 Host 副作用前拒绝。
- `project-context-compiler.test.ts` 覆盖 tracked-clean、tracked-dirty、untracked、ignored、hidden、日志、
  task/session、`.env`、物理 `.git` 与 symlink 索引，验证 linked worktree pointer 不扩展到外部 Git admin
  目录、Git filter 不执行、特殊文件与稀疏超限文件 fail-closed、目录替换不越出 Project、fixed output
  schema、source digest 引用、best-effort secret taint、敏感上下文授权和编译前后 Project 漂移拒绝。它还
  覆盖 unborn 聚合根、两个嵌套仓库、hardlink 去重预算，以及不选择嵌套仓库的 V3 behavior-only 编译。
  ctime-only 回归模拟 macOS 首次读取时的 provenance 更新，要求索引记录 post-read 稳定 stat，同时继续
  拒绝 size、mtime、mode、identity 或内容漂移。
- `agent-catalog-cli.test.ts` 用独立真实 Catalog SQLite 覆盖一条 `create` 命令中的编译、完整 review、可见
  TTY 一次 `FREEZE`、freeze、close/reopen 与可选运行，也覆盖 strict V1/V2 handoff import、手工 exact
  confirmation、旧 Version 精确选择、无隐式 latest、非法 UTF-8 与 prompt/回答/Project path 不落 Catalog；
  compiler 与 run 使用 Fake Host seam。
- `agent-local-runner.real.test.ts` 仅在 `COMBO_REAL_CODEX_E2E=1` 时验证两种真实运行：V1/V2 经过 Catalog
  freeze/reopen、私有 tracked-tree snapshot、双 SQLite 与 terminal ACK；V3 在没有 authoring Project 的空临时
  目录中仅使用冻结行为。两者都验证正文不落持久库。
- `project-context-compiler.real.test.ts` 仅在 `COMBO_REAL_CODEX_E2E=1` 时对含 hidden、ignored 日志、
  task/session 和 `.env` 的 sanitized Project 完成全量索引、真实 bundled Codex 编译、V2 Catalog import、
  review、freeze、close/reopen 与 exact Version 运行，并验证原 Project 不变且敏感值、运行 prompt 和回答
  不落 Catalog 或 Worker SQLite。

测试使用真实 Node 24 `node:sqlite` 文件和真实 R1 adapter controller；R2E 测试还使用真实 `ws` client /
server。Project 全量索引只证明扫描器读取并哈希了可支持的物理条目，不证明模型理解了每个字节；taint
断言也只是已知 literal 的 best-effort 防泄漏门槛。真实 Codex Host gate 与本地 Alpha gate 都只证明本机
受控环境。本地 Alpha 的 loopback Broker 不是 Cloud Broker；这些测试不会证明公网身份、Cloud durability、
进程崩溃后恢复回答、OS 级 Project-only 隔离或生产部署。
