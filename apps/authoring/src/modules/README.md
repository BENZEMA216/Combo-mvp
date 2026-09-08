# modules — 业务模块层

这个目录按业务领域分成六个模块。`account/` 管邮箱验证码、首次建号和 PostgreSQL 会话，`task/` 管任务生命周期、助手上传与提取流水线，`capability/` 管历史能力项读取与发布，`agent-package-release/` 管受控 Test canonical Package Registry，`agent-draft/` 管私有 Draft V2、独立轻量上下文 Draft 与 exact Package 保存、指定版本读取和卡片投影，`billing/` 管钱包读取、配置化充值订单、支付确认和主动查单。

`agent-draft` 的 `routes.ts` 负责认证与 HTTP 边界，`service.ts` 复用公开编译器、既有对象存储与 PostgreSQL 事务。私有快照不是新的 Agent 定义或公共 Release，也不取得可信 Desktop 来源证明。

各模块用 `routes.ts` 声明端点。既有模块用 `handlers.ts` 处理 HTTP 输入输出并用 `repo.ts` 收拢 SQL；agent-package-release 模块把严格 HTTP 边界放在路由文件，把对象提交、协议校验和 Registry 事务收在 `service.ts`。account 模块另有认证密码学纯函数和事务编排服务，task 模块另有状态机、配对上传、流水线与会话解析等文件。

所有模块路由由 `bootstrap/routes.ts` 挂到 `/api/v1`，其中 Agent Package Release 路由还要求受控 Test gate 命中当前候选。task 流水线经 capability 模块的公开出口写入能力项。billing 通过 platform 的乐收赢端口收款，并在 PostgreSQL 事务中更新钱包与资金流水。模块层只向下依赖 `platform/` 的基础设施和 HTTP 工具，公共类型、错误分类与校验契约来自 `@cb/shared`，canonical Package 合同来自 `@cb/creator-agent-protocol`。
