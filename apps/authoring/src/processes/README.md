# processes — 进程入口

这个目录放两个可独立启动的进程入口。同一个镜像按环境变量 PROCESS 分叉：api 进程对外提供 HTTP 服务，worker 进程在后台消费队列执行提取流水线。

## 文件

- `api.ts` 是 HTTP 服务进程入口：加载环境配置，启动链路追踪，调 `bootstrap/app.ts` 的 buildApp 构建 Fastify 应用并监听端口，收到 SIGINT/SIGTERM 时优雅关闭应用和追踪导出器后退出。
- `worker.ts` 是后台执行进程入口：用 BullMQ 的 Worker 以单并发消费 task-pipeline 队列，每个任务交给 `modules/task/pipeline.ts` 的 runPipeline 执行；BullMQ 错误事件只记录固定文案，不记录可能含连接材料的错误对象，实际恢复结果由业务状态和探针判断；同时每 60 秒跑一轮租约对账，把 `modules/task/repo.ts` 的 findStalledExtractTasks 找出的「执行中但租约过期或迟迟无人认领」的任务重新入队，重复投递由流水线内的租约认领吸收。

## 上下游

被谁使用：`src/index.ts`（默认入口）加载 `api.ts`；容器编排按 PROCESS 环境变量分别以这两个文件为进程入口，没有其它代码 import 它们。

依赖什么：两个入口都用 `platform/config/env.ts` 和 `platform/observability/node.ts`。`api.ts` 只再依赖 `bootstrap/app.ts`。`worker.ts` 自己组装流水线依赖：`platform/infra/db.ts`（PostgreSQL 连接池，读写 tasks/uploads 等表）、`platform/infra/redis.ts` 与 `platform/infra/queue.ts`（Redis 队列实例和 BullMQ 封装）、`platform/infra/object-store.ts`（MinIO 对象存储）、`platform/infra/llm/`（大模型网关与写 audit_llm_calls 表的审计落库器）、`platform/sse/event-stream.ts`（把进度帧推进 Redis 流），以及 `modules/task/pipeline.ts` 和 `modules/task/repo.ts`。
