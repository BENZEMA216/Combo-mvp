# @cb/creator-worker

## 智能体包原生推理侧

本包现在提供独立于旧版 `AgentVersion` 的 `AgentPackageSession`。智能体包（Agent Package）是真正的可加载
工件：规范化的 `agent.json` 绑定完整文件清单，根 `AGENT.md` 提供智能体级语义，
`skills/*/SKILL.md` 及其局部资源提供 Codex 原生能力。运行时先验证整个目录与智能体包摘要，再把
`AGENT.md` 作为固定开发者指令注入一个专属的内置 `Codex app-server`。验证后的字节会先物化到会话私有的
只读快照，所有文件固定为不可执行的 `0400`，目录固定为 `0500`；后续运行不再读取可变的来源目录，关闭
会话时删除快照。运行时通过 `skills/extraRoots/set` 注册快照中的技能根，并用
`skills/list(forceReload=true)` 核对每个声明技能的精确路径、名称和启用状态。任何篡改、额外文件、技能
解析错误或路径漂移都会在创建任务线程前停止。

消费接口保持最小：

```ts
import { startCreatorAgentPackageSession } from '@cb/creator-worker/agent-package-session';

const session = await startCreatorAgentPackageSession({
  packagePath: '/absolute/release-reviewer.combo-agent',
  projectPath: '/absolute/consumer-project',
  allowUnisolatedRead: true,
});
try {
  const first = await session.send('检查这次发布。');
  const followUp = await session.send('根据刚才的发现，只列阻断项。');
  console.log(first, followUp);
} finally {
  await session.close();
}
```

一个会话独占一个 `app-server` 进程和一个 Codex 任务线程；多次 `send()` 只创建新的原生轮次，因此上下文
由 Codex 原生推理框架维护。Combo 没有实现模型循环、工具循环或对话记录拼接。全局 `skill_search` 继续
关闭；运行时把智能体包精确声明的技能作为 Codex 原生 `SkillUserInput` 随每轮提交，因此系统或项目中未被
智能体包摘要绑定的技能不会加入智能体能力集合。核心命令行工具仍由 Codex 在固定的只读项目中调用。
`Worker`、`Broker`、`Journal`、传输数据库和确认消息不进入这条推理接口，它们继续作为以后可选的远程可靠交付
外层。

当前智能体包运行时只承诺 `AGENT.md`、本地 Codex 技能、同一任务线程中的多轮交互和只读项目工具。MCP、
应用、动态工具、智能体包发布签名、安装目录与崩溃后恢复会话尚未接入；不得把智能体包摘要当作发布者
身份，也不得把只读工作区根目录当作操作系统级的项目隔离。旧版 V1/V2/V3 `AgentVersion`、目录数据库、
`experience` 和 `Worker` 路径保持原字节与行为，不会被隐式转换成智能体包。

`combo.agent-package/1` 只允许零个或一个原生技能。这样每轮显式提交的是一个精确绑定的智能体包技能，
不会把多个互斥能力全量装入上下文，也不会假装 Combo 已经实现路由。包内原生按需多技能路由需要独立的
后续主机合同，不能通过重新开启会暴露系统与项目技能的全局 `skill_search` 冒充。

## 从一句制作要求创建可修订 Draft

新的 `agent-package-creator` 子路径提供 Draft 创作内核，并把创作拆成两个明确阶段。调用方先把创作者的
一句制作要求与它已经确认的当前 Project 绑定，经过 Creator 来源允许列表扫描和结构化提取后只返回
`combo.agent-package-draft/1`；这个 Draft 含身份、方法、示例任务、输出合同、来源摘要、revision 和
fingerprint，但不含本机 Project 绝对路径，也不会自动编译、发布或运行。创作任务在服务端私下保留来源
绑定，调用方只能针对当前 exact revision 提交修订，不能在编译时替换来源。只有用户选择编译后，第二阶段
才生成内容寻址 Package、原子保存并用正式加载器重新打开。Combo Plugin 的一句话路由和可视化 Studio
仍需在后续切片接入这个内核。

Creator Draft 使用独立的来源允许列表，不复用旧版 Project Context Compiler 的全物理扫描语义。扫描器在
下钻和打开内容前剪枝任意层级的 `.git`、`.codex`，以及 exact `codex-task.json`、
`codex-thread.json`、`codex-session.json`；所有符号链接也不进入 Creator inventory。这个 profile 不读取
Git classification，不调用 Git CLI，也不把这些排除项或其纯管理变化计入来源摘要。允许列表内的文件、目录
和内容仍会完整哈希并在模型返回后复验，任何允许来源漂移都会拒绝 Draft。反斜杠、控制字符等不能安全表示
为 Agent Package citation 的业务路径会明确停止，而不是被静默当作私有排除；well-formed Unicode 路径保留
文件系统返回的 exact 形式，不做 Unicode 规范化。

