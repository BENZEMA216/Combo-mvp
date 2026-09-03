# @cb/payment-protocol — 支付中台公共协议

这个包定义 Combo 支付中台、模型网关、Combo Host 与独立 Agent SDK 共同使用的数据形状。它只描述支付协议，不保存订单、业务请求或资金数据。

## 对外合同

- 标准余额不足响应只包含支付请求、平台签发的短期支付凭证、权威金额和有效期。
- Agent 交给 Host 的消息固定为 `version`、`type` 和 `paymentToken` 三个字段，不包含金额、二维码或网址。
- Host 使用当前登录用户向 Combo 创建支付，再读取 `waiting`、`processing`、`completed` 或 `closed` 状态。
- `completed` 只表示 Combo 已确认到账并完成支付侧入账，不表示业务已经恢复或完成。

所有对象拒绝未知字段。金额使用人民币整数分字符串；编号使用规范 ASCII；支付凭证使用 base64url 兼容字符；时间必须是真实 UTC 日期。

## 文件

- `src/payment.ts` 定义常量、Zod 校验器和由校验器推导的 TypeScript 类型。
- `src/index.ts` 是包的公开入口。
- `openapi/payment-v1.openapi.json` 是支付 HTTP 接口的 OpenAPI 3.1 描述。
- `src/__tests__/payment.test.ts` 验证正常形状、状态约束和恶意输入拒绝。
- `src/__tests__/openapi.test.ts` 验证 OpenAPI 路径、字段和状态与运行时协议一致。

## 边界

业务保存原始请求、`operationId`、`callId`、执行状态和结果。支付中台保存支付请求、订单、回调、入账和资金流水。SDK 只调用接口并检查响应，任何一层都不能用这个包代替自己的持久化责任。
