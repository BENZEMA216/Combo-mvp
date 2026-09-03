# Payment SDK 与支付中台接入说明

状态：`PARTIAL`。本文锁定第一版边界和公共协议，不表示支付后端、正式身份、Combo Host 或真实支付已经上线。

## 一句话边界

Payment SDK 只封装 Combo 支付中台接口。它不保存业务数据，也不替业务继续任务。

| 部分           | 负责                                                     | 不负责                            |
| -------------- | -------------------------------------------------------- | --------------------------------- |
| 业务           | 保存原请求、`operationId`、`callId`、业务状态和结果      | 支付订单、回调、钱包和流水        |
| Payment SDK    | 调用支付接口、严格检查响应、统一错误和传递防重复编号     | 数据库存储、定价、业务恢复        |
| Combo 支付中台 | 价格快照、支付请求、订单、渠道回调、到账、资金预留和流水 | 保存用户 Prompt、决定业务下一步   |
| Combo Host     | 使用当前登录用户解析支付凭证并打开 Combo 收银台          | 相信 Agent 自报金额、网址或二维码 |

支付中台可以保存业务请求编号和不可逆摘要用于防重复核对，但不得保存原始问题、Prompt 或业务结果。

## 三个编号

- `operationId` 是一次完整业务请求，由业务在首次调用前创建并保存。
- `callId` 是业务请求中的一次收费调用，网络重试和支付后继续都必须复用。
- `requestKey` 是 Host 创建支付时的防重复编号，创建结果不确定时必须复用。

现有 Hosted Runtime 的 `usageId` 接近业务请求编号，V2 Gateway 的 `turnId` 接近收费调用编号。两者不能在新协议里定义成同一个概念。

## 标准流程

```text
业务保存原请求、operationId 和 callId
        │
        ▼
调用模型或其他收费能力
        │
        ▼
支付中台发现余额不足，创建或返回同一支付请求
        │
        ▼
SDK 抛出类型化 Payment Required
        │
        ▼
Agent 只把 Combo 的短期 paymentToken 交给 Host
        │
        ▼
Host 使用当前登录用户向 Combo 创建并打开托管支付
        │
        ▼
Combo 确认渠道结果、入账，并完成支付侧资金处理
        │
        ▼
业务读取原请求，使用原 operationId 和 callId 继续
```

支付耗时后，Host 必须提供当前用户的新身份。业务不能保存第一次请求的短期用户凭据后继续使用。

## 公共 HTTP 合同

公共合同由 `@cb/payment-protocol` 提供，OpenAPI 真源位于 `packages/payment-protocol/openapi/payment-v1.openapi.json`。

余额不足响应包含平台权威金额，但 Agent 交给 Host 的消息严格只有三个字段：

```json
{
  "version": 1,
  "type": "combo.payment_required",
  "paymentToken": "Combo 签发的短期不透明凭证"
}
```

Host 不能直接使用 Agent 返回的金额、支付方式、二维码或网址。它必须用当前用户会话把 `paymentToken` 交给 Combo，再读取权威支付状态。

首版支付接口只有：

- `POST /v1/payments`：用 `paymentToken` 和稳定 `requestKey` 创建或重放支付。
- `GET /v1/payments/{paymentRequestId}`：读取一个支付请求。
- `GET /v1/payments/by-request-key/{requestKey}`：创建结果不确定时找回原支付。

支付状态只有：

- `waiting`：等待用户进入 Combo 收银台。
- `processing`：Combo 正在确认支付或入账。
- `completed`：Combo 已确认到账并完成支付侧入账。
- `closed`：支付请求已经关闭或过期。

渠道页面显示成功不能替代 `completed`。支付完成也不表示业务已经恢复；业务仍需读取自己的状态后决定是否继续。

## 防重复与网络中断

所有写操作都必须先生成并保存防重复编号。同一编号和同一内容返回原对象；同一编号换内容固定冲突。

创建支付时超时、连接中断、5xx、空响应或畸形成功响应都属于“结果不确定”。调用方只能：

1. 用原 `requestKey` 查询；
2. 用原 `requestKey` 重试。

不能换新编号再下一单。查询可以在明确总时限内重试，等待结束后不能在后台继续运行。

## 身份与密钥

- Agent 身份必须来自每个 Agent 独立、短期、限权的凭据。
- 用户身份必须由 Gateway 和 Host 各自在当前请求中重新验证。
- 平台从凭据得到 Agent，不相信请求体自报的 `agentId`。
- Agent 不接触支付渠道、商户、回调或平台全局密钥。
- `paymentToken`、完整收银台地址和原始错误对象不得进入日志。

当前 V2 验证栈仍使用共享内部凭据，所以上述正式身份为 `NOT_IMPLEMENTED`。在身份边界完成前，不能把 SDK 描述为可对外安全使用。

## 第一版不做

- 主动充值；
- 退款；
- 订阅；
- 分账；
- 税务和发票；
- 多币种；
- SDK 保存或自动恢复业务请求；
- Agent 直连任何支付渠道。
