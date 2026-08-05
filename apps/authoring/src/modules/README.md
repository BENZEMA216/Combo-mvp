# modules — 业务模块层

这个目录按业务领域分成六个模块。`account/` 管邮箱验证码、首次建号和 PostgreSQL 会话，`task/` 管任务生命周期、助手上传与提取流水线，`capability/` 管能力项读取与发布，`agent-project/` 管 Agent Project、不可变 Revision、编译与 Release，`billing/` 管钱包读取、配置化充值订单、支付确认和主动查单，`external-mcp/` 管 Codex 的 OAuth 与无状态远程 Agent Builder 工具。

每个模块都用 `routes.ts` 声明端点，用 `handlers.ts` 处理 HTTP 输入输出，用 `repo.ts` 收拢本领域 SQL。account 模块另有认证密码学纯函数和事务编排服务，task 模块另有状态机、配对上传、流水线与会话解析等文件，agent-project 模块另有冻结 Capability 和 Miniapp 的编译器。

浏览器业务模块由 `bootstrap/routes.ts` 挂到 `/api/v1`；OAuth 发现、授权、远程 MCP 和安装页由组合根按规范路径单独注册。task 流水线经 capability 模块的公开出口写入能力项。billing 通过 platform 的乐收赢端口收款，并在 PostgreSQL 事务中更新钱包与资金流水。模块层只向下依赖 `platform/` 的基础设施和 HTTP 工具，公共类型、错误分类与校验契约来自 `@cb/shared`。
