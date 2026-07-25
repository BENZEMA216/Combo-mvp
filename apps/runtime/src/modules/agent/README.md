# modules/agent 对话轮次编排与流式推送

这个目录负责一轮模型生成的完整生命周期。它创建和收尾 Turn，构造 Pi Agent，把事件写入 Redis，并把完成消息保存到 PostgreSQL。SSE 路由仍由 session 模块注册。

## 文件

- `turn-repo.ts` 封装 Turn 创建、运行态查询、最近持久终态读取、Session 与 Turn 行锁、条件收尾和超时清扫。它只把 `uq_turns_session_running` 的 PostgreSQL 唯一冲突映射为 `SessionBusyError`。
- `run-turn.ts` 在 Session 行锁事务中创建 Turn 和用户消息，并异步执行模型。它统一让 PostgreSQL 终态先提交、Redis 终态后追加，并在开下一轮前按数据库事实修复最近终态事件。它跟踪活动 Turn 和尚未提交的开轮事务，在人工打断、空闲超时、清扫和关闭时同时停止 Pi 与远程命令。Studio 成功终态会在同一数据库事务中提升本轮最后一个合规 UI revision。
- `build-agent.ts` 把 CapabilityDefinition、Session 模式、本轮用户要求、已完成历史、平台约束和工具交给 Pi Agent。Studio 使用单独的 Miniapp 设计协议和视觉规则，模型凭据始终由 Runtime 提供。
- `design-studio-prompt.ts` 定义适配当前不可变 Artifact revision 的 Studio 设计规则、视觉连续性、运行桥和确定性页面质量检查。
- `design-visual-profile.ts` 根据冻结的 Capability 元数据为首版页面选择有界视觉合同，并判断后续请求是否明确要求整体换视觉方向。
- `sandbox-tools.ts` 定义 `read`、`write`、`edit` 和 `bash`。四个工具都按串行模式执行，把所属 Turn 的中止信号与 Pi 单次调用信号绑定后再调用 SandboxBackend，并把底层错误收口为稳定文案。命令后代清理无法确认时，工具还会立即中止所属 Turn。
- `turn-emitter.ts` 把普通 AG-UI 事件先写 Redis Stream，再发布实时通知，并保持同一执行路径内的顺序。
- `event-log.ts` 定义事件日志端口、保留数量、有效期和 Redis Stream 编号工具。
- `stream.ts` 实现 Last-Event-ID 补发、实时缓冲、单调去重和心跳。

## 一轮生成

提交消息时，数据库部分唯一索引保证一个 Session 只有一个 `running` Turn。异步执行只读取已完成历史。Studio 构造 Agent 时还会读取当前可见 HTML，用它区分首版视觉合同和后续视觉连续性。工具顺序固定为可信的 `upsert_artifact` 在前；显式开启沙箱后才追加四个远程工具。

普通文本、产物状态和 `RUN_STARTED` 都通过受保护的 TurnEmitter 写入。每次追加先锁住 Session，再确认同一个 Turn 仍为 `running`。完成、中断、失败和清扫路径都先提交 PostgreSQL 的 Turn 状态与 Message，提交后才追加 Redis 终态。跨副本终态提交后，旧 Pi 即使没有收到 Redis 打断通知，也不能通过数据库守卫继续追加事件。Studio 的 Capability UI 指针更新仍与成功终态处于同一个数据库事务中。

终态追加按 `runId` 幂等。相同终态在 Stream 条目仍保留时返回原编号，条目已过期或被修剪时只重放同一个持久终态；不同终态重试失败，迟到普通事件也会被终态标记拒绝。标记缺失或仍是旧版 `OPEN` 时，普通事件与终态脚本都会先扫描保留的 Stream。Redis 超时或结果不明确不会改变已经提交的数据库终态。下一轮在 Session 行锁内读取最近的持久终态，并允许 PostgreSQL 事实替换升级前遗留的冲突 Redis 终态。修复模式不会只相信匹配的标记；如果旧终态后仍有同一 Turn 的普通事件，它会删除旧终态并在 Stream 尾部重放数据库终态。恢复失败事件时只使用错误码对应的固定公开文案，未知错误码使用安全兜底文案。

开轮事务会在提交前发布本地执行句柄。打断查询先取得 Session 行锁，等待开轮提交后再读取当前句柄并核对 `runId`，因此不会在提交窗口误报没有运行 Turn，也不会把刚发布的本地轮次误当成外部轮次。提交后已经收到中止信号的执行器会在启动 Pi 前直接收尾。跨副本打断继续使用 Redis 通知，同时要求接收请求的副本证明远程命令和 Pod 已清理。功能关闭的副本不能替其他副本声明清理成功，因此通知丢失时会保留 `running` Turn 并返回错误。

关闭流程先栅栏新的开轮请求，并快照活动 Turn 与进行中的开轮事务。尚未发布句柄的事务会被取消；已经进入提交阶段的事务会先完成提交判定，提交成功的 Turn 随后参加同一轮远程清理和终态收口。Pi 中止、远程清理、终态事务和 PostgreSQL 锁等待共用一个绝对截止时间。清理已确认且仍有剩余时间时才写中断终态；截止时间耗尽、数据库失联或沙箱清理无法确认时保留 `running`。忽略中止信号的模型 Promise 可以迟到结束，但普通事件、Artifact 提交和沙箱操作都有终态栅栏；迟到的 Artifact 上传不能在终态后提交索引或事件。
