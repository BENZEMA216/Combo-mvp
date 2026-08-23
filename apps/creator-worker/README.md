# @cb/creator-worker

## 从整个 Project 创建并运行一个本地 Agent

`combo-creator-agent create` 是当前面向用户的主入口。一次命令会索引 canonical Project、让 bundled Codex
把 Project 上下文编译为 `combo.creator-agent-draft/2`、显示完整编译报告和 Draft，并在用户确认后冻结
immutable AgentVersion。也可以在同一命令中传入 `--run-prompt` 或 `--run-prompt-file`，立即运行刚刚冻结
并从 Catalog 重开的 exact Version。

```bash
combo-creator-agent create \
  --project "/canonical/absolute/project" \
  --allow-unisolated-read \
  --allow-sensitive-project-context
```

这条命令必须同时收到 `--allow-unisolated-read` 和 `--allow-sensitive-project-context`。前者确认当前 Host
没有操作系统级的 Project-only 读隔离；后者确认 Project 中的 `.env`、日志、任务记录和其他敏感内容可能
进入 bundled Codex 使用的模型服务。缺少任一确认都会在扫描或打开 Catalog 前失败。

可信扫描器会读取并哈希 canonical Project 根目录内的全部物理后代，包括 tracked、dirty、untracked、
ignored、hidden 文件，以及源码、文档、配置、日志、task/session 记录、raw tool output、`.env` 和物理
`.git` 内容。普通检出中的 `.git` 目录属于扫描范围；linked worktree 中的 `.git` pointer 只作为 Project
内的物理文件处理，不会继续遍历 Project 外的 shared common directory 或 sibling worktree。symlink 会按
链接本身及其目标文本建索引，但不会跟随到外部路径；特殊文件会 fail-closed。扫描器不会执行 Project 中
发现的脚本，也不会触发 Git clean filter。单次 authoring scan 最多接受 500,000 个条目、8 GiB regular
file 内容与 256 MiB Git 路径输出；单个 secret-candidate 文件最多 1 MiB。超过任一边界都会明确失败，
不会静默漏扫。

扫描器在编译前后分别计算完整索引，期间 Project 发生可见漂移会拒绝产出 Draft。“全量索引”只表示可信
扫描器读取并哈希了所有可支持的物理条目，不表示模型语义上理解了每个字节。编译报告会另外列出模型声明
实际查看的 source path；这些引用会以相对路径、内容 digest 和 `FIXED_GIT_TREE` 或 `AUTHORING_ONLY`
可用性写入 V2 compact source ledger。Project 内出现的 system/developer 文本、tool output 和历史对话都
只被当作 authoring evidence，不会获得指令权限。

敏感输出检查会阻止已识别 credential literal 和常见密钥格式进入 Draft，但它只是 best-effort taint
检查，不是自动脱敏或保密证明。用户仍需在冻结前检查完整 Draft。Catalog 持久化 V2 handoff 中的 Draft、
compact source ledger 和冻结 Version，但不另存 full Project inventory 或 Project 文件附件；模型生成的
Draft 自由文本仍可能包含 Project 摘录。运行 prompt、回答和本机 Project 绝对路径不进入 Catalog。
`rawStored=false` 只是合同声明，不能证明模型服务没有接触上下文，也不能证明 Draft 已经脱敏。

`create` 只允许在可见 TTY 中确认。命令显示编译报告、完整 Draft 和 fingerprint 后，用户只输入一次
`FREEZE`；它不接受 `--confirmation-file`、`--yes`、`--force` 或非交互式确认。冻结前还会验证这个 Draft
能够从 exact Git commit/tree 物化为当前 Runtime 可执行的 tracked tree，冻结后则关闭并重新打开 Catalog，
按 exact `agentId+versionId` 读取 Version。