结构化 Creator Host 不直接挂载原 Project，而只收到一个临时允许列表投影。投影只含经过摘要复验的普通
文件，文件权限固定为 `0400`，目录固定为 `0500`，Host 停止后必须清除；清除失败是可见的停止错误。模型
返回的 citation 还会再次硬拒绝上述私有路径和非普通文件。这个投影闭合了当前 Project 内的 Creator 来源
边界。Creator 初扫与投影复制会在正文读取前后核对 canonical containment、lexical path、已打开 fd 和来源
身份，稳定符号链接及一次性中间目录置换会在消费正文前停止；Node 当前没有使用 `openat(2)` 逐段锁定路径，
因此同 UID 对手反复竞态下的 OS 级隔离仍为 `NOT_PROVEN`。bundled Codex 也仍与桌面用户同 UID，不构成
操作系统级的全盘读取隔离；不得把它描述为 Host 在操作系统层只能看到 Project。

```ts
import { createCreatorAgentPackageDraftFromCurrentProject } from '@cb/creator-worker/agent-package-creator';
import {
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
  createCreatorAgentPackageCreatorRequest,
} from '@cb/creator-agent-protocol/agent-package-draft';

const authoringTask = await createCreatorAgentPackageDraftFromCurrentProject({
  request: createCreatorAgentPackageCreatorRequest({
    protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
    intent: 'create_agent_package_from_current_project',
    request: '请阅读 combo.workflow.md，把当前目录跑通的方法提炼成一个 Agent。',
  }),
  currentProjectPath: hostBoundCurrentProject,
  allowUnisolatedRead: true,
  allowSensitiveProjectContext: true,
});

// Studio 展示 authoringTask.readDraft()，并通过 authoringTask.revise(...) 提交 exact 修订。
// 来源 Project 只保留在这个服务端任务中，不能由 Studio 重新提交。
const reviewedDraft = authoringTask.readDraft();
const compiled = authoringTask.compile({
  draftId: reviewedDraft.draftId,
  draftRevision: reviewedDraft.revision,
  draftFingerprint: reviewedDraft.draftFingerprint,
  storeDirectory: privatePackageStore,
});
```

开发者还可以在一个已安装该命令的当前 Project 中运行
`combo-agent-package draft-current "一句制作要求"`，得到规范 Draft JSON。该命令只用于验证 Draft 创作
内核的参数与输出合同，不是最终用户需要理解的终端流程，也不代表 Codex 已经提供焦点 Project 绑定。

### 原生 Creator 授权语义与旧 Hook 兼容路径

长期入口的目标不是让 Skill、MCP 或 Combo 自己签发授权，而是由顶层 Codex Host 展示一次性 Creator
授权卡，并在自己的受认证 ledger 中绑定当前 thread、turn、item、Project generation、制作要求摘要和 exact
executor。仓库当前只冻结了 path-free 授权卡 claims 和一个内部 ordering seam：它先向未来
`CreatorAuthorizationRedemptionPort` 兑换当前 Host dispatch，再把兑换得到的内部 Project lease 交给
Draft 内核。该 lease 包含 canonical path/device/inode 和同步 `assertCurrent()`；scanner 在首个目录读取
边界必须同时重新核对 ambient Host dispatch/workspace generation 与本地目录 identity。返回面只有 Draft
读取与修订，不暴露 Package compile。

业务调用方不能提交 authorization handle、thread、turn、item、Project binding、workspace generation 或
executor。生产包也没有 Creator mint/consume API、没有公开 authorized 子路径，且没有任何生产 composition
导入该内部 seam；clean production build 也不携带该内部文件。因此当前没有真实 Host adapter 时，这条长期
入口就是不可调用的 fail-closed 状态，不会回退到 legacy Bridge。

授权 scope 固定为只生成 Draft、零 Project mutation、向 Codex 模型服务发送选定的 Creator Project 上下文，
并只向 Combo 返回 Draft 与相对引用；它显式标记读取隔离为
`same_uid_unisolated_not_os_enforced`，不能把 Project 绑定冒充 OS 沙箱。Project path/device/inode 仅属于
未来 authenticated adapter 到应用层的内部 lease，不进入 public claims、handoff、模型 prompt、Draft 或
Package。同步 lease 只是本地应用端口要求，不是已经冻结的跨进程 wire；真实实现也可以改为 Host 打开的
目录 descriptor。

