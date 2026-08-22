# @cb/creator-worker

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

低层 `createWorkerSerialPump()` 仍可用于定向测试；它本身不拥有外部资源。R2F 仍是 Test-only 的程序化
Host：没有 CLI/process entry、OS signal 接线、OAuth、Secure Enclave、正式 Broker challenge、Gateway、
Cloud PostgreSQL、指标告警或部署清单。集成测试中的 Broker 仍是本地端口，因此当前 Preview/Production
不会自动启用这条新链路。
