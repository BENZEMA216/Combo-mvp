# core — 契约地基

这个目录定义与具体业务无关的基础契约：ID 与时间格式、响应包络、分页、错误、进度、流式帧、健康检查、发布身份和链路追踪。domains 与两个服务都建立在它之上，依赖方向单向（core 不引用 domains）。

## 文件

- `ids.ts` 定义对外字符串 ID、traceId 和 ISO 8601 时间三个基础 schema，全库对外 ID 一律是 UUID v7 字符串。
- `envelope.ts` 定义统一成功响应包络（`data` 加可选 `meta`）和它的 schema 工厂函数，`meta` 里可携带 traceId、分页信息、占位说明和降级标记。
- `pagination.ts` 定义游标分页的请求参数与响应 `meta.page` 形状，并提供不透明游标（cursor，前端不可解读的翻页锚点）的编码解码函数；解码失败抛 `InvalidCursorError`，由接口层映射成 400 响应。
- `errors.ts` 定义对外错误信封（只含人话文案、退路动作、可否重试和 traceId，绝不含内部错误码）、内部错误码常量表 `ErrorCode`、每个码对应 HTTP 状态与缺省文案的分类表 `ERROR_CLASSIFICATION`，以及按码组装错误体的 `errorBodyFor`。
- `progress.ts` 定义任务进度视图（总百分比、量化文案、子任务清单）和提取流水线的子任务标准顺序 `PIPELINE_SUBTASKS`。
- `sse.ts` 定义 SSE（服务端事件推送）的帧协议：七种帧类型的枚举、各帧内容的 schema 和默认心跳间隔常量。
- `health.ts` 定义 `/health` 与 `/ready` 两个探针的响应契约、六个依赖项的名称枚举和计入就绪判定的必查依赖清单。
- `trace.ts` 提供 traceId 工具：UUID 与 W3C traceparent 请求头格式互转、从请求头或 URL 参数提取 traceId、生成新的 traceId 和 spanId。
- `release.ts` 定义运行时发布身份 schema、环境变量映射和无缓存加载函数。加载函数校验完整 source SHA、确定性 releaseId、构建时间及两个摘要，并把网络、HTTP 和畸形响应收敛成稳定失败分类。
- `index.ts` 汇总转出以上全部文件。

## 上下游

runtime 侧：`bootstrap/app.ts` 用错误码、`errorBodyFor` 和 trace 工具做全局错误处理与链路透传；`platform/http/_helpers.ts` 用 `errorBodyFor` 统一回错；`platform/http/health.ts` 用健康契约类型；`platform/observability/node.ts` 用 trace 格式转换；`modules/agent/stream.ts` 用 SSE 心跳常量和 trace 头名；`modules/session/handlers.ts` 用 `Envelope` 类型。

authoring 侧：以上同类用法都有，另外 `modules/task/handlers.ts` 与 `modules/capability/handlers.ts` 用分页常量和游标编解码实现列表接口，`modules/task/pipeline.ts` 与 `modules/task/sse.ts` 用 `PIPELINE_SUBTASKS` 和进度视图驱动子任务点亮，`platform/sse/sse.ts` 用 SSE 帧类型和心跳常量实现推流。Web 前端使用 `release.ts` 从运行时文件读取发布身份；非开发构建只有通过 schema 校验后才渲染应用。
