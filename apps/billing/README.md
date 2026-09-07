# apps/billing — V2 计费服务

这个服务管理用户钱包、资金流水、预授权与结算、计量事件。支付模块提供收费调用准入、支付创建与查询、可信到账确认和原调用资金预留。配置支付开关后，进程入口会注册带身份校验的支付路由；真实渠道和收银台页面尚未接入。

核心记账纪律：资金流水与计量事件只允许追加（数据库触发器连所有者也不许改删）；只消费赠送桶的正余额，再扣本金；hold 按 Agent 与 turn 幂等并绑定原用户、估算金额和活动状态，settle 按 hold 与实际金额幂等，充值与计量键也绑定完整原请求；任何同键异载荷都返回冲突。调用方键进入各自哈希域，不能预占系统 hold/settle/estimated 键。金额一律是 JavaScript safe integer 范围内的整数分，数据库同时约束钱包各桶、净额与可用额；净余额低于负五元时拒绝新 hold。

## 文件

- `src/index.ts` 是进程入口，加载配置、装配 PostgreSQL 连接池与 hold 清扫任务，启动 HTTP 监听并处理优雅停机。
- `src/env.ts` 解析并校验全部环境变量，进程其余部分只读结构化配置。
- `src/service.ts` 定义持久层端口与纯函数：可用余额推导、先赠后本拆分、流水幂等键约定。
- `src/repo.ts` 是持久层端口在 pg.Pool 上的实现，每个写方法内部一个事务。advisory transaction lock 串行同一幂等键，钱包与 hold 行锁串行余额、计量和结算。SQL 与 `db/v2-migrations/0013_v2_billing.sql`、`0015_v2_billing_idempotency.sql` 一一对应。
- `src/sweep.ts` 定期释放到期 hold；开启支付后还会释放七天未认领的支付资金预留。失败只记录计数或固定错误信息。
- `src/app.ts` 装配 Fastify 路由与 Bearer token 鉴权，进程入口和测试共用同一份装配。
- `src/payment-service.ts` 定义支付持久层端口、调用输入、短期不透明凭证及公共状态投影。数据库只保存凭证摘要，原始业务内容不进入支付表。
- `src/payment-repo.ts` 在 PostgreSQL 事务中绑定 operationId 与 callId，创建唯一支付、管理 requestKey 别名，并在确认到账的同一事务中入账和预留原调用资金；并发认领只生成一个正常 hold。
- `src/payment-routes.ts` 提供标准 402 与三个支付 HTTP 路由。注册时必须提供用户认证和独立 Gateway 认证；它不提供付款成功的公共写接口。
- `src/payment-auth.ts` 把 Host 的当前会话交给 Authz 重新核验，再验证返回的用户断言；同时检查允许的网页来源和独立 Gateway 凭据，不接受请求体身份或 Agent 令牌作为用户身份。
- `src/channel/` 提供乐收赢下单、查单和通知验签，不依赖旧 Hosted 钱包，也不读写业务请求。
- `src/channel-service.ts` 只提交已保存的原渠道订单；超时后仅查询该订单，可信成功才调用唯一入账入口。支付渠道成功与 Combo 入账仍分开处理。
- `src/channel-repo.ts` 保存每支付唯一的渠道订单、已核验的低敏事件以及查单次数和租约；商户、金额、付款方式和原支付流水固定，渠道交易号只允许首次绑定。
- `src/__tests__/` 是不依赖外部服务的 vitest 测试，`fakes.ts` 提供复刻事务语义的内存假实现。

## 接口

以下原记账接口使用平台内部凭据 `BILLING_INTERNAL_TOKEN`，管理充值使用 `BILLING_ADMIN_TOKEN`。正式支付接入中这些凭据只供平台服务持有，不能交给 Agent；旧 SDK 持有共享凭据的方式只属于历史验证栈。

