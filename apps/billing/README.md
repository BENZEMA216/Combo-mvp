# apps/billing — V2 计费服务

这个服务是支付中台的「记账」一半：管理用户钱包（本金 / 赠送 / 冻结三桶）、资金流水、预授权（hold）与结算（settle）、计量事件。充值的收钱一半（支付服务）在验证期用管理端手工入账代替，真实微信支付回调与退款后续迭代接入。

核心记账纪律：资金流水与计量事件只允许追加（数据库触发器连所有者也不许改删）；扣减先赠后本；hold 按 turn_id 幂等、settle 按 hold_id 幂等，重放返回原结果；净余额低于负五元时拒绝新 hold。金额一律整数分。

## 文件

- `src/index.ts` 是进程入口，加载配置、装配 PostgreSQL 连接池与 hold 清扫任务，启动 HTTP 监听并处理优雅停机。
- `src/env.ts` 解析并校验全部环境变量，进程其余部分只读结构化配置。
- `src/service.ts` 定义持久层端口与纯函数：可用余额推导、先赠后本拆分、流水幂等键约定。
- `src/repo.ts` 是持久层端口在 pg.Pool 上的实现，每个写方法内部一个事务，钱包行锁把同一用户的并发计费串行化。SQL 与 `db/v2-migrations/0013_v2_billing.sql` 一一对应。
- `src/sweep.ts` 是 hold 超时清扫周期任务：把到期仍 held 的预授权置 expired 并解冻，失败只记日志不中断。
- `src/app.ts` 装配 Fastify 路由与 Bearer token 鉴权，进程入口和测试共用同一份装配。
- `src/__tests__/` 是不依赖外部服务的 vitest 测试，`fakes.ts` 提供复刻事务语义的内存假实现。

## 接口

除健康探针外都要 Bearer token 鉴权：前四条用平台内部 token（`BILLING_INTERNAL_TOKEN`，模型网关与 Agent SDK 持有；验证期与 `LLM_GATEWAY_INTERNAL_TOKEN` 同值，即单 token 策略），管理充值用管理 token（`BILLING_ADMIN_TOKEN`）。

- `GET /billing/wallets/{user_id}` 返回余额与冻结读模型（含推导出的可用余额）；无钱包行的用户返回全零视图。
- `POST /billing/holds` 按 `{user_id, agent_id, turn_id, estimated_amount}` 创建预授权（201）。同一 turn 重复调用返回原 hold（200，replayed）。可用余额不足或触发负余额硬停返回 402 与当前钱包，reason 字段区分 `insufficient` 与 `overdraft_blocked`。
- `POST /billing/settlements` 按 `{hold_id, actual_amount}` 结算（200）：先赠后本扣减、解冻全部冻结额、hold 落定 settled；该 turn 没有任何计量事件时补一条 source 为 estimated 的兜底行。重复调用返回原扣减明细（replayed）。未知 hold 404，已释放或已过期 409。
- `POST /metering/events` 接收网关推账（201），字段含维度枚举、数量、模型、单价与来源；source 只接受 gateway 与 agent_report，estimated 行只能由 settle 兜底写入。
- `POST /billing/admin/recharges` 按 `{user_id, amount, idempotency_key}` 手工充值到本金桶（201），幂等键重放返回原钱包（200，replayed）。
- `GET /health` 与 `GET /ready` 是健康与就绪探针，就绪探针实际检查 PostgreSQL 可达性。

## 上下游

上游是模型网关（hold / settle / usage 上报）与各 Agent 的 SDK（余额查询），以及验证期的运营手工充值。下游是 PostgreSQL 的 `v2_wallets`、`v2_ledger`、`v2_orders`、`v2_packages`、`v2_holds` 与 `v2_metering_events` 六张表，使用专用角色 `combo_billing`。`v2_orders` 与 `v2_packages` 本期只建表不暴露接口。