当前状态是 `HOST_AUTHORIZATION_SEMANTICS_AND_ORDERING_READY`，不是普通用户 UAT 完成。Codex
`0.148.0-alpha.15` 没有向 Combo 暴露 Creator 自定义审批卡 API；真实完成仍要求顶层 Host UI、用户点击、
mutual-auth IPC、Host 侧一次性原子 ledger、workspace generation 核对和 exact executor dispatch。仓内
Fake redemption port 只证明调用顺序，不能冒充 Host authority。现有 0.8.3 Hook / Bridge 保持独立的
`LEGACY_HOOK_COMPAT_V1` 路径；Hook 失败、用户拒绝或原生授权失败不得静默降级。

为 Combo Plugin 提供的 `combo-agent-package-creator-bridge` 是另一个独立进程入口。创作者最终说出的完整
句子可以包含官方创建指南地址；Plugin 只用白名单地址选择固定的
`combo.agent-package-creator-guide/1`，不会把网页地址写入制作要求。Plugin 随后在已经正式绑定当前 Project
的 Codex 子任务中启动桥接文件，并把该 Project 作为命令工作目录。桥接进程不接受路径参数，只从标准输入
读取一个规范 `combo.agent-package-creator-bootstrap-handoff/1`，完成真实扫描和结构化提取后只在标准输出
返回一个规范 `combo.agent-package-draft/1`。这条桥接链不会编译、试跑、发布或分享 Package；可视化 Studio
和 Plugin 的一句话路由属于后续切片。

桥接进程还要求受信 adapter 设置固定的
`COMBO_AGENT_PACKAGE_CREATOR_HOST_BINDING=codex_host_current_saved_project` 标记；没有标记时会在扫描前
拒绝。该标记不携带路径，也不是密码或 Host 身份证明。真正的 Project 权威仍来自 Plugin 创建的
同 Project Codex 子任务；Plugin 集成测试必须同时核对该子任务的 Project ID、命令工作目录和桥接文件摘要。
因此直接从普通终端设置环境变量运行桥接文件不属于受支持的用户入口。

构建产物 `dist/agent-package-creator-bridge.mjs` 是面向 Node 24 的单文件模块，已把工作区 JavaScript 依赖
打包进去，运行时只保留 Node 内置模块、Git、桌面内置 Codex 与本机认证依赖。它供 Plugin 固定摘要后携带，
不是要求普通用户在终端里执行的入口。

桥接失败只输出一个 `combo.agent-package-creator-bridge-error/1` JSON 对象，字段固定为 `protocol`、`code`、
`stage` 和安全文案。正常 Creator 路径会区分 Project 绑定、来源读取、来源上限、来源变化、Host 失败、
结构无效、策略拒绝、Draft 无效和清理不完整；内部配置、旧版 Runtime 分支与任意未知异常统一停止为
`INTERNAL`。对应稳定 code 为 `CURRENT_PROJECT_UNAVAILABLE`、`SOURCE_READ_FAILED`、`SOURCE_LIMIT`、
`SOURCE_CHANGED`、`HOST_FAILED`、`OUTPUT_INVALID`、`OUTPUT_REJECTED`、`DRAFT_INVALID` 和
`CLEANUP_INCOMPLETE`。`OUTPUT_REJECTED` 不说明触发了哪条安全规则，也不暴露 Project 值；cause、stack、
Host 原始错误和 Project 字节都不会进入标准错误输出。`EXTRACTION_FAILED` 只为旧版同协议生产者保留，
不由当前正常分类路径发出。Bridge 不会对任何失败自动重试，避免重复模型轮次、费用或不确定副作用。

## 从 Project 直接创建并消费 Agent Package

新的创作接口不会经过旧版目录数据库或 `AgentVersion`。它复用 Creator 来源允许列表扫描、只读投影、
结构化 Codex 提取和完整复验机制，随后由代码确定性生成根 `AGENT.md`、一个 `extracted-method` 原生技能与规范
`agent.json`。输出先写入私有同文件系统临时目录，完成文件同步后按包摘要原子改名；摘要目标已存在时不会
覆盖。正式加载器会立即关闭创作阶段并重新打开已发布目录，只有文件清单、摘要和规范清单完全一致才返回。

创作接口与推理接口分别位于两个公共子路径：

