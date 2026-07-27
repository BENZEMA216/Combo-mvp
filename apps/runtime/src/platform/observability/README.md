# platform/observability —— 链路追踪接线

这个目录负责观测能力（OpenTelemetry，一套链路追踪标准）的启动与 trace 字段提取，让每条日志和每个响应头都能关联到同一条追踪链。

## 文件

- `node.ts` 提供 `startNodeObservability`。只有配置了导出地址且未显式禁用时才启动追踪，并在 span 离开进程前删除原始 URL 查询、客户端地址、请求头、请求正文、异常消息和状态消息。该文件还提供当前 traceId、结构化日志字段和 traceparent 响应头读取函数，并导出可由内存导出器测试的安全包装器。

## 上下游

被谁使用：`processes/api.ts` 在应用代码加载前启动观测并在退出时关闭；`bootstrap/app.ts` 用三个提取函数生成请求 traceId、回写响应头、给请求日志补 trace 字段；`modules/agent/stream.ts` 给流式响应头写 traceparent；`platform/http/client-events.ts` 给浏览器上报日志补 trace 字段。

依赖什么：引用 `platform/config/env.ts` 的 Env 类型读观测相关配置，traceId 与 traceparent 的格式转换函数来自共享包 @cb/shared，其余依赖是 OpenTelemetry 官方包；配置了导出地址时会向该地址的采集服务发送追踪数据。
