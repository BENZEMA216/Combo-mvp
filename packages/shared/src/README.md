# @cb/shared 源码总览

这个目录是 authoring、runtime、web 与 runtime-web 共同依赖的契约层。接口请求与响应、错误分类、基础设施接口和纯函数工具都在这里定义，各应用只消费这些定义，不重复建立另一套协议。

## 文件与子目录

- `index.ts` 是包入口，把下面四个子目录的导出全部转出去。
- `core/` 是地基层，定义通用 ID、成功响应包络、游标分页、无公开错误码的对外错误信封、任务进度模型、SSE（服务端事件推送）帧协议、健康检查契约、发布身份契约、稳定 JSON 编码和 traceId 工具。
- `constants/` 定义 API 路由前缀、健康探针路径和 SSE 端点路径模板。
- `ports/` 声明基础设施接口（队列、事件流、分布式锁、对象存储、大模型网关），由各服务的 infra 代码提供实现。
- `domains/` 按业务域定义数据传输对象与校验规则。认证域包含邮箱 challenge、邮箱 verification、当前用户、登出、成功包络、显式安全 Cookie 策略和站内回跳净化函数；其余文件覆盖任务、能力项、Agent 项目与不可变版本、远程 MCP OAuth、试用会话、Artifact 来源、active Turn 恢复信息与去敏规则。
- `__tests__/auth.test.ts` 检查邮箱请求、六位验证码、回跳白名单、会话 Cookie、成功包络、安全错误和就绪依赖。
- `__tests__/shared.test.ts` 检查通用错误、SSE、任务、能力项、试用、Agent Test 双轴质量复核与包络契约。
- `__tests__/redaction.test.ts` 检查去敏规则的覆盖范围与幂等性。
- `__tests__/release.test.ts` 检查运行时发布身份和无缓存加载契约。

## 约定

每个数据传输对象同时导出 `XxxSchema` 和由该 schema 推导的 TypeScript 类型。服务端使用 schema 校验边界，前端使用同一类型解析结果。认证请求对象使用严格 schema 拒绝未知字段；`returnTo` 在解析时统一净化并只产生允许的站内路径。认证成功包络要求 `meta.traceId`。认证失败使用统一错误信封，并且不携带公开或内部错误码。

## 上下游

runtime 使用 core 的错误与 trace 工具、constants 的路由前缀、ports 的对象存储接口，以及 domains 中的认证、能力项和试用契约。authoring 还实现 ports 的全部基础设施接口，并在提取流水线中使用去敏引擎。两个 React 应用使用认证视图、认证请求与结果、Cookie 无关的站内导航规则和运行时发布身份。具体文件关系记录在各子目录 README 中。
