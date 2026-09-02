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
- `external-mcp-tools.test.ts` 验证无状态 MCP 工具的公开投影、显式资源身份、三类案例质量复核与发布门禁，并验证当前任务 Codex Agent 创建/读取不调用旧提取、Capability、Agent Project 或 Project Agent 链路。它还固定 Creator 的 commit/tree 安全确认 action、Receiver 的 strict `codex_agent_restore` 服务端完整构卡、digest/M/N 安全 action，以及 Agent Builder 单个事实可完整承载合法最大 requirements 并拒绝超过二万字符的事实。
- `external-mcp-routes.test.ts` 验证 OAuth 后的 MCP transport、二十三项 legacy 工具与五项 Project-history 工具发现、Agent Builder MCP App 资源、strict restore 输入、带 `starterOrdinal` 的 prepare 输入输出，以及手写 JSON Schema 与共享契约的一致性。它还锁定 `/codex-plugin` 的 174-byte 唯一安装请求、仅从官方 filtered Plugin row 的 `source.path` 定位 0.8.7 controller、realpath/mode/CUA Node/零 stdin/strict stdout 执行门、recovery-only typed result、initial→continuation 代码强制与 continuation→business Host trace 边界、五 V3 缺失先停、mixed Host create 返回失败、READY wait 后才可 navigate，并反断言运行页面不得泄漏候选态 `CODE_CONTRACT` / `NOT_DEPLOYED` / `NOT_UAT`。
- `codex-agent-share.pg.test.ts` 在显式开启时用最小权限 `combo_api` 连接专用 PostgreSQL，验证最长合法 instructions/starter 的 U+0001、CRLF、合法 astral 和 Host delimiter 文本经过 jsonb、公开读取、摘要与 prepare 后逐字不变，并确认 NUL 和未配对 surrogate 在 schema 边界失败且不新增行。
- `agent-builder-app.test.ts` 用宿主仿真验证 MCP App 的 initialize/initialized 生命周期、工具结果渲染、二万字符事实与五条完整 starter、标准 `ui/message`、兼容消息回退与固定 HTML 摘要。
- `task-service.test.ts` 验证任务状态机、建任务幂等、重试和过期对账。
- `pairing.test.ts` 验证配对码、快照准备、分片登记和对象清理。
- `connect-script.test.ts` 验证本机助手脚本的续传与响应丢失处理。
- `session-parse.test.ts` 验证 Codex 宿主注入过滤、委派消息只提取真实输入，以及畸形委派包装安全丢弃。
- `pipeline.test.ts` 验证提取流水线的租约、进度、终态、清理和失败收口。
- `extract.test.ts` 验证大模型输出修复、候选过滤，以及合法空结果与上游降级的区分。
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

Agent Project 模块旁的 `repo.test.ts` 使用事务假件验证 Test Review 的幂等、不可变和 Release 证据冻结，不连接外部服务。

`codex-agent-share/service.test.ts` 验证当前任务派生 manifest 的幂等字节稳定、完整接收文案 golden、摘要、旧新 schema URL 分流、同表跨 schema 幂等冲突、匿名跨用户读取、篡改失败关闭、`starterOrdinal` 与 starter 的权威双重绑定，以及 instructions 与 starter 原文不进入 copyPrompt。

## 上下游

测试直接读取 `modules/` 与 `platform/` 的公开函数。`account-auth.pg.test.ts` 只在 `AUTH_PG_TEST=1` 且提供 `DATABASE_URL` 时运行，并只删除本轮创建且尚未关联业务数据的认证主体。`external-mcp-refresh.pg.test.ts` 与 `external-mcp-dcr.pg.test.ts` 在 `MCP_OAUTH_PG_TEST=1` 下验证真实 PostgreSQL 的 refresh family 串行、动态注册去重、生命周期、硬容量和并发边界；后者还需要最小权限 API 连接 `MCP_OAUTH_API_DATABASE_URL`。`codex-agent-share.pg.test.ts` 在 `CODEX_AGENT_SHARE_PG_TEST=1` 且提供 `CODEX_AGENT_SHARE_PG_DATABASE_URL` 时，于单个回滚事务内验证真实 jsonb 往返并要求当前角色为 `combo_api`。`external-mcp-rate-limit.integration.test.ts` 在提供 `MCP_RATE_LIMIT_REDIS_URL` 时用两个 Fastify 实例验证共享 Redis 计数与故障关闭。测试数据只使用保留域名、文档地址和测试密钥。
