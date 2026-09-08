# 支付后失败恢复验证

`retry-e2e.mjs` 使用实际 Authz、Billing、Gateway 的 HTTP 入口、真实 PostgreSQL 与安装后的 SDK 工件，验证付款后失败恢复。业务部分运行 SDK 包内未经修改的 Reference Agent 示例。

覆盖内容包括首次 402、创建响应丢失后的原编号找回、支付只入账一次、模型异常、原请求重试、并发恢复返回业务已保存的结果、单次扣费、跨用户拒绝，以及未知结果不重复调用。

该脚本仅允许 `127.0.0.1:35418/combo_retry_test` 专用数据库和 `NODE_ENV=test`，不使用用户账号。验证码投递、渠道确认和模型响应是受控替身，业务示例使用内存存储。它不声称再次完成用户真实付款，也不代替真实供应商复核。

运行前构建 Combo 的 shared、payment-protocol、authz、billing 与 llm-gateway，并在该独立数据库执行 V2 0018 迁移。把锁定 SDK 安装到独立消费目录，复制工件内 `templates/nextjs-agent/lib` 到该消费目录的 `reference-lib`，不修改其内容。

运行环境需要以下变量：`PAYMENT_RETRY_E2E=1`、`DATABASE_URL`、该测试库的 `POSTGRES_AUTHZ_PASSWORD` 与 `POSTGRES_BILLING_PASSWORD`，以及 `PAYMENT_SDK_DIR`（已安装包目录）、`PAYMENT_SDK_TGZ`、`PAYMENT_SDK_SHA256`、`PAYMENT_REFERENCE_LIB`。使用 Node 24 和 tsx 加载器执行脚本。

脚本只输出低敏通过记录、SDK 版本和摘要、验证范围及替身边界，不输出会话凭据。测试结束后关闭 HTTP 服务与数据库连接；测试数据只留在专用测试库中，不能清理或复用用户付款记录。
