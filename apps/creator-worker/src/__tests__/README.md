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
- `creator-conversation-acceptance.test.ts` 校验 `J-011` · 当前对话生成 Draft 的机器合同、五层门禁状态和
  文档一致性。它同时锁定 Project V1 不被扩宽、current-conversation V2 public facade 只绑定 unavailable Host，并把
  Hook / Bridge、CLI、Fake Host 和既有 Project 测试标为非产品证据；该测试通过只证明验收口径真实，不证明
  Desktop 路径已经实现。
- `current-conversation-draft-extractor.test.ts` 用 Fake ambient lease 锁定 request digest 绑定、exact 制作要求进入
  提取语义、direct-user、active-task、user-visible-only、完整性、单次结构化提取、前后漂移核对和所有路径
  close；模型 schema 不含 egress receipt，receipt 只能由 Host wrapper 产生并绑定 snapshot/request/Draft digest。
  raw transcript 或 credential canary 被 Fake Host 拒绝时不产生 receipt 或 Draft；不完整、错配、Host 失败、
  恶意 getter、取消与 cleanup 失败都固定停止且不重试。Fake lease 不证明真实 Desktop Host。
- `agent-package-current-conversation-draft.test.ts` 锁定业务调用方只能提交一句 V2 制作要求和普通运行控制，
  Project/source/task/thread/session/item/transcript 字段在 Host 调用前拒绝；成功只返回可读/可修订 Draft，
  没有 compile，Host 原始错误与路径不外泄。
- `agent-package-current-conversation-import-boundary.test.ts` 静态证明 current-conversation seam 不导入 Project
  scanner、projection、Bridge、CLI、child process、bundled Codex、Package builder/publisher/loader、Session、
  Worker、Broker、Journal 或 SQLite；`host-adapter-import-boundary.test.ts` 进一步要求它们只有固定 unavailable
  composition 这一条 production importer。clean dist 会携带 fail-closed facade 及其 ordering 文件，但不会携带
  Project authorization 的 Fake producer 或未接线 composition。
- `agent-package-authoring.test.ts` 覆盖 Project 语义结果到 `AGENT.md`、原生技能和规范清单的确定性编译，
  私有摘要目录的原子发布、正式加载器重开、相同内容重放、路径前置拒绝和清理错误可见性。
  它还锁定现有 Project Package builder 在任何发布或加载前拒绝 current-conversation Draft V2。
- `agent-package-current-conversation-composition.test.ts` 锁定 production facade 在 Desktop Host capability 缺席时
  只返回固定 source-unavailable 错误，并在任何 Host/source/Project caller 注入前停止。
- `desktop-current-conversation-evidence.test.ts` 锁定 production protocol subpath 可加载 parse/verify/digest，且
  不公开任何 receipt signer；验签与 candidate/digest/事件/零旁路负例由 protocol 测试覆盖。
- `agent-package-creator.test.ts` 覆盖一句制作要求与受信调用方当前 Project 的绑定、无绝对路径 Draft、来源
  回执、exact revision 修订、不同 revision 编译出不同 Package digest、正式重载、来源目录移动后的编译拒绝，
  以及篡改和 getter 的零副作用拒绝。
- `agent-package-creator-authorized.test.ts` 用仅存在于测试目录的 Fake one-shot redemption port 锁定顺序：
  request 校验与取消先于 redemption，redemption 成功先于 Project work，exact request/executor 摘要错配与
  Host 拒绝、过期、撤销、重放、证据丢失都零 Draft work；成功后 Project identity 会在 scanner 首读边界
  再次核对，Host dispatch/workspace generation 在 redemption 后漂移也会由 lease `assertCurrent()` 拒绝；
  返回面不暴露 Package compile。业务 options 不能提交 handle、execution 或 Project 字段。Fake 只证明应用
  编排，不证明真实 Host authority、UI 点击、authenticated IPC 或 Host ledger。

