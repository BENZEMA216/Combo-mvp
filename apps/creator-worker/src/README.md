# 源码职责

- `pump-contract.ts` 定义三种严格 command payload、pump 生命周期、resolver 和错误合同。
- `worker-serial-pump.ts` 串行执行两库 mutation，在 commit/mark 后发起 Host I/O，但不在 mutation
  队列内等待 Host promise；完成事件会重新入队。
- `runtime-contract.ts` 定义唯一组合根的 storage mode、READY/BLOCKED 生命周期、错误与依赖端口。
- `worker-runtime.ts` 创建/打开双库，按依赖顺序启动 Host、owner、driver、pump、owner heartbeat 与
  scheduler，并执行自动 BLOCKED 收敛和反向停止。
- `codex-app-server-protocol.ts` 只解析 bundled Codex 0.148 中 R1 Host 所需的窄协议子集。
- `codex-app-server-process.ts` 固定并校验 ChatGPT.app 内的 Codex，建立私有 auth bridge，管理有界
  NDJSON/RPC 与子进程停止；不从 PATH 选择可执行文件，并继续禁用全局技能搜索。
- `codex-app-server-host.ts` 把真实 thread/turn/interrupt/terminal 映射成 R1 handle-private authority；
  只有精确 workspace root、`:read-only` 与工具无网络回读同时成立才签发 Host thread，并要求调用方显式
  确认当前尚无 OS 级 Project-only 读隔离。它还提供仅供包内编译器使用的 fixed structured-output Host，
  会把经过大小、深度和值域校验的 detached JSON Schema 固定到每一次 turn。
- `infrastructure/agent-package-loader.ts` 对 `agent.json` 和完整智能体包目录执行规范化、普通文件、路径、
  长度与原始字节摘要校验，拒绝符号链接、特殊文件、缺失和额外资源；它把已验证字节物化成会话私有的
  只读、不可执行快照，只返回该快照中的 `AGENT.md`、智能体包摘要、原生技能路径和有界清理能力，不创建
  会话。
- `infrastructure/agent-package-publisher.ts` 把已编译的智能体包资源写入私有同文件系统临时目录，逐文件同步
  后按内容摘要原子提交；已存在的摘要目录不会被覆盖，随后仍须经过正式加载器验证。
- `infrastructure/codex/index.ts` 是 application composition 使用的 bundled Codex 窄入口；Host 与 Process
  实现仍保持内部文件，不向创作层或执行层暴露具体构造责任。
- `local-alpha-contract.ts` 定义单用户本地体验入口、结果、诊断与安全错误合同。
- `agent-local-contract.ts` 定义 immutable AgentVersion 本地执行的公开输入、诊断、结果和 fail-closed 错误。
- `execution/ports.ts` 定义执行层唯一可见的 invocation port 与固定 runtime version 输入；执行核心不知道
  bundled Codex、Broker、SQLite 或 Project Context Compiler 的具体实现。
- `execution/agent-version-runner.ts` 验证 V1/V2 AgentVersion 与本机 Git object 中的 exact commit/tree，
  仅从 blob materialize 私有 tracked-tree execution snapshot；V3 behavior-only Agent 拒绝 authoring Project
  路径并使用空的私有临时目录。两类执行都经 invocation port 提交固定 instructions 与 version binding，
  完整停止后删除临时目录。
- `execution/index.ts` 是 application composition 使用的执行层内部出口。
- `agent-local-runner.ts` 是旧内部路径的薄兼容入口，只 re-export application composition 已绑定的执行用例。
- `project-context-index.ts` 对 canonical Project 的全部物理后代执行有界只读索引，哈希 regular file，记录
  symlink 本身而不跟随外部目标，并区分 tracked-clean、tracked-dirty、untracked、ignored、Git admin 与
  authoring-only evidence。它覆盖 hidden、日志、task/session、`.env` 和物理 `.git`，不会执行 Project 脚本
  或 Git clean filter；linked worktree 的 `.git` pointer 不会扩展到 Project 外的共享目录。文件首次读取时
  允许 macOS 只更新系统 provenance/ctime，并以同一文件描述符上的 post-read stat 作为稳定索引基线。首轮
  内容哈希后，它还保留仅在内存的 bigint 元数据 manifest，用完整 namespace 与文件身份复验替代第二次正文
  读取，并输出有界扫描进度。
- `authoring/ports.ts` 只定义结构化 authoring Host 窄端口；纯 Package 提取核心不导入旧版 AgentVersion、
  Agent runner、Codex Process 或具体 Host factory。
- `authoring/project-behavior-extractor.ts` 在提取前做一次完整内容索引、模型返回后做完整 namespace 与 Git
  snapshot 复验，把 fixed output schema 与有界 coverage 摘要交给 bundled Codex，并返回不含旧版 Draft 或
  AgentVersion 的可移植行为与来源事实。Codex 直接在只读 Project 中选择相关证据；full inventory 只存在
  扫描器内存中，不序列化到临时文件或 Catalog。
- `authoring/project-context-compiler.ts` 是旧版 AgentVersion 编译适配层。它把纯行为提取结果投影成 V2，
  或在 formal 根不能形成 canonical Git snapshot 时投影成不自动选择嵌套仓库的 V3 behavior-only Draft，
  并在本文件内定义旧版本地 Runtime 预检端口；Package Creator 不导入这个适配层。
- `authoring/agent-text-safety.ts` 集中实现创作提取器与 Package 构建器共用的文本安全判定，不扩大协议包的
  公共导出。
- `authoring/agent-package-builder.ts` 把经过复验的 Project 语义提取结果或 exact Package Draft 确定性编译为
  根 `AGENT.md`、一个 `extracted-method` 原生技能和规范 `agent.json`。完整脱敏来源回执只返回给创作端；
  可分享 Package 仅清单绑定一个不含文件名和来源摘要的 opaque provenance digest。
