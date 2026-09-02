# apps/billing — V2 计费服务

这个服务是支付中台的「记账」一半：管理用户钱包（本金 / 赠送 / 冻结三桶）、资金流水、预授权（hold）与结算（settle）、计量事件。充值的收钱一半（支付服务）在验证期用管理端手工入账代替，真实微信支付回调与退款后续迭代接入。

核心记账纪律：资金流水与计量事件只允许追加（数据库触发器连所有者也不许改删）；只消费赠送桶的正余额，再扣本金；hold 按 Agent 与 turn 幂等并绑定原用户、估算金额和活动状态，settle 按 hold 与实际金额幂等，充值与计量键也绑定完整原请求；任何同键异载荷都返回冲突。调用方键进入各自哈希域，不能预占系统 hold/settle/estimated 键。金额一律是 JavaScript safe integer 范围内的整数分，数据库同时约束钱包各桶、净额与可用额；净余额低于负五元时拒绝新 hold。

## 文件

- `src/index.ts` 是进程入口，加载配置、装配 PostgreSQL 连接池与 hold 清扫任务，启动 HTTP 监听并处理优雅停机。
- `src/env.ts` 解析并校验全部环境变量，进程其余部分只读结构化配置。
- `src/service.ts` 定义持久层端口与纯函数：可用余额推导、先赠后本拆分、流水幂等键约定。
- `src/repo.ts` 是持久层端口在 pg.Pool 上的实现，每个写方法内部一个事务。advisory transaction lock 串行同一幂等键，钱包与 hold 行锁串行余额、计量和结算。SQL 与 `db/v2-migrations/0013_v2_billing.sql`、`0015_v2_billing_idempotency.sql` 一一对应。
- `src/sweep.ts` 是 hold 超时清扫周期任务：把到期仍 held 的预授权置 expired 并解冻，失败只记日志不中断。
- `src/app.ts` 装配 Fastify 路由与 Bearer token 鉴权，进程入口和测试共用同一份装配。
- `src/__tests__/` 是不依赖外部服务的 vitest 测试，`fakes.ts` 提供复刻事务语义的内存假实现。

## 接口

除健康探针外都要 Bearer token 鉴权：前四条用平台内部 token（`BILLING_INTERNAL_TOKEN`，模型网关与 Agent SDK 持有；验证期与 `LLM_GATEWAY_INTERNAL_TOKEN` 同值，即单 token 策略），管理充值用管理 token（`BILLING_ADMIN_TOKEN`）。

- `GET /billing/wallets/{user_id}` 返回余额与冻结读模型（含推导出的可用余额）；无钱包行的用户返回全零视图。
- `POST /billing/holds` 按 `{user_id, agent_id, turn_id, estimated_amount}` 创建预授权（201）。同一 Agent 与 turn 的同载荷活动 hold 返回 200/replayed；换用户或金额、以及终态 turn 重放返回 409。未知用户返回 404；可用余额不足或触发负余额硬停返回 402 与当前钱包。
- `POST /billing/settlements` 按 `{hold_id, actual_amount}` 结算（200）：先赠后本扣减、解冻全部冻结额、hold 落定 settled；该 hold 没有真实计量事件时补一条 source 为 estimated 的兜底行。同一实际金额重放返回原扣减明细，换金额返回 409。未知 hold 404，已释放或已过期 409。
- `POST /metering/events` 接收带必填 `idempotency_key` 的网关推账。新事实返回 201，同键同载荷返回相同事件 ID 与 200/replayed，同键异载荷返回 409。带 hold 的事件必须与其 user、Agent、turn exact 匹配且 hold 仍为 held；source 只接受 gateway 与 agent_report，estimated 行只能由 settle 兜底写入。
- `POST /billing/admin/recharges` 按 `{user_id, amount, idempotency_key, ref_id?}` 手工充值到本金桶（201）。同键只有用户、金额与引用完全一致时返回当前钱包（200/replayed），任一字段变化或累计余额越过安全数值范围返回 409，未知用户返回 404。
- `GET /health` 与 `GET /ready` 是健康与就绪探针，就绪探针实际检查 PostgreSQL 可达性。

## 上下游

上游是模型网关（hold / settle / usage 上报）与各 Agent 的 SDK（余额查询），以及验证期的运营手工充值。下游是 PostgreSQL 的 `v2_wallets`、`v2_ledger`、`v2_orders`、`v2_packages`、`v2_holds` 与 `v2_metering_events` 六张表，使用专用角色 `combo_billing`。`v2_orders` 与 `v2_packages` 本期只建表不暴露接口。