`agent-package-creator.test.ts`、`agent-package-creator-authorized.test.ts`、
`agent-package-creator-bridge.test.ts`、`agent-package-creator-bridge.real.test.ts`、`agent-package-cli.test.ts`、
`agent-package-authoring.real.test.ts`、`project-context-compiler.test.ts` 与对应 real 测试统一属于
`EXPLICIT_PROJECT_COMPAT`。机器合同进一步把 Project-first Creator、Hook / Bridge、CLI、Fake Host / port 和
独立 Bundled Codex thread 分别列为 non-acceptance evidence。它们仍负责保护 Project 来源的安全和兼容性，但
不得计入当前对话 Golden Path 的 Contract、Host、Security 或 UAT 通过数。

- `creator-project-source-boundary.test.ts` 覆盖 Creator 专属 `.git`、`.codex`、Host metadata 与 symlink
  剪枝，linked-worktree pointer、纯管理变化摘要稳定、Git CLI 禁用、私有只读投影、递归权限、零来源写入、
  root 前置拒绝、scan/projection 中间目录置换的 pre-read path binding、excluded `000` 状态下的投影与复验、
  unsafe 路径 fail-closed、exact NFD 路径、O(1) identity lookup、citation 硬拒绝、投影清理错误和旧版全物理
  扫描兼容。
- `agent-package-creator-bridge.test.ts` 覆盖官方指南版本 handoff、Host 当前 Project 的单次绑定、制作要求
  不可换绑、取消、全部编译器错误的稳定分类、内部失败的保守停止、固定无泄漏错误 envelope，以及单文件
  构建产物在空 `NODE_PATH` 下拒绝任何路径参数。
- `agent-package-creator-bridge.real.test.ts` 仅在 `COMBO_REAL_CODEX_E2E=1` 时从 Host 绑定的临时 Project
  启动实际单文件桥接入口，调用真实内置 Codex 提取一个带随机方法标记的 Draft，并验证来源文件零变化、
  Draft 不含绝对路径或官方网页地址。
- `agent-package-cli.test.ts` 覆盖无确认的单命令创作、包管理器参数分隔符、真实包脚本转发、可行动参数错误、
  摘要绑定、同一会话两轮消费、来源与消费者目录隔离，以及第一轮失败后仍关闭会话且不重新创作。
- `agent-package-authoring.real.test.ts` 仅在 `COMBO_REAL_CODEX_E2E=1` 时从一句制作要求和受信调用方当前 Project
  生成可审阅 Draft，再编译并正式重载智能体包；冻结后才创建包含随机证据的消费者目录。正式智能体包会话
  第一轮应用提取方法，第二轮取回只存在于上一轮的随机标记，并验证来源、消费者、包目录和临时资源均闭合。
- `agent-package-import-boundary.test.ts` 从正式包子路径加载生产会话，要求公共函数可用，并证明模块翻译阶段
  不会进入旧版 Worker、Broker、Journal、SQLite、本地执行或旧版智能体组合根；同一测试也验证智能体包
  创作与 Creator Draft 子路径不会反向加载旧版执行链或旧版 AgentVersion 协议。
- `host-adapter-import-boundary.test.ts` 扫描应用与包源码，确保生产环境只有 bundled Codex adapter 能
  导入 R1 producer 子路径；Creator authorization 不得出现 mint/consume 实现，内部 redemption ordering
  seam 在真实顶层 Host UI adapter 接入前也必须保持零生产导入方。测试还扫描 clean build 的两份 `dist`
  inventory，拒绝旧 producer、public wrapper、composition 或内部 seam 残留。
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
  覆盖 unborn 聚合根、两个嵌套仓库、hardlink 去重预算、不选择嵌套仓库的 V3 behavior-only 编译，以及
  Package 提取 Host 生命周期、结构输出、citation、secret 与可移植性策略的真实错误分类。
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
