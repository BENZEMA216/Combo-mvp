# Creator Worker

这个应用负责把一个经过脱敏的本地 Project 临时连接到 Codex app-server，并提供仅本机可访问的多轮聊天体验。它是体验版 Host Adapter，不负责云端消息中转、公开发布、计费或生产级隔离。

## 文件职责

- `src/app-server-client.ts` 管理 Codex app-server 子进程、JSON-RPC 请求、事件归并、取消和进程退出。
- `src/host-types.ts` 定义可替换 Host Adapter 的最小接口与稳定内部错误。
- `src/creator-worker.ts` 管理会话到 thread 的映射、每个会话的单飞约束、全局容量和 messageId 幂等。
- `src/http-server.ts` 提供 loopback HTTP API、用户安全错误信封和最小聊天页面。
- `src/chat-page.ts` 生成不暴露本地路径或 Host 技术细节的消费者聊天页面。
- `src/cli.ts` 校验启动参数、解析真实 Project 路径并管理进程生命周期。
- `src/vnext-runtime.ts` 是新的 R2 Worker 可执行组合根：把真实 SQLite transport/Invocation Journal、Broker client、单一 command pump、进程内 Host registry 和 Codex Host 组合成一条生命周期，并把生产 authority 保持为显式注入端口。
- `src/index.ts` 导出可测试的公共类型和构造器。

## VNext R2 组合边界

`createVnextCreatorWorkerRuntime()` 为一条 Worker process lifecycle 创建一个 owner capability，并把同一个显式 `ownerToken` 注入 installation acquisition、Broker client、command pump 和 Journal 调用。command pump 只读取该 owner 当前 `ACTIVE` connection 上的 opaque command reference，按单一串行 mutation queue 处理 `conversation.open`、`invocation.prepare`、`invocation.start`、`invocation.cancel`、Host terminal、durable fact 和 Cloud ACK，不能用旧 connection 或旧 owner 作为当前执行 authority。

`conversation.open` 是两阶段 open：Journal 先授权 exact durable command，Isolation/Host runtime 再 provision 或恢复同一个未提交资源，最后才把 thread、sandbox evidence 与 READY fact 原子绑定进 Journal。明确的 Journal pre-COMMIT 失败会精确释放该 provision；COMMIT 响应是否丢失不明确时保留同一资源供重放，不能另建 thread 猜测成功。

启动顺序是 `acquire owner → recoverAfterProcessStart → Host start → Broker start → pump`。进程启动 recovery 只执行一次；同一进程的 reconnect 继续使用当前 registry 和 terminal watcher，不能冒充 process restart。当前 Host 没有跨进程 query/reattach authority，因此重启发现遗留 Host action 会保守收敛为 `UNCERTAIN`；发现 durable READY conversation 但本进程没有对应 Host binding 时，runtime 必须保持 `BLOCKED`，绝不报告 `READY`。

正常停止会先等待所有 terminal watcher 把证据持久化，再通过 `drainEvidence()` 做至多 `finalDrainRounds` 轮 evidence-only drain，只有观察到非 `PROGRESSED` 的静止轮次后才停止 Broker/Host、清空 registry 并关闭 SQLite。terminal commit、drain 调用、drain timeout 或轮数耗尽但仍持续前进时，停止流程 fail closed 为 `BLOCKED`，不会把未落 durable evidence 的 Host 结果伪装成已完成，也不会在尚未证明静止时关闭 Host/Broker。

这条 R2 根目前是导出的程序化 API 和本地测试切片；`src/cli.ts`/`combo-creator-worker` 仍启动下面的 legacy loopback 体验链，尚未接入 `createVnextCreatorWorkerRuntime()`。生产用 Secure Enclave/Keychain/KMS crypto、真实 Isolation Supervisor/资源 reattach、Cloud ACK evidence/reconciliation 及相应配置也仍未实现，所以不能把 R2 本地组合证据称为真实产品链路或生产部署。

## 体验边界

该体验版只允许绑定无敏感信息、无 symlink 的小型 Project，并且只监听 `127.0.0.1`。Codex 当前的 `read-only` 和 `runtimeWorkspaceRoots` 不能限制读取创作者机器上的其他文件，因此这个应用不会把自己描述为安全沙箱，也不能直接向不可信消费者公开。

没有 Combo 云 Broker 不代表离线运行。用户消息以及回答所需的 Project 内容仍会由 Codex 模型服务处理。Worker 会关闭 MCP、Apps、Plugins、Hooks、Memory、浏览器、Computer Use 和动态工具，但这不能替代容器、虚拟机或独立 OS 用户提供的读取隔离。

