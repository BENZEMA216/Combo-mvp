# authoring 自动化测试

这个目录验证 authoring 的业务纯函数、仓储语义、HTTP 边界和基础设施适配器。默认测试不连接外部服务，并使用假数据库、假队列、假对象存储或注入的 `fetch`。

## 文件

- `fakes.ts` 提供任务、上传、能力项、对象存储、队列、事件流和大模型的内存假件。
- `account-auth.test.ts` 验证四个认证 handler 的响应、错误映射、Cookie 属性、登出数据库故障和敏感日志边界。
- `account-service.test.ts` 验证 challenge 两段事务编排、邮件结果映射、Redis 故障策略和 verification 结果映射。
- `account-repo.test.ts` 使用假事务连接验证 Redis 限流不可用时的数据库硬守卫，不存在活动挑战的重复验证不会追加失败审计行。
- `account-auth.pg.test.ts` 在显式开启时连接专用 PostgreSQL 测试库，验证冷却、重发、乱序投递完成、过期、五次失败、并发单次消费、首次建号、复登、停用、会话撤销，以及 Redis 故障下活动挑战继续验证且无匹配目标不产生审计写放大。
- `auth-crypto.test.ts` 验证邮箱规范化、HMAC 域分离、前导零验证码、随机账号和会话格式。
- `auth-session.test.ts` 验证生产与本地 Cookie 选择、父域无前缀 Cookie 忽略、会话摘要查询、401、403、503、Bearer 与查询参数凭据拒绝。
- `auth-rate-limit.test.ts` 验证验证码请求的 Redis 窗口只按客户端摘要计数，验证码验证才同时使用目标与客户端摘要窗口。
- `resend.test.ts` 验证 Resend 请求形状、幂等头、发送方与收件方错误白名单、五秒超时、不重试和供应商正文不外泄。
- `env-auth.test.ts` 验证生产认证配置必填、官方 Resend 基址、HTTPS 公开站点和 worker 密钥边界。
- `auth-http-boundary.test.ts` 验证认证路由的 Origin、JSON、四 KiB 上限、413、415 与 `no-store`。
- `browser-origin.test.ts` 验证 CORS、认证请求和 Cookie 鉴权业务写请求的精确来源策略。
- `observability-redaction.test.ts` 使用内存 span 导出器验证查询凭据、客户端地址、请求头、正文和异常文本在导出前被删除，并验证浏览器事件的敏感 pathname 只形成固定路由桶。
- `routes.test.ts` 核对端点总数、无重复、认证公开面和前置守卫。
- `agent-package-object-store.test.ts` 通过 AWS SDK 假件与对抗流验证 Agent Package 对象的条件首次写入、exact-byte 幂等回读、异内容冲突、声明长度与流式上限、取消、流收尾和错误脱敏。
- `task-service.test.ts` 验证任务状态机、建任务幂等、重试和过期对账。
- `pairing.test.ts` 验证配对码、快照准备、分片登记和对象清理。
- `connect-script.test.ts` 验证本机助手脚本的续传与响应丢失处理。
- `pipeline.test.ts` 验证提取流水线的租约、进度、终态、清理和失败收口。
- `extract.test.ts` 验证大模型输出修复、候选过滤和确定性降级。
- `capability-repo.test.ts` 验证能力项读取、发布和归属过滤。
- `leshouying-signer.test.ts` 使用固定假参数验证 null、空串、ASCII 排序、UTF-8 和回调重签的签名 golden vectors。
- `leshouying-gateway.test.ts` 通过注入的假 fetch 验证二维码支付（C扫B `/v3/prepay`）、支付查单、响应验签、字段归属、超时不重试、无长度响应的流式上限、非法回调参数名和支付动作安全边界。
- `env-billing.test.ts` 验证支付默认关闭、测试配置、缺失配置失败关闭和正式网关二次开关。
- `billing-service.test.ts` 使用内存仓储和假支付网关验证手动金额下单、充值幂等、在途预下单不重复提交或提前查单、超时查原单、通知幂等、未验签通知不持久化、金额不符和成功状态单调性。
- `billing-reconcile.test.ts` 验证后台清理到期支付动作和查单启动即运行、进程内不重叠、关闭等待、测试配置不联网，以及网关开关关闭时只清理而不查单。
- `billing-repo.test.ts` 验证预下单结果保存先锁充值订单，并且不会把先到的成功通知降级。
- `billing-http-boundary.test.ts` 验证支付通知不要求 Cookie 或 Origin，并且错误内容类型、畸形 JSON、请求体上限和限流始终返回固定网关响应。
- `billing-handler.test.ts` 验证按充值意图恢复订单时使用 owner 范围查询，未找到只返回安全 404 信封。
- `billing.pg.test.ts` 是显式开启的专用 PostgreSQL 并发测试。只有 `BILLING_PG_TEST=1` 且同时提供管理员 `BILLING_TEST_DATABASE_URL` 与 `combo_api` 的 `BILLING_AUTHORING_TEST_DATABASE_URL` 时运行；所有真实仓储 SQL 使用最小权限角色，管理员连接只负责隔离测试数据的准备和断言。它验证预下单崩溃恢复、并发幂等准备、用户订单 admission、查单退休、支付动作清理、通知与查单并发只入账一次，以及通知早于预下单结果时成功状态不被降级。

## 上下游

测试直接读取 `modules/` 与 `platform/` 的公开函数。`account-auth.pg.test.ts` 只在 `AUTH_PG_TEST=1` 且提供 `DATABASE_URL` 时运行，并只删除本轮创建且尚未关联业务数据的认证主体。测试数据只使用保留域名、文档地址和测试密钥。
