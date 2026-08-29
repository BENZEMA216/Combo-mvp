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
- `project-context-index.ts` 保留旧版全物理 profile，并新增 Agent Package Creator 来源 profile。旧 profile
  对 canonical Project 的全部物理后代执行有界只读索引，记录 symlink 本身，并区分 Git 分类；Creator
  profile 在遍历和打开前剪枝 `.git`、`.codex`、exact Codex Host task/thread/session 元数据和所有 symlink，
  不执行 Git 分类或 Git CLI。Creator 摘要与复验忽略被排除管理项造成的目录 metadata 变化，但仍以允许
  namespace 和普通文件身份拒绝真实来源漂移；不可安全表示的非私有路径会 fail closed，well-formed Unicode
  路径保留文件系统 exact 形式。Creator 正文读取前后还核对 canonical containment、lexical path、fd 与来源
  identity；这覆盖稳定符号链接和一次性置换，不证明同 UID 反复竞态下的 OS 隔离。两个 profile 都不会执行 Project 脚本或 Git clean filter。文件首次读取时
  允许 macOS 只更新系统 provenance/ctime，并以同一文件描述符上的 post-read stat 作为稳定索引基线。首轮
  内容哈希后，它还保留仅在内存的 bigint 元数据 manifest，用完整 namespace 与文件身份复验替代第二次正文
  读取，并输出有界扫描进度。
- `authoring/creator-project-source-projection.ts` 只接受 scanner 签发的 exact Creator-profile scan，把允许
  普通文件按摘要复验后复制到临时 `0400`/`0500` Host workspace；原 Project 路径、私有 metadata 和 symlink
  不进入投影，复制前后会以 O(1) manifest lookup 复验 scan inode，投影身份异常或清理失败都会显式报错。
- `authoring/file-descriptor-path-binding.ts` 在 Creator 初扫与投影正文读取前后核对 lexical path、canonical
  Project containment 及已打开 fd 的 dev/ino；这是 Node 无 `openat(2)` 时的一次性置换防线，不声称同 UID
  反复竞态下的 OS 隔离。
- `authoring/ports.ts` 只定义结构化 authoring Host 窄端口；纯 Package 提取核心不导入旧版 AgentVersion、
  Agent runner、Codex Process 或具体 Host factory。
- `authoring/project-behavior-extractor.ts` 在提取前做一次来源索引、模型返回后做同 profile 复验，把 fixed
  output schema 与有界 coverage 摘要交给 bundled Codex，并返回不含旧版 Draft 或 AgentVersion 的可移植
  行为与来源事实。旧版目标继续直接读取原 Project 并复验 Git snapshot；Agent Package Creator 必须提供
  私有来源投影，缺少投影即配置失败，且 citation 会再次拒绝私有路径和非普通文件。
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
- `application/agent-package-authoring-composition.ts` 只为智能体包创作绑定 Creator 来源扫描器、只读 Host
  投影、结构化 Codex Host、构建器、发布器与加载器，不导入旧版执行组合根。
- `application/agent-package-creator.ts` 把 Host 提供的当前 Project 与一句制作要求绑定成不可变 Package Draft，
  并把 exact Draft 编译、原子发布和正式重载组合成第二个显式动作；Draft 阶段不产生可运行 Package。
- `authoring/current-conversation-draft-extractor.ts` 定义未接线的 ambient Desktop current-task lease 合同：
  只用制作要求 digest 打开 Host-owned 来源，要求 direct-user、active-task、user-visible-only、完整快照和
  `rawStored=false`，且快照固定截止于 direct creator item 之前。digest 核对后，exact 制作要求作为独立指令
  进入唯一一次无工具结构化提取；模型只看到 bare Draft output schema，Host 必须在 sealed snapshot 边界内做
  verbatim/credential egress 检查，并在模型输出之外包装与 snapshot/request/extraction candidate
  digest 绑定的 receipt。最终 V2 Draft fingerprint 属于另一摘要域，验收 receipt 以显式 projection 同时绑定二者。
  receipt 缺失、拒绝或错绑均停止。提取前后核对 `assertStillCurrent()`，并在所有终态关闭。它不接收
  Project、task/thread/session/item ID 或 transcript，也不导入 scanner、Bridge、child process、Package
  builder、Session 或 Runtime。