```ts
import { createCreatorAgentPackageFromProject } from '@cb/creator-worker/agent-package-authoring';
import { startCreatorAgentPackageSession } from '@cb/creator-worker/agent-package-session';

const built = await createCreatorAgentPackageFromProject({
  sourceProjectPath: '/absolute/creator-source',
  storeDirectory: '/absolute/private-package-store',
  allowUnisolatedRead: true,
  allowSensitiveProjectContext: true,
});
const session = await startCreatorAgentPackageSession({
  packagePath: built.packagePath,
  projectPath: '/absolute/consumer-project',
  allowUnisolatedRead: true,
});
try {
  console.log(await session.send('处理这个消费者项目中的真实任务。'));
  console.log(await session.send('继续刚才的任务，只返回已验证的下一步。'));
} finally {
  await session.close();
}
```

单用户本机体验可直接运行一条命令：

```bash
pnpm --silent --dir apps/creator-worker package-experience -- \
  "/canonical/absolute/creator-source" \
  "/canonical/absolute/consumer-project"
```

这里的 `--` 是包管理器转发参数时使用的分隔符，命令行会明确接受它；直接调用
`combo-agent-package experience` 时可以不写该分隔符。

该命令不要求确认输入。执行命令本身表示用户授权读取受控创作者来源目录中的 Creator 允许列表，并接受相关内容可能进入
本机 Codex 使用的模型服务。命令会创建并重载不可变智能体包，再在独立消费者目录中启动一个新的 Codex
任务线程，顺序执行包内第一条示例任务和一条连续任务。它不做裸 Codex 对比、不写两个 Project、不发布或
分享智能体包。创作者来源目录和消费者目录必须是彼此独立的真实绝对目录；私有包默认保存到
`~/Library/Application Support/Combo/agent-packages`。

智能体包摘要和保存路径会在试跑前输出。若后续会话启动、任一轮或关闭失败，命令会明确说明智能体包已经
保留且只有试跑未完成；此时不要重新提取，可以用已输出的 `packagePath` 通过公共会话接口继续消费。

创作结果包含来源根摘要、引用文件摘要、智能体包摘要与正式重载通过标记。这个结果能证明来源、产物和消费
之间的技术连续性，但不能证明模型理解了全部来源，也不能证明提取效果优于裸 Codex。当前 Host 与桌面用户
同一身份，消费者目录的物理分离仍不是操作系统级信息隔离；严格未知测试材料必须在包冻结后才创建，或在
独立用户和容器中执行。

## 旧版 AgentVersion 一条命令体验

当前单用户受控 Alpha 的消费入口只有一条命令：

```bash
pnpm --silent --dir apps/creator-worker experience -- "/canonical/absolute/project"
```

执行这条命令本身就表示用户授权本机进程全量读取该 Project，并接受 `.env`、日志、任务记录和其他敏感
内容可能进入 bundled Codex 使用的模型服务，以及当前 Host 没有操作系统级 Project-only 读隔离。命令会
完成全量索引、Agent Draft 编译、全部合同校验、仅本地未发布 Version 的自动冻结、关闭并重开 Catalog，
然后自动运行冻结 Version 的第一条 starter prompt。它不要求输入 `FREEZE`，也不要求用户理解 Catalog、
Draft、Version 或运行参数；stderr 会显示四阶段进度，stdout 最后输出 Agent 摘要和真实试跑结果。formal
Project 根能形成受支持 Git snapshot 时产出 V2；聚合目录、尚无首个 commit 或不能形成 canonical snapshot
时产出 V3 behavior-only Agent。后者不会自动选择嵌套仓库，运行时也不会挂载原 authoring Project。

`experience` 的自动冻结授权固定为 `LOCAL_UNPUBLISHED_AUTO_FREEZE_V1`，只适用于本地未发布 Catalog；它
不是人工审阅声明，也不会创建 public share、Capability 或云端发布。需要逐字审阅 Draft 时仍可使用后文的
严格 `create`，其 TTY 与 `FREEZE` 合同没有被放宽。如果 Version 已创建而首次试跑失败，命令会明确输出
exact agentId/versionId 并说明不要重新创建；这个失败不会回滚已冻结的本地 Agent。

## Agent 创作与执行边界