- `GET /billing/wallets/{user_id}` 返回余额与冻结读模型（含推导出的可用余额）；无钱包行的用户返回全零视图。
- `POST /billing/holds` 按 `{user_id, agent_id, turn_id, estimated_amount}` 创建预授权（201）。同一 Agent 与 turn 的同载荷活动 hold 返回 200/replayed；换用户或金额、以及终态 turn 重放返回 409。未知用户返回 404；可用余额不足或触发负余额硬停返回 402 与当前钱包。
- `POST /billing/settlements` 按 `{hold_id, actual_amount}` 结算（200）：先赠后本扣减、解冻全部冻结额、hold 落定 settled；该 hold 没有真实计量事件时补一条 source 为 estimated 的兜底行。同一实际金额重放返回原扣减明细，换金额返回 409。未知 hold 404，已释放或已过期 409。
- `POST /metering/events` 接收带必填 `idempotency_key` 的网关推账。新事实返回 201，同键同载荷返回相同事件 ID 与 200/replayed，同键异载荷返回 409。带 hold 的事件必须与其 user、Agent、turn exact 匹配且 hold 仍为 held；source 只接受 gateway 与 agent_report，estimated 行只能由 settle 兜底写入。
- `POST /billing/admin/recharges` 按 `{user_id, amount, idempotency_key, ref_id?}` 手工充值到本金桶（201）。同键只有用户、金额与引用完全一致时返回当前钱包（200/replayed），任一字段变化或累计余额越过安全数值范围返回 409，未知用户返回 404。
- `GET /health` 与 `GET /ready` 是健康与就绪探针，就绪探针实际检查 PostgreSQL 可达性。

## 上下游

设置 `BILLING_PAYMENTS_ENABLED=true` 后增加 `POST /billing/call-admissions` 和三个 `/v1/payments` 创建、按编号查询、按 requestKey 找回接口。默认不注册这些路由。

开启时须配置 `BILLING_PAYMENT_TOKEN_KEY`（至少 32 字符）、`BILLING_PAYMENT_GATEWAY_TOKEN`、`BILLING_PAYMENT_CHECKOUT_BASE_URL`、`BILLING_AUTHZ_BASE_URL`、`BILLING_AUTHZ_JWKS_URL` 与 `AUTHZ_ASSERTION_ISSUER`。支付凭证密钥、Gateway 准入凭据、原记账凭据和管理凭据四者必须不同；production 的三个地址必须为 HTTPS。

Host 支付接口当前只接受 `cb_v2_session` Cookie，每次请求都向 Authz 查询当前会话；注销或撤销后不能继续查询支付。POST 必须携带允许的 Origin。`BILLING_PAYMENT_HOST_ORIGINS` 可配置逗号分隔的完整来源，默认仅允许收银台地址的来源；跨域仅放行配置值且允许 Cookie，不支持通配来源。当前不支持支付专用 Bearer 模式，不能拿用户断言或 Agent 令牌替代 Cookie。

支付模块使用 `0016_v2_payment_admission.sql` 的四张新增表：收费调用、支付请求、Host 请求编号和原调用资金预留。余额不足时充值金额固定为这次调用的估算额；现有余额保留在用户钱包。到账后新增额度先为原调用预留，七天未认领可以释放为普通余额。创建支付有效期为十五分钟；有效期只限制用户创建/打开动作，可信渠道晚到的成功通知仍可按原金额入账一次。

`confirmPayment()` 只能由已经核验渠道通知的适配器调用。当前未配置真实渠道或收银台页面，也没有部署这条支付链路，不能将模块测试描述为真实支付上线。

渠道模块使用追加迁移 `0017_v2_payment_channel.sql`。下单前先保存订单，进程中断、响应丢失或保存响应失败都不能再次提交新单。查单最多 120 次且只自动查询创建后 24 小时内的订单，多副本领取两分钟租约；可信晚到成功通知仍可完成原支付。二维码内容只供已认证 Combo 收银台读取，过期或已入账后不再提供。当前渠道服务仍是独立模块，尚未接入公开回调、页面和进程调度。

上游是模型网关（hold / settle / usage 上报）与各 Agent 的 SDK（余额查询），以及验证期的运营手工充值。下游是 PostgreSQL 的 `v2_wallets`、`v2_ledger`、`v2_orders`、`v2_packages`、`v2_holds` 与 `v2_metering_events` 六张表，使用专用角色 `combo_billing`。`v2_orders` 与 `v2_packages` 本期只建表不暴露接口。