- `application/agent-package-current-conversation-draft.ts` 把上述脱敏提取结果封装为
  `combo.agent-package-draft/2`，返回面只有 `readDraft()` 与 exact `revise()`，没有 compile 或 fallback。
  它与 extractor 一样进入 production build，但只由
  `application/agent-package-current-conversation-composition.ts` 导入；该 composition 当前绑定固定 unavailable
  Host，并由 `agent-package-current-conversation-draft.ts` 暴露窄 public facade。真实 Host adapter 不存在时，
  它只会固定安全停止，不能作为用户路径或 Host 验收证据。
- `application/unavailable-current-conversation-draft-host.ts` 是当前唯一 production ambient Host 实现。它不
  接收 task/thread/session、transcript 或 Project，也不读取任何来源；调用必然停止为 source unavailable。
- `application/agent-package-creator-authorized.ts` 是未接线的原生 Host authorization ordering seam：业务
  options 只含制作要求与普通运行控制；它先把本地计算的 request digest 和受信 executor digest 交给未来
  dispatch-scoped redemption port，验证返回的 claims 与内部 Project lease 后才调用 Draft 内核；lease 的
  `assertCurrent()` 会在外层绑定和 scanner 首读点分别核对 Host 状态。返回面只有 Draft 读取与修订，没有
  Package 编译能力，也不解析旧 Hook grant。
- `application/host-authorized-creator-project-source.ts` 在 Creator scanner 的首个目录读取边界核对 Host 私有
  lease 的 ambient dispatch/workspace generation 与 canonical path/device/inode；随后复用 scanner 已有的
  目录、文件描述符和终态复验，避免外层检查后重新绑定另一个 Project。
- 当前没有 production composition 导入上述两个 Project authorization 文件；真实 authenticated Project Host
  adapter 出现前，它们只构成内部顺序、来源与首读绑定 seam，并继续由 production tsconfig 排除。
  Current-conversation ordering seam 则由固定 unavailable composition 导入，生产调用不能成功，也不能接入
  Fake 或业务方自带 Host。
- `application/agent-package-creator-composition.ts` 为 Creator Draft 绑定 Creator 来源扫描器、只读 Host
  投影、结构化 Codex Host、Draft 规范化器、Package 构建器、发布器与加载器，不导入 Session 或旧版执行链。
- `application/agent-package-creator-bridge.ts` 验证 Plugin 交来的版本化 handoff，只从受信 Host adapter
  解析当前 Project，再调用现有 Creator Draft 用例并核对返回 Draft 仍绑定原制作要求。它穷尽映射来源、
  Host、结构、安全策略和清理错误；Creator 内部配置与未知异常统一停止为不含内部详情的 `INTERNAL`。
- `agent-package-session.ts` 是独立的公共推理子路径。消费者应从
  `@cb/creator-worker/agent-package-session` 导入，避免加载包根中的旧版 Worker 与本地执行模块。
- `agent-package-authoring.ts` 是独立的公共创作子路径。消费者应从
  `@cb/creator-worker/agent-package-authoring` 导入，得到内容寻址包路径与来源摘要后再显式创建推理会话。
- `agent-package-creator.ts` 是独立的 Creator Draft 公共子路径。Combo Plugin 或 Studio 用它把一句制作要求
  与 Host 已绑定的当前 Project 变成可修订 Draft，并在明确编译动作后得到 exact Package digest。
- `agent-package-creator-bridge.ts` 是供 Combo Plugin 携带的单次进程入口。它不接收 Project 路径参数，读取
  一个规范 Creator handoff，返回一个规范 Draft；构建阶段会把该入口及其 JavaScript 依赖打成 Node 24
  单文件模块。进程会在扫描前检查无路径的 Host adapter 启动标记；Project ID 与命令工作目录的权威核对
  仍由 Plugin 的同 Project 子任务负责。失败行只序列化固定协议、错误 code、阶段和安全文案，不序列化
  cause、stack、Host 原始错误或 Project 字节，也不会自动重试。
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
