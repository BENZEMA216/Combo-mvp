# apps/llm-gateway — V2 模型网关

模型网关在调用模型前向 Billing 申请准入，转发模型响应，并提交使用量和结算。服务不直接保存业务请求或连接数据库，模型供应商密钥仅在网关内使用。

计费超时、网络错误、5xx、畸形响应和重复准入都会在模型调用前停止。网关不会因计费不可用而放行收费调用。

## 文件

- `src/index.ts` 加载配置，装配 Billing、支付准入和模型供应商客户端。
- `src/env.ts` 解析配置。开启新支付准入时必须配置独立的 Gateway 到 Billing 凭据。
- `src/identity.ts` 分别验证 Authz 签名的短期 Agent 令牌和当前用户断言，从签名内容获得用户与 Agent，不接受请求体自报身份。
- `src/pricing.ts` 读取模型价格并以整数分估算和结算，使用 BigInt 中间计算避免精度丢失。
- `src/billing.ts` 保留旧 hold、结算和计量客户端，请求拒绝重定向。
- `src/payment-admission.ts` 调用统一收费准入接口，计算规范请求摘要和价格版本，严格检查支付 402、hold 与重放状态。响应读取最多 64 KiB，超时即停止。
- `src/service.ts` 解析新旧调用编号、剥离平台字段并处理用量结算。旧 hold 入口也在计费故障时停止模型调用。
- `src/provider.ts` 调用模型供应商，成功响应保持 JSON 或流式字节。
- `src/usage.ts` 增量提取流末尾的使用量。
- `src/app.ts` 装配 HTTP 入口。支付 402 使用网关当前 traceId；普通错误使用统一人话错误信封，不原样转发 Billing 或供应商错误正文。
- `src/__tests__/` 覆盖准入顺序、支付前零模型调用、并发重放、错误与协议边界。

## 请求编号

正式身份模式使用 `Authorization: Bearer <Agent 短期令牌>` 和 `x-combo-assertion: <当前用户断言>`。请求体只传业务拥有的两个编号：

```json
{
  "x_combo": {
    "operation_id": "operation-1",
    "call_id": "call-1"
  }
}
```

仅非 production 的 `legacy-test` 模式兼容 `user_id + agent_id + turn_id` 或 `user_id + agent_id + operation_id + call_id`。turn_id 只映射为收费 callId；网关另外生成稳定的旧业务引用。新旧字段混用返回 400；正式身份模式即使请求体身份与签名一致也返回 400。

两种格式在转发给模型前都会剥离 x_combo。请求顶层的 operationId、paymentToken、requestKey、裸身份等保留字段会被拒绝。

## 支付准入

设置 `LLM_GATEWAY_PAYMENT_ADMISSION=true` 并提供独立 `BILLING_PAYMENT_GATEWAY_TOKEN` 后，网关调用 `POST /billing/call-admissions`。该凭据不能与 Agent 调网关的凭据相同。

Billing 返回新 hold 后，网关才调用模型；返回 replay 时停止并返回 409；余额不足时严格验证标准 402，再以网关当前 traceId 返回。流式请求的 402 也在 SSE 开始前返回普通 JSON。供应商自己的 402 不会被当成 Combo 支付要求。

新开关默认关闭，以便单独更新 Billing 认证与入口接线。关闭时沿用旧 hold 接口，但计费故障仍停止；旧余额不足响应只返回一般 402，没有可供 Host 支付的新凭证。

## 身份配置

`NODE_ENV=production` 默认使用 `LLM_GATEWAY_AUTH_MODE=agent`，并拒绝 `legacy-test`。正式模式必须配置 `AUTHZ_JWKS_URL` 与 `AUTHZ_ASSERTION_ISSUER`，且删除旧的 `LLM_GATEWAY_INTERNAL_TOKEN`；production 的 JWKS 必须使用 HTTPS。非 production 默认保留旧验证模式，可显式选择 agent 模式验证新接入。

Agent 令牌只接受 Authz 的 Ed25519 签名，最长五分钟，接收方必须是 `combo-llm-gateway`，权限必须是 `llm:invoke`。用户断言必须由同一受信 Authz 签发、尚未过期且接收方等于当前 Agent。任一校验失败都不会请求 Billing 或模型；签名服务不可用返回 503。

现有 V2 环境仍是旧配置，不能直接用新 production 入口替换。先完成 SDK、每 Agent 配置及代理 Cookie 隔离，再在获授权的环境中验证。当前代码测试不表示完整外部支付链路可用。

## 收尾

成功响应后，真实用量全部提交成功才进行结算；部分提交失败保留 hold。缺少真实用量时按估算结算。供应商失败时按零用量释放 hold。

同一次收费调用的准入响应丢失时，重试可能得到 replay，网关不会再次调用模型。业务必须保留结果不确定状态，不能换 callId 自动重试。

## 上下游

上游是 Agent SDK，正式模型请求使用每 Agent 短期令牌和当前用户断言。下游包括 Billing 的准入、hold、settle 和 metering 接口，以及由 `PROVIDER_BASE_URL` 配置的模型供应商。价格来自 `LLM_GATEWAY_PRICING_JSON`，必须包含 default 条目。新支付准入与旧计量凭据必须不同，只保存在网关内。