Project Context Compiler 属于 Agent 创作层，负责索引 Project、调用结构化 authoring Host，并输出可被
旧版 Draft 或新智能体包编译器消费的语义提取结果。旧版路径继续生成 Draft，并通过一个窄的运行兼容性端口
做冻结前预检；新路径直接生成不可变智能体包，不创建 Catalog 或 `AgentVersion`。immutable AgentVersion
仍是旧版创作层与执行层之间的数据边界。
执行层只验证并运行 exact Version，不读取可变 Draft，也不依赖 Project Context Compiler。具体 bundled
Codex Host、loopback Broker 和 Worker Runtime 只在 application composition 中接线；CLI 负责顺序调用这些
用例，但不成为二者共享的领域实现。仓库测试会拒绝创作层反向导入执行实现、执行层导入创作实现，以及基础
设施反向依赖任一 Agent 领域层。

当前仍保留旧的内部文件名作为薄兼容入口，避免改变根导出、测试 seam 与两个 CLI bin。它们只做 re-export，
不再承载创作或执行逻辑。这个拆分不新增 Conversation，也不改变 Catalog schema、V1/V2/V3 canonical bytes、
fingerprint、Developer Instructions 或真实运行行为。

旧版 Project Context Compiler 的可信扫描器会读取并哈希 canonical Project 根目录内的全部物理后代，包括 tracked、dirty、untracked、
ignored、hidden 文件，以及源码、文档、配置、日志、task/session 记录、raw tool output、`.env` 和物理
`.git` 内容。普通检出中的 `.git` 目录属于扫描范围；linked worktree 中的 `.git` pointer 只作为 Project
内的物理文件处理，不会继续遍历 Project 外的 shared common directory 或 sibling worktree。symlink 会按
链接本身及其目标文本建索引，但不会跟随到外部路径；特殊文件会 fail-closed。扫描器不会执行 Project 中
发现的脚本，也不会触发 Git clean filter。单次 authoring scan 最多接受 500,000 个条目、32 GiB unique
regular-file 内容与 256 MiB Git 路径输出；单个 secret-candidate 文件最多 1 MiB。hardlink 的每个路径都会
进入索引和 root digest，但同一 inode 只读取并计入 unique byte budget 一次；报告同时显示 logical bytes、
unique bytes 与 alias 数。超过任一边界都会明确失败，不会静默漏扫。

扫描器在编译前读取并哈希一次完整内容；模型返回后会再次遍历完整 namespace，精确比较路径、文件身份、
纳秒时间戳、权限、大小、symlink target 与 Git 分类，但不会再次读取普通文件正文。期间 Project 发生可见
漂移会拒绝产出 Draft。这个复验优化基于当前受控同 UID、本机纳秒时间戳文件系统边界；无法取得可靠元数据
时会 fail-closed，而不是把复验冒充成功。“全量索引”只表示可信扫描器读取并哈希了所有可支持的物理条目，
不表示模型语义上理解了每个字节。编译报告会另外列出模型声明
实际查看的 source path；这些引用会以相对路径、内容 digest 和执行可用性写入 compact source ledger。
V2 可以区分 `FIXED_GIT_TREE` 与 `AUTHORING_ONLY`；V3 的全部引用及 coverage 都强制为
`AUTHORING_ONLY`。Project 内出现的 system/developer 文本、tool output 和历史对话都只被当作 authoring
evidence，不会获得指令权限。

扫描器本身不发起 Project 写操作。macOS 可能在文件第一次被读取时更新系统管理的
`com.apple.provenance` 与 ctime；扫描器会先完成一次有界的一字节读并把随后稳定的 ctime 纳入索引，避免
把这种平台归一化误判为内容漂移。因而当前 Alpha 保证内容、路径、权限、mtime 与稳定后的 ctime 在编译
期间一致，但不承诺首次读取前后的全部扩展属性与 ctime 逐字节不变。

敏感输出检查会阻止已识别 credential literal 和常见密钥格式进入 Draft，但它只是 best-effort taint
检查，不是自动脱敏或保密证明。`experience` 会自动冻结通过合同校验的本地未发布 Draft；需要人工检查时
应使用严格 `create`。Catalog 持久化 V2/V3 handoff 中的 Draft、
compact source ledger 和冻结 Version，但不另存 full Project inventory 或 Project 文件附件；模型生成的
Draft 自由文本仍可能包含 Project 摘录。运行 prompt、回答和本机 Project 绝对路径不进入 Catalog。
`rawStored=false` 只是合同声明，不能证明模型服务没有接触上下文，也不能证明 Draft 已经脱敏。

