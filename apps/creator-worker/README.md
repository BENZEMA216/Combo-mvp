# Creator Worker

这个应用负责把一个经过脱敏的本地 Project 临时连接到 Codex app-server，并提供仅本机可访问的多轮聊天体验。它是体验版 Host Adapter，不负责云端消息中转、公开发布、计费或生产级隔离。

## 文件职责

- `src/app-server-client.ts` 管理 Codex app-server 子进程、JSON-RPC 请求、事件归并、取消和进程退出。
- `src/host-types.ts` 定义可替换 Host Adapter 的最小接口与稳定内部错误。
- `src/creator-worker.ts` 管理会话到 thread 的映射、每个会话的单飞约束、全局容量和 messageId 幂等。
- `src/http-server.ts` 提供 loopback HTTP API、用户安全错误信封和最小聊天页面。
- `src/chat-page.ts` 生成不暴露本地路径或 Host 技术细节的消费者聊天页面。
- `src/cli.ts` 校验启动参数、解析真实 Project 路径并管理进程生命周期。
- `src/index.ts` 导出可测试的公共类型和构造器。

## 体验边界

该体验版只允许绑定无敏感信息、无 symlink 的小型 Project，并且只监听 `127.0.0.1`。Codex 当前的 `read-only` 和 `runtimeWorkspaceRoots` 不能限制读取创作者机器上的其他文件，因此这个应用不会把自己描述为安全沙箱，也不能直接向不可信消费者公开。

没有 Combo 云 Broker 不代表离线运行。用户消息以及回答所需的 Project 内容仍会由 Codex 模型服务处理。Worker 会关闭 MCP、Apps、Plugins、Hooks、Memory、浏览器、Computer Use 和动态工具，但这不能替代容器、虚拟机或独立 OS 用户提供的读取隔离。

Worker 不启用 Codex 的全局 `--strict-config`：当前 Desktop 可能保留新版 CLI 不再识别的历史用户字段，严格解析会在 app-server 初始化前退出。安全边界不依赖该开关，而由固定 CLI override、固定 thread/turn 参数、server-request fail-closed 和显式未隔离确认共同约束。

每个 app-server 进程使用一个新的私有 `HOME` 与 `CODEX_HOME`，只通过本地 symlink 桥接现有 `auth.json`，不加载创作者的 `config.toml`、MCP、Hook、Provider 或指令文件。绑定 Project 被显式标记为不受信任，Project 文档发现关闭；Project 文件只作为按需读取的上下文，不作为高优先级指令。

`HostTurnHandle.terminal` 只在同一 thread/turn 出现可验证的 `turn/completed` 后解析为 `SUCCEEDED`、`FAILED(TURN_FAILED|TURN_TIMEOUT)` 或 `CANCELLED` 低敏证据；Host 进程丢失、协议丢失或无法绑定的 terminal 会拒绝，而不是把 Promise rejection 猜成稳定业务终态。`HostTurnHandle.interrupt()` 也不会把 `turn/interrupt` 的空 RPC 响应冒充取消完成，并且每个 turn 最多只发送一次 interrupt；只有严格的 interrupted terminal 才返回 `combo.codex-app-server-interrupt-terminal/1`。两类 digest 都只覆盖规范化 observation，不包含回答、Prompt、路径或原始 Host payload。

共享 Protocol 与 Broker Client 已有 R1 structural contract 和真实 SQLite 纵向测试，但本应用当前可执行入口仍是旧的 loopback 体验组合根，尚未启动 Broker client、SQLite command pump、Isolation Supervisor 或 Cloud reconciliation。所以下面的真实 bundled Codex gate 只证明 Host Adapter 与旧体验链，不等于 VNext Worker 端到端 Gate，也不能据此宣称 durable Cloud terminal 闭环。

本 RC 的 experimental app-server 协议明确 pin 到 bundled Codex `0.147.0-alpha.6.5`；Desktop 升级后必须先重跑协议与真实多轮 gate，未审核版本会拒绝启动。

运行方式：

```bash
pnpm --dir apps/creator-worker dev --project /absolute/path/to/safe-project --allow-unisolated-read
```

启动成功后，终端会给出包含 URL fragment capability 的“本次 Worker 会话”本机体验地址；它在这次 Worker 运行期间可重复使用，并非首开即失效。该 capability 不进入 cookie、查询参数或 Codex 子进程环境。每个浏览器对话对应一个 ephemeral Codex thread；Worker 重启后旧对话失效。

默认不会把任何代理环境变量传给 Codex。只有在本机 Codex 登录确实依赖一个无用户名、无密码的 loopback proxy 时，才显式追加 `--allow-loopback-proxy`；远程代理和带凭据代理始终拒绝继承。

## 明确非目标

- 公网消费者、TLS、多租户鉴权、DDoS 与计费。
- Combo 云消息 Broker、lease、heartbeat、durable journal 与跨重启恢复。
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
