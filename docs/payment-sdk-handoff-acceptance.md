# Payment SDK 盲交接验收

状态：`NOT_RUN / PARTIAL`。

本验收证明一个不了解 Combo 内部代码的开发者或编码 Agent，只凭公开协议、锁定 SDK 和受限 Test 配置，可以接入“余额不足后支付并继续原请求”。它不重新验收旧 Hosted 支付，也不允许读取平台或支付渠道密钥。

## 固定输入

验收对象只能获得：

- 本文和 `docs/payment-sdk-integration.md` 的固定 URL；
- 带 Tag、提交 SHA 和校验值的 SDK 工件；
- 受限 Test 环境地址与每 Agent 独立身份；
- 一个空白业务工程或完整 Reference Agent；
- Fake Payment 与统一验收命令。

不得搜索 Combo 或 SDK 内部源码，不得询问维护者补充协议，不得读取或输出任何 Secret 值。

## 必须完成的流程

1. 安装锁定 SDK 并完成构建。
2. 使用平台签名的当前用户身份发起一次正常收费调用。
3. 使用新的 `operationId` 和 `callId` 触发余额不足，确认模型或业务调用次数为零。
4. 得到严格标准 402，并只把三字段支付消息交给 Host。
5. Host 使用当前登录用户解析凭证并打开 Combo 托管收银台。
6. 完成 Fake Payment，再在受控 Test 中完成真实测试支付。
7. 确认支付只有在 Combo 入账后才成为 `completed`。
8. 业务读取自己保存的原请求，并用原 `operationId` 与 `callId` 继续。
9. 重复继续时直接返回已保存结果，不产生第二次业务调用、资金预留、扣费或流水。
10. 运行统一 conformance 命令并保存绑定精确版本的低敏证据。

## 必须覆盖的失败场景

- 402 或支付响应多出未知字段。
- Agent 向 Host 塞入金额、网址、二维码、用户或 Agent 标识。
- 支付凭证过期、属于另一用户或另一 Agent。
- 同一防重复编号换金额、调用或业务摘要。
- 创建支付的响应超时、连接中断、5xx、空响应或畸形响应。
- 支付动作过期后旧订单收到可信的晚到成功通知。
- 支付渠道显示成功但 Combo 尚未入账。
- 两个标签页或两个进程并发创建支付、继续原调用。
- 同一支付凭证使用两个不同 `requestKey` 并发创建时出现第二个支付记录、渠道订单或入账。
- 首次用户身份已经过期，恢复时没有当前用户的新身份。
- Agent A 查询 Agent B 或其他用户的支付。

## 证据要求

所有结论必须绑定：

- Combo 候选提交 SHA；
- SDK Tag、提交 SHA、工件 SHA-256；
- Payment OpenAPI SHA-256；
- Reference Agent 提交与运行身份；
- Test 环境、数据模式与身份模式；
- 模型调用、支付请求、支付订单、入账、资金预留、扣费和流水的低敏计数；
- Contract、Security、Recovery、Host、UAT 五层各自状态。

页面打开、HTTP 200、单元测试、Mock 或本地构建都不能单独将验收标为通过。只有完整链路全部通过，才能把 `PAYMENT_SDK_DOC_HANDOFF` 改为 `PASS`。

## 当前缺口

- 支付 SDK 已按锁定的 Combo 协议实现并完成合同测试。Billing 的支付路由、PostgreSQL 支付基础和当前会话认证已通过开关接入进程入口，但真实渠道和收银台页面尚未实现，也未部署。
- 标准 402 的服务端生成、到账后入账和原调用资金预留已有模块实现，仍缺完整环境验收。
- Authz 已提供每 Agent 短期身份，Gateway 正式模式已重新验证用户身份；SDK 取令牌和代理 Cookie 隔离尚未接入，当前不能标记安全验收通过。
- Combo Host 支付凭证解析尚未接入。
- Sandbox、Fake Payment、conformance 和真实 Test 支付尚未运行。
- SDK 仍未发布正式 Tag、Release 与锁定工件。

因此当前状态保持 `NOT_RUN / PARTIAL`，不得关闭 Issue #308。