- `authoring/index.ts` 是 application composition 使用的创作层内部出口。
- `project-context-compiler.ts` 是旧内部路径的薄兼容入口，保留错误类、Schema、类型与测试 seam 的同一身份，
  并从 application composition re-export 生产用编译函数。
- `application/creator-agent-composition.ts` 是唯一同时绑定创作、执行、bundled Codex、loopback Broker 与
  Worker Runtime 的旧版智能体组合根。它保留原生产接口，并把测试使用的底层依赖转换为执行层调用端口。
- `application/agent-package-composition.ts` 只把智能体包加载器与专属原生技能主机绑定到
  `AgentPackageSession`；它不导入旧版智能体组合根、Worker、Broker、Journal 或 SQLite。
- `application/agent-package-session.ts` 定义最小的 `send()` 与 `close()` 接口；一个实例只创建一个主机和一个
  Codex 任务线程，顺序多轮复用该任务线程，并在每轮显式提交智能体包声明的 Codex 原生技能，关闭时清理
  智能体包快照。它不导入 `Worker`、`Broker`、`Journal`、SQLite 或旧版 `AgentVersion`。
- `application/agent-package-authoring.ts` 编排 Project 语义提取、确定性包构建、原子发布和正式加载器重开，
  并返回内容摘要、示例任务与来源摘要；它不创建旧版 Catalog 或 `AgentVersion`。
- `application/agent-package-authoring-composition.ts` 只为智能体包创作绑定扫描器、结构化 Codex Host、构建器、
  发布器与加载器，不导入旧版执行组合根。
- `application/agent-package-creator.ts` 把 Host 提供的当前 Project 与一句制作要求绑定成不可变 Package Draft，
  并把 exact Draft 编译、原子发布和正式重载组合成第二个显式动作；Draft 阶段不产生可运行 Package。
- `application/agent-package-creator-composition.ts` 为 Creator Draft 绑定扫描器、结构化 Codex Host、Draft
  规范化器、Package 构建器、发布器与加载器，不导入 Session 或旧版执行链。
- `agent-package-session.ts` 是独立的公共推理子路径。消费者应从
  `@cb/creator-worker/agent-package-session` 导入，避免加载包根中的旧版 Worker 与本地执行模块。
- `agent-package-authoring.ts` 是独立的公共创作子路径。消费者应从
  `@cb/creator-worker/agent-package-authoring` 导入，得到内容寻址包路径与来源摘要后再显式创建推理会话。
- `agent-package-creator.ts` 是独立的 Creator Draft 公共子路径。Combo Plugin 或 Studio 用它把一句制作要求
  与 Host 已绑定的当前 Project 变成可修订 Draft，并在明确编译动作后得到 exact Package digest。
- `agent-package-cli.ts` 是 `combo-agent-package` 进程入口。`experience` 接受彼此独立的创作者来源目录与
  消费者目录，不读取确认输入，顺序完成创作、正式重载和同一 Codex 任务线程中的两轮消费；
  `draft-current` 则只使用当前工作目录和一句制作要求生成规范 Draft，不编译或运行。
- `agent-catalog-cli.ts` 是 `combo-creator-agent` 进程入口。`experience` 以一个 Project 路径完成索引、编译、
  本地未发布 Version 自动冻结、Catalog close/reopen 与第一条 frozen starter 的真实运行，不读取确认输入；
  严格 `create` 继续执行 terminal-safe 完整 review、可见 TTY 中一次 `FREEZE` 和可选 exact Version run；
  `init/import/review/freeze/run` 只保留作诊断与 V1 兼容。它不提供隐式 latest、force 或公开分享副作用。
- `local-alpha-broker.ts` 在随机 loopback 端口实现真实 R2C lease、command、PERSISTED ACK 与
  CLOUD_COMMITTED ACK，并严格绑定 terminal message、Host source、attempt 与 sealed-result marker；它不
  开放公网监听或 Cloud 身份能力。
- `local-alpha-runner.ts` 把本地 Broker、bundled Codex 与 R2E Runtime 组合成一次 fresh-state invocation；
  prompt 与回答只保留在内存，durable envelope 只写低敏关联 marker，旧 run state 不复用；内部 execution
  profile 允许 Agent runner 精确绑定一个已验证 Version，而普通 Local Alpha 仍使用固定默认 instructions。
- `local-alpha-cli.ts` 是 `combo-creator-worker` 进程入口，解析显式风险确认、终端 prompt 和 signal，并在
  完整停止后把回答写 stdout。
- `cli-signal.ts` 统一两个 CLI 的取消错误与 SIGINT、SIGTERM 退出码映射，避免一个 CLI 导入另一个 CLI。
- `index.ts` 是应用包的唯一公共出口。
- `__tests__/` 使用真实 Catalog/Worker SQLite、真实本地 WebSocket 与真实 R1 handle authority 验证完整
  接线、Project Context Compiler、V1/V2/V3 兼容和崩溃边界；opt-in real gate 还会调用真实 bundled Codex。

`worker-runtime.ts` 仍是唯一允许创建 SQLite、建立 Worker WebSocket driver 并关闭这些资源的文件；
`local-alpha-broker.ts` 只拥有相反方向的 loopback server。bundled Codex 子进程只由
`codex-app-server-process.ts` 创建和停止，pump 继续只负责串行执行。本地 CLI 不代表公网身份接线或已部署。
`authoring` 不依赖 `execution` 或具体基础设施，`execution` 不依赖 `authoring` 或具体基础设施；只有
`application` 可以同时组合这些层。
