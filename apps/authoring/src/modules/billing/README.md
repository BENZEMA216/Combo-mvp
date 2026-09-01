# modules/billing — 余额充值与支付确认

这个模块管理用户钱包读取、待恢复用量绑定的内部充值订单、乐收赢支付通知和主动查单补偿。显式绑定 `recoveryUsageId` 的充值金额必须等于 Runtime 冻结价格；未绑定恢复任务的普通充值继续接受原有金额。乐收赢只完成外部收款。免费次数、请求正文与 Agent 使用扣费仍只由 runtime 管理。

## 文件

- `types.ts` 定义内部充值订单、钱包、仓储端口和本模块固定错误。
- `repo.ts` 实现充值订单、支付尝试、回调事件、钱包与不可变资金流水的 PostgreSQL 事务。创建订单固定按 owner+recovery advisory → pending recovery `FOR UPDATE` → owner admission 锁执行，只接受 active、未过期且价格完全一致的恢复；只有 SQL 快照中明确为 `failed|closed + uncredited` 的当前订单可 CAS 到新 intent，并在同一事务插入 `recovery_usage_id` 关联订单。创建路径不锁旧订单，避免与可信回调更新 recovery 外键时形成 pending→order / order→pending 锁环。晚到成功回调仍对每笔真实订单精确入账；按 recovery 读回优先返回已入账订单，否则返回当前 intent。充值入账、平台订单号单调性和有界 admission 规则保持不变。
- `service.ts` 保留仅带 `rechargeIntentId` 的普通充值兼容路径；只有显式提供 `recoveryUsageId` 时才进入 pending recovery 锁/CAS/link 流程，绝不按金额、时间或最近订单猜测绑定。一个充值意图、内部订单和支付流水绑定后保持不变；预下单超时或进程退出时只查原流水，终态未入账失败后才允许新 intent。未通过验签的通知不会写入回调事件表。
- `reconcile.ts` 在 API 进程中按配置周期清理到期支付动作并领取待查订单。每笔订单最多主动查询 120 次且不超过 24 小时，之后停止自动查询但仍接受可信成功回调；多副本由 PostgreSQL 租约协调，单进程不重叠执行，关闭应用时等待当前轮结束。网关开关关闭时仍会清除过期支付动作，但不会请求网关。
- `handlers.ts` 使用 Shared strict DTO 校验恢复与 intent；普通充值返回原有无 recovery 字段的严格视图，显式恢复充值才返回必含 `recoveryUsageId` 的严格视图。两者都不含机构号、商户号、支付流水或 gateway 原文。
- `routes.ts` 注册钱包、充值订单、按 intent/按 recovery 精确读回和支付通知端点。浏览器写入使用 Cookie 与精确来源守卫，网关通知不依赖 Cookie 或 Origin。

## 上下游

路由由 `bootstrap/routes.ts` 挂到 `/api/v1`。handler 与后台查单调度器使用 Fastify 注入的 PostgreSQL、充值配置和支付网关端口。表结构由追加迁移维护；本模块不保存机构密钥、原始回调或完整网关响应。
