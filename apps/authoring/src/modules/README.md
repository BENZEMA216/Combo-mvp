# modules — 业务模块层

这个目录按业务领域分成三个模块。`account/` 管邮箱验证码、首次建号和 PostgreSQL 会话，`task/` 管任务生命周期、助手上传与提取流水线，`capability/` 管能力项读取与发布。

每个模块都用 `routes.ts` 声明端点，用 `handlers.ts` 处理 HTTP 输入输出，用 `repo.ts` 收拢本领域 SQL。account 模块另有认证密码学纯函数和事务编排服务，task 模块另有状态机、配对上传、流水线与会话解析等文件。

所有模块路由由 `bootstrap/routes.ts` 挂到 `/api/v1`。task 流水线经 capability 模块的公开出口写入能力项。模块层只向下依赖 `platform/` 的基础设施和 HTTP 工具，公共类型、错误分类与校验契约来自 `@cb/shared`。