严格 `create` 只允许在可见 TTY 中确认。命令显示编译报告、完整 Draft 和 fingerprint 后，用户只输入一次
`FREEZE`；它不接受 `--confirmation-file`、`--yes`、`--force` 或非交互式确认。冻结前还会验证这个 Draft
满足当前 Runtime 合同。V2 必须能从 exact Git commit/tree 物化 tracked tree；V3 必须声明
`projectBinding=none`，且全部 source evidence 只用于 authoring。冻结后命令会关闭并重新打开 Catalog，按
exact `agentId+versionId` 读取 Version。

默认 Catalog 位于
`~/Library/Application Support/Combo/creator-agent/catalog/creator-agents.sqlite`。显式 Catalog 路径必须
是 canonical absolute path，并且位于 Project 外；macOS 临时目录应使用 `/private/tmp/...`，不能使用会经
symlink 解析的 `/tmp/...`。Catalog 父目录必须由当前用户拥有且不可被 group/other 访问。显式运行状态目录
同样必须位于 Project 外。

## 手工诊断与兼容入口

严格创建命令保留给需要逐字审阅 Draft 的开发者：

```bash
combo-creator-agent create \
  --project "/canonical/absolute/project" \
  --allow-unisolated-read \
  --allow-sensitive-project-context
```

`init`、`import`、`review`、`freeze`、`list`、`show-version` 和 `run` 继续用于精确重放、排错和 V1 handoff
兼容，不是新的用户主流程。手工 `freeze` 会重新显示完整 Draft；TTY 中必须逐字输入 Catalog 给出的 exact
确认文本，自动化只能显式提供不带额外换行的 `--confirmation-file`。这些命令也没有隐式 latest Version、
Draft JSON fallback 或公开分享副作用。

```bash
CATALOG="/absolute/private-directory/creator-agents.sqlite"

combo-creator-agent init --catalog "$CATALOG"
combo-creator-agent import --catalog "$CATALOG" --handoff-file "/absolute/draft-handoff.json"
combo-creator-agent review \
  --catalog "$CATALOG" --agent-id agent.example --draft-id draft.example --draft-revision 1
combo-creator-agent freeze \
  --catalog "$CATALOG" --agent-id agent.example --draft-id draft.example --draft-revision 1
combo-creator-agent run \
  --catalog "$CATALOG" --agent-id agent.example --version-id "<freeze 输出的 versionId>" \
  --project "/absolute/project" --prompt-file "/absolute/prompt.txt" --allow-unisolated-read
```

手工运行 V1/V2 时必须提供 `--project`；运行 behavior-only V3 时必须省略 `--project`。后者使用新的空私有
临时目录，不会重新读取创建 Agent 时的 authoring Project。

这仍是受控的单用户本地 Alpha。旧版 `experience` 不会创建 `combo.codex-agent-share/1`、能力对象、云端目录
或多轮会话；新的 `AgentPackageSession` 只提供进程内同一任务线程的多轮交互。两者都没有操作系统级的
项目文件隔离，因此不得用于不可信用户、不可信项目或公网流量。扫描器会检测常见路径替换并在异常时停止，
但不声称能够抵御同一用户身份的恶意进程在每个文件系统调用之间实施的精确竞态；这种本机进程隔离仍属于
后续监管进程。

## 不可变 AgentVersion 执行

本包现在能让同一个经过完整性校验的 `AgentVersion` 在本地可靠执行。对 V1/V2，Worker 会验证 Version
fingerprint、canonical origin 与本机对象库中的 commit/tree，再只从 Git blob 创建一个私有 tracked-tree
execution snapshot。对 V3，Worker 拒绝调用方传入 authoring Project，改为创建一个空的私有临时目录；
bundled Codex 只能使用冻结行为和本轮用户输入，不能声称运行时仍能读取创作语料。两类临时目录都在 Host、
Runtime 与 Broker 完整停止后删除。AgentVersion instructions 会编译成该次 Host 的固定 developer
instructions，version fingerprint 同时进入 invocation input fingerprint，运行中不会读取可变 Draft 或
“当前版本”。

`AgentDraft` 与 `AgentVersion` 的纯值合同位于 `@cb/creator-agent-protocol/agent`。V1 保留 current-task
或 manual handoff 兼容；Project Context Compiler 根据 formal 根的 Git 能力产生 V2 Git-backed 或 V3
behavior-only Definition、Draft、handoff 与 Version，并把 compact source ledger 绑定到全部下游
fingerprint。三代 Draft 都通过新 revision 修订且不可执行，
每个 DraftSnapshot 本身不可变；Version 从一个精确 Draft revision 冻结并可 canonical JSON round-trip。
Version 不保存本机绝对路径、运行 prompt 或回答。本阶段可对同一 Version 发起多个彼此隔离的 fresh run；
它们各有独立 ephemeral thread 和双 SQLite，尚不共享多轮 Conversation 记忆，也不能在进程重启后续接旧
thread。