默认 Catalog 位于
`~/Library/Application Support/Combo/creator-agent/catalog/creator-agents.sqlite`。显式 Catalog 路径必须
是 canonical absolute path，并且位于 Project 外；macOS 临时目录应使用 `/private/tmp/...`，不能使用会经
symlink 解析的 `/tmp/...`。Catalog 父目录必须由当前用户拥有且不可被 group/other 访问。显式运行状态目录
同样必须位于 Project 外。

## 手工诊断与兼容入口

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

这仍是 controlled single-user local Alpha。它不会创建 `combo.codex-agent-share/1`、Capability、Cloud
Catalog 或多轮 Conversation，也没有操作系统级的 Project-only 文件隔离，因此不得用于不可信用户、
不可信 Project 或公网流量。扫描器会检测常见路径替换并 fail-closed，但不声称能够抵御同 UID 恶意进程
在每个文件系统调用之间实施的精确竞态；这种 hostile local-process isolation 仍属于后续 supervisor。

## 不可变 AgentVersion 执行

本包现在能让同一个经过完整性校验的 `AgentVersion` 在本地可靠执行。调用
`runCreatorAgentLocalTurn()` 时，Worker 会先验证 Version fingerprint、canonical origin 与本机对象库中的
commit/tree，再只从 Git blob 创建一个私有的临时 execution snapshot。bundled Codex 读取这份固定的 tracked
tree，不读取可变工作区、ignored/untracked 文件、Git attributes/filter 或本机 index 状态；原工作区即使有
未提交改动，也不会改变这次 Version 的行为。AgentVersion instructions 会编译成该次 Host 的固定 developer
instructions，version fingerprint 同时进入 invocation input fingerprint，运行中不会读取可变 Draft 或
“当前版本”。临时 snapshot 不含 `.git` 元数据，并在 Host、Runtime 与 Broker 完整停止后删除。

`AgentDraft` 与 `AgentVersion` 的纯值合同位于 `@cb/creator-agent-protocol/agent`。V1 保留 current-task
或 manual handoff 兼容；Project Context Compiler 产生独立的 V2 Definition、Draft、handoff 与 Version，
并把 compact source ledger 绑定到全部下游 fingerprint。两代 Draft 都通过新 revision 修订且不可执行，
每个 DraftSnapshot 本身不可变；Version 从一个精确 Draft revision 冻结并可 canonical JSON round-trip。
Version 不保存本机绝对路径、运行 prompt 或回答。本阶段可对同一 Version 发起多个彼此隔离的 fresh run；
它们各有独立 ephemeral thread 和双 SQLite，尚不共享多轮 Conversation 记忆，也不能在进程重启后续接旧
thread。

创建时，ignored、untracked、日志和 task/session 内容可以参与 Agent authoring；冻结后的实际运行只物化
Version 绑定的 commit-pinned tracked Git tree。V2 ledger 中标为 `AUTHORING_ONLY` 的证据不会被偷偷复制
进运行 snapshot，因而可能塑造 Agent instructions，却不能作为运行期文件读取。手工 current-task handoff
只保留作诊断兼容路径，不能再用它描述新的主流程。

这里的 `combo.creator-agent-version/1` 和 `combo.creator-agent-version/2` 都是尚未发布的本地执行合同。
它们既不等同于公开分享链的 `combo.codex-agent-share/1`，也不是旧 `CapabilityDefinition`。后续必须通过
显式投影或迁移合同连接这些体系，不能把当前 local Alpha 描述成现有分享、Capability catalog 或云端运行
入口。

Project Context Compiler 的本机显式真实门槛为
`pnpm -F @cb/creator-worker test:real-context-compiler`。它对 sanitized 临时 Git Project 完成全量索引、
真实 bundled Codex 编译、V2 Catalog import、review、freeze、close/reopen 和 exact Version 本地运行，并
核对原 Project 零变化及敏感内容、prompt 和回答不落 Catalog 或 Worker SQLite。原有
`pnpm -F @cb/creator-worker test:real-agent` 继续验证预制 frozen Version 的底层执行链。

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
