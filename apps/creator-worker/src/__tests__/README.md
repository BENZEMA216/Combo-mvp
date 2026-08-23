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
  乱序通知、原子成功/失败、中断 lineage、watchdog、恶意 NDJSON 与有界停止。
- `codex-app-server-host.real.test.ts` 仅在 `COMBO_REAL_CODEX_E2E=1` 时运行固定 bundled Codex，对临时
  sanitized Project 执行一轮真实只读回答，并验证项目内容未变化。
- `host-adapter-import-boundary.test.ts` 扫描应用与包源码，确保生产环境只有 bundled Codex adapter 能
  导入 R1 producer 子路径，测试代码之外的新增 authority mint 入口会直接让 CI 失败。
- `local-alpha.test.ts` 用 Fake Host 但真实 Broker、双 SQLite、driver、pump 与 Runtime 连跑两次，覆盖
  fresh run、命令 ACK、Transport SQLite 中 exact terminal ACKED、强制断线换 lease 后继续、终态防伪、
  干净停止、旧/不完整/非空状态拒绝、signal/prepare 竞态、管道输入有界中断、CLI 参数与 prompt/回答
  不落库。
- `local-alpha.real.test.ts` 仅在 `COMBO_REAL_CODEX_E2E=1` 时运行完整本地闭环；它从 Broker command 一直
  经过真实 bundled Codex 到 terminal ACK，并验证 sanitized Project 零变化与两库无正文。
- `agent-local-runner.test.ts` 用 commit-pinned Git fixture、Fake Host、真实 Broker、双 SQLite、driver、pump
  与 Runtime 证明同一 immutable AgentVersion 可运行两次且 instructions 不漂移；Host 只看到 blob
  materialize 的 fixed tree，源工作区并发漂移不会进入执行，错误 origin 与 symlink tree 会在 Host 副作用前拒绝。
- `agent-local-runner.real.test.ts` 仅在 `COMBO_REAL_CODEX_E2E=1` 时让一个 frozen AgentVersion 经过真实
  bundled Codex、私有 tracked-tree snapshot、双 SQLite 与 terminal ACK，验证原 Project 零变化且正文不落库。

测试使用真实 Node 24 `node:sqlite` 文件和真实 R1 adapter controller；R2E 测试还使用真实 `ws` client /
server；真实 Codex Host gate 与本地 Alpha gate 都只证明本机受控环境。本地 Alpha 的 loopback Broker
不是 Cloud Broker；这些测试不会证明公网身份、Cloud durability、进程崩溃后恢复回答、OS 级
Project-only 隔离或生产部署。