创建时，ignored、untracked、日志和 task/session 内容可以参与 Agent authoring。冻结后的 V2 只物化
Version 绑定的 commit-pinned tracked Git tree；V3 完全不挂载原 Project，只运行已冻结的行为。所有标为
`AUTHORING_ONLY` 的证据都不会被偷偷复制进运行目录，因而可能塑造 Agent instructions，却不能作为运行期
文件读取。手工 current-task handoff 只保留作诊断兼容路径，不能再用它描述新的主流程。

这里的 `combo.creator-agent-version/1`、`combo.creator-agent-version/2` 和
`combo.creator-agent-version/3` 都是尚未发布的本地执行合同。
它们既不等同于公开分享链的 `combo.codex-agent-share/1`，也不是旧 `CapabilityDefinition`。后续必须通过
显式投影或迁移合同连接这些体系，不能把当前 local Alpha 描述成现有分享、Capability catalog 或云端运行
入口。

Project Context Compiler 的本机显式真实门槛为
`pnpm -F @cb/creator-worker test:real-context-compiler`。它对 sanitized 临时 Git Project 完成全量索引、
真实 bundled Codex 编译、V2 Catalog import、review、freeze、close/reopen 和 exact Version 本地运行，并
核对原 Project 零变化及敏感内容、prompt 和回答不落 Catalog 或 Worker SQLite。原有
`pnpm -F @cb/creator-worker test:real-agent` 继续验证预制 frozen Version 的底层执行链。
该 real gate 同时包含 V3 behavior-only 一轮，证明真实 bundled Codex 能在不挂载 authoring Project 的空临时
目录中完成任务。

## 本地 Alpha 闭环

本包现在提供一个仅供单用户、受控环境体验的完整本地入口：

```bash
pnpm --silent --dir apps/creator-worker local \
  --project "/absolute/path/to/project" \
  --allow-unisolated-read
```

命令会在终端询问任务；也可用 `--prompt "非敏感任务"` 做自动化，但命令行文本会进入 shell history 和
进程列表。入口在 `127.0.0.1` 随机端口启动进程内 Broker，依次接通真实 bundled Codex、R2E Runtime、
Journal SQLite、Transport SQLite 和串行 pump。stdout 只输出最终回答，运行状态写 stderr；端口、authority
ID、fingerprint、auth 路径与原始协议帧不会输出。

默认每次运行都在 Project 外创建新的
`~/Library/Application Support/Combo/creator-worker-alpha/<project-hash>/runs/<run-id>/`。显式
`--state-dir` 也必须尚不存在或为空目录；非空目录不会被改权限或写入，两库只剩一份或已属于旧运行时
都会 fail-closed。当前 prompt 与回答正文
只在内存，SQLite 只保存 fingerprint、执行事实与低敏结果 marker。因此正常运行和同一进程内 WebSocket
重连有完整闭环，但进程在 terminal commit 后、打印前崩溃时无法恢复回答，也不会在重启后继续同一
Codex turn。旧状态会保留用于诊断，R2E 自身的 reopen/recovery 能力继续由底层测试验证。

成功回答只有在本地 Broker 收到当前 invocation 的 TERMINAL fact、发送 exact `CLOUD_COMMITTED` ACK、
Runtime 从 Transport SQLite 确认这条 logical delivery 已变为 `ACKED`，且 bundled Codex 与 Runtime 都
干净停止后才打印。这个入口不绕过 durable intent、Host authority、terminal commit 或 ACK commit；本地
Broker 只替代尚未存在的 Cloud Broker。

本应用包实现 Creator Worker 的 R2D 串行 pump、R2E 唯一运行时组合根
`createCreatorWorkerRuntime()`，以及 R2F bundled Codex Host。组合根用一个明确的
`CREATE_FRESH | OPEN_EXISTING` 模式打开两份互不重叠的 SQLite，启动可信 Host、获取两个 owner、构造
WebSocket driver 与 pump，并运行单一自调度 tick 循环。它不暴露 store、owner、driver 或 pump
capability。

`start()` 只有在 Host 已启动、Journal recovery 已提交、两个 owner 已获取、Broker 首个 lease 已持久化且
首个 pump tick 成功后才进入 `READY`；这不代表 Cloud 已确认任何业务结果。暂时离线时默认保持
`STARTING` 并继续安全重连，也可用 `readyTimeoutMs` 设调用方边界。scheduler、pump 或 driver 的永久
失败会把 Runtime 锁为 `BLOCKED` 并自动执行尽力清理，不会继续接收命令。

