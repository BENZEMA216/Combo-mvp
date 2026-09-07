# apps/llm-gateway — V2 模型网关

模型网关在调用模型前向 Billing 申请准入，转发模型响应，并提交使用量和结算。服务不直接保存业务请求或连接数据库，模型供应商密钥仅在网关内使用。

计费超时、网络错误、5xx、畸形响应和重复准入都会在模型调用前停止。网关不会因计费不可用而放行收费调用。

## 文件

- `src/index.ts` 加载配置，装配 Billing、支付准入和模型供应商客户端。
- `src/env.ts` 解析配置。开启新支付准入时必须配置独立的 Gateway 到 Billing 凭据。
- `src/pricing.ts` 读取模型价格并以整数分估算和结算，使用 BigInt 中间计算避免精度丢失。
- `src/billing.ts` 保留旧 hold、结算和计量客户端，请求拒绝重定向。
- `src/payment-admission.ts` 调用统一收费准入接口，计算规范请求摘要和价格版本，严格检查支付 402、hold 与重放状态。响应读取最多 64 KiB，超时即停止。
- `src/service.ts` 解析新旧调用编号、剥离平台字段并处理用量结算。旧 hold 入口也在计费故障时停止模型调用。
- `src/provider.ts` 调用模型供应商，成功响应保持 JSON 或流式字节。
- `src/usage.ts` 增量提取流末尾的使用量。
- `src/app.ts` 装配 HTTP 入口。支付 402 使用网关当前 traceId；普通错误使用统一人话错误信封，不原样转发 Billing 或供应商错误正文。
- `src/__tests__/` 覆盖准入顺序、支付前零模型调用、并发重放、错误与协议边界。

## 请求编号

新格式为：

```json
{
  "x_combo": {
    "user_id": "当前用户 UUID",
    "agent_id": "agent-a",
    "operation_id": "operation-1",
    "call_id": "call-1"
  }
}
```

旧格式 `user_id + agent_id + turn_id` 保留兼容。turn_id 只映射为收费 callId；网关另外生成稳定的内部 legacy 业务引用，不把 turnId 定义为业务 operationId。新旧字段混用会返回 400。

两种格式在转发给模型前都会剥离 x_combo。请求顶层的 operationId、paymentToken、requestKey、裸身份等保留字段会被拒绝。

## 支付准入

设置 `LLM_GATEWAY_PAYMENT_ADMISSION=true` 并提供独立 `BILLING_PAYMENT_GATEWAY_TOKEN` 后，网关调用 `POST /billing/call-admissions`。该凭据不能与 Agent 调网关的凭据相同。

Billing 返回新 hold 后，网关才调用模型；返回 replay 时停止并返回 409；余额不足时严格验证标准 402，再以网关当前 traceId 返回。流式请求的 402 也在 SSE 开始前返回普通 JSON。供应商自己的 402 不会被当成 Combo 支付要求。

新开关默认关闭，以便单独更新 Billing 认证与入口接线。关闭时沿用旧 hold 接口，但计费故障仍停止；旧余额不足响应只返回一般 402，没有可供 Host 支付的新凭证。

当前入口身份仍是受控验证的共享 token 和请求体身份。正式每 Agent 凭据、用户断言重验与实际 Billing 认证接线尚未完成，不能将本次网关代码描述为完整外部支付接入。

## 收尾

成功响应后，真实用量全部提交成功才进行结算；部分提交失败保留 hold。缺少真实用量时按估算结算。供应商失败时按零用量释放 hold。

同一次收费调用的准入响应丢失时，重试可能得到 replay，网关不会再次调用模型。业务必须保留结果不确定状态，不能换 callId 自动重试。

## 上下游

上游是 Agent SDK，模型请求使用 `LLM_GATEWAY_INTERNAL_TOKEN`。下游包括 Billing 的准入、hold、settle 和 metering 接口，以及由 `PROVIDER_BASE_URL` 配置的模型供应商。价格来自 `LLM_GATEWAY_PRICING_JSON`，必须包含 default 条目。新支付准入与旧计量凭据分别配置，均不进入日志。