Worker 不启用 Codex 的全局 `--strict-config`：当前 Desktop 可能保留新版 CLI 不再识别的历史用户字段，严格解析会在 app-server 初始化前退出。安全边界不依赖该开关，而由固定 CLI override、固定 thread/turn 参数、server-request fail-closed 和显式未隔离确认共同约束。

每个 app-server 进程使用一个新的私有 `HOME` 与 `CODEX_HOME`，只通过本地 symlink 桥接现有 `auth.json`，不加载创作者的 `config.toml`、MCP、Hook、Provider 或指令文件。绑定 Project 被显式标记为不受信任，Project 文档发现关闭；Project 文件只作为按需读取的上下文，不作为高优先级指令。

`HostTurnHandle.terminal` 只在同一 thread/turn 出现可验证的 `turn/completed` 后解析为 `SUCCEEDED`、`FAILED(TURN_FAILED|TURN_TIMEOUT)` 或 `CANCELLED` 低敏证据；Host 进程丢失、协议丢失或无法绑定的 terminal 会拒绝，而不是把 Promise rejection 猜成稳定业务终态。`HostTurnHandle.interrupt()` 也不会把 `turn/interrupt` 的空 RPC 响应冒充取消完成，并且每个 turn 最多只发送一次 interrupt；只有严格的 interrupted terminal 才返回 `combo.codex-app-server-interrupt-terminal/1`。两类 digest 都只覆盖规范化 observation，不包含回答、Prompt、路径或原始 Host payload。

共享 Protocol、Broker Client、Invocation Journal、command pump 与 `vnext-runtime` 已有本地 structural/SQLite 测试，但当前 CLI 可执行入口仍是旧的 loopback 体验组合根，尚未启动这条 R2 graph、Isolation Supervisor 或 Cloud reconciliation。所以下面的真实 bundled Codex gate 只证明 Host Adapter 与旧体验链，不等于 VNext Worker 端到端 Gate，也不能据此宣称 durable Cloud terminal 闭环。

本 RC 的 experimental app-server 协议明确 pin 到 bundled Codex `0.147.0-alpha.6.5`；Desktop 升级后必须先重跑协议与真实多轮 gate，未审核版本会拒绝启动。

运行方式：

```bash
pnpm --dir apps/creator-worker dev --project /absolute/path/to/safe-project --allow-unisolated-read
```

启动成功后，终端会给出包含 URL fragment capability 的“本次 Worker 会话”本机体验地址；它在这次 Worker 运行期间可重复使用，并非首开即失效。该 capability 不进入 cookie、查询参数或 Codex 子进程环境。每个浏览器对话对应一个 ephemeral Codex thread；Worker 重启后旧对话失效。

默认不会把任何代理环境变量传给 Codex。只有在本机 Codex 登录确实依赖一个无用户名、无密码的 loopback proxy 时，才显式追加 `--allow-loopback-proxy`；远程代理和带凭据代理始终拒绝继承。

## 明确非目标

- 公网消费者、TLS、多租户鉴权、DDoS 与计费。
- legacy loopback CLI 中的 Combo 云 Broker、lease、heartbeat、durable journal 与跨重启恢复接线。
- 容器或 VM 级文件、CPU、内存和网络隔离。
- Project 上传、凭据迁移、外部 Action 或自动写入。

## 验证层级

普通 `pnpm --dir apps/creator-worker test` 使用确定性 fake Host 验证 NDJSON、单飞、幂等、取消和 loopback 安全边界。真实 bundled Codex 多轮隔离是单独的本机 RC gate，不会被 mock 冒充：

```bash
COMBO_REAL_CODEX_E2E=1 pnpm --dir apps/creator-worker exec vitest run src/real-host.integration.test.ts
```

该测试从 loopback HTTP API 进入 Worker，只创建临时脱敏 Project 和 ephemeral threads，并验证两个消费者对话的多轮隔离与消息幂等；缺少 Codex 登录或真实 Host 失败时必须按失败处理，不能把 skip 当作通过。

本机浏览器状态机使用系统 Chrome 做单独的显式 smoke，验证初始化期间的重复提交不会创建多段对话，并验证停止一轮回答后仍可继续发送新消息：

```bash
COMBO_BROWSER_E2E=1 pnpm --dir apps/creator-worker exec vitest run src/browser-smoke.integration.test.ts
```

浏览器 smoke 使用 fake Host，只证明本机页面状态机和 loopback API，不替代上面的真实 Codex gate。