Runtime 另有独立的 Journal owner heartbeat；它不依赖 tick 返回，因此 resolver 或网络 flush 正在等待时
仍会续租。heartbeat 失败与 pump/driver 永久失败一样进入 `BLOCKED`。停止时会为两个 exact owner 续一个
覆盖 driver、pump 与 Host 收敛窗口的有界 teardown lease；Journal heartbeat 继续运行到 Host 停止完成，
避免旧 Host 尚未退出时先丢失 authority。

停止时先禁止新 tick，并在同一事件轮次同时触发 driver 与 pump 停止；随后等待 scheduler、续租、停止
Host，再终止 heartbeat 并用 exact owner 关闭 transport 与 journal。每个清理步骤即使失败也继续后续步骤，最终以
`RUNTIME_STOP_INCOMPLETE` fail-closed。pump 在停止时生成的保守 UNCERTAIN terminal 可能要到下一次
`OPEN_EXISTING` 启动的首个 tick 才交给 transport；Runtime 不把本地 ENQUEUED 冒充 Cloud ACK。

底层 pump 把 Broker command 先提交到 Invocation Journal，再把 command 标为已应用，最后才启动 journal
签发的 Host after-commit effect。Host 回包只重新进入同一 mutation 队列，不会在队列中等待 turn
outcome，因此运行中的取消命令不会被长任务阻塞。

`invocation.start` 只持久化 `inputRef` 与 `inputFingerprint` 所在的 Broker command。resolver 返回的
fingerprint 必须逐字匹配，真实输入还要通过 R1 `HostStartTurnInputSchema`；prompt 只存在于一次
`Host.startTurn()` 调用的局部变量。resolver 同时收到 pump 生命周期 `AbortSignal`，并受默认 10 秒的
内部有界 timeout 约束；即使 resolver 忽略 signal，`stop()` 也不会无限等待。STARTED/TERMINAL fact
以 `factId + payloadFingerprint` 幂等写入独立 transport SQLite，成功 terminal 同时携带 sealed
envelope。sealer envelope 会在 terminal journal commit 前通过 R2C payload schema；不兼容输出会让
pump fail-closed，并把 Invocation 留在 RUNNING，不会产生无法 handoff 的 terminal poison。此失败不在
同一 pump 内重试 Host 或 seal；组合根应停止并按保守 recovery 处理。只有 transport enqueue 已提交
后，journal 才标记 handoff 完成。

`createBundledCodexHost()` 只接受真实 Project 路径与固定 developer instructions，并强制调用方显式传入
`allowUnisolatedRead: true`。这个确认项表示当前 core shell 与桌面用户同 UID，仍可能读取 Project 外的
用户文件，包括原始 Codex 配置或登录文件；私有 HOME/CODEX_HOME 只缩小默认配置面，不构成凭据隔离。
因此 R2F 只能用于受控的本机测试 Project 和受控 prompt，不得接入不可信用户或公网流量。它不从 PATH
fallback，而是在桥接 `auth.json` 前校验 ChatGPT.app 内的 Codex 版本；每次运行使用私有
HOME/CODEX_HOME，关闭
MCP、Apps、Plugins、Hooks、memory、browser、web search 与动态工具，并要求 app-server 精确回读 Project
root、`:read-only` 和 `networkAccess=false`。这些 workspace roots 是协议事实，不是 OS 级 Project-only
文件可见性证明；内置 code-mode host 只保留为当前 Codex 调用只读 core shell 的编排层，不开放 MCP、
browser、web search 或模型可调用的动态网络工具，并要求工具沙箱回读 `networkAccess=false`；app-server
自身仍需认证和模型推理网络，公网 Worker 仍需后续 isolation supervisor。adapter 的 `timeoutMs` 只会把
缺失终态记为 evidence lost 并停止该 Host，不会绕过 Journal 的 durable timeout intent 自行伪造
TURN_TIMEOUT。

低层 `createWorkerSerialPump()` 仍可用于定向测试；它本身不拥有外部资源。本地 Alpha 已有 CLI/process
entry 与 SIGINT/SIGTERM 有界停止，但仍没有 OAuth、Secure Enclave、正式 Broker challenge、Gateway、
Cloud PostgreSQL、指标告警或部署清单。本地 Broker 只监听 loopback，因此当前 Preview/Production 不会
自动启用这条新链路。
