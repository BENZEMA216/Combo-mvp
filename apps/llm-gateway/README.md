# apps/llm-gateway — V2 模型网关

这个服务是所有模型调用的唯一出口，只做三件事：编排计费的 check-and-hold、向 provider 流式转发、产出 usage 计量事件。协议面是 OpenAI 兼容子集，本期只代理文本对话（chat 维度）。provider key 只存在于本服务的配置中，Agent 使用平台内部 token 调用。服务无状态，不直接连接数据库，usage 事件经计费服务落库。

## 文件

- `src/index.ts` 是进程入口，加载配置、装配 billing 与 provider 客户端，启动 HTTP 监听并处理优雅停机。
- `src/env.ts` 解析并校验全部环境变量，进程其余部分只读结构化配置。
- `src/pricing.ts` 是单价表（分 / 百万 token，按模型匹配、缺省回落 default）与金额折算：预授权估算按 max_tokens 乘输出单价加固定成本（宁高勿低），结算按真实 token 用量折算。
- `src/billing.ts` 是计费服务客户端：hold、settle、usage 推账，以及把真实用量展开成两条计量事件的纯函数。hold 超时、网络错误与 5xx 统一抛 BillingUnavailableError。
- `src/provider.ts` 是 provider 客户端：非流式返回 JSON，流式返回原始字节流，不整段缓冲。
- `src/usage.ts` 从 provider SSE 字节流里增量提取末帧 usage，按行切分、跨 chunk 缓冲半行。
- `src/service.ts` 是编排核心：请求解析（剥离 x_combo 平台扩展字段、流式强制 include_usage）、check-and-hold（402 透传、计费不可用时 chat 维度 fail-open）、turn 收尾（先推计量再按实结算，任何收尾失败只记日志不影响响应）、provider 失败时按零用量结算等价释放冻结。
- `src/app.ts` 装配 Fastify 路由与入口 token 鉴权；流式响应 hijack 后逐 chunk 透传 provider 字节。
- `src/__tests__/` 是不依赖外部进程的 vitest 测试，`fakes.ts` 提供记录调用参数的内存假客户端。

## 接口与行为

- `POST /v1/chat/completions`（Bearer `LLM_GATEWAY_INTERNAL_TOKEN`）是 OpenAI 兼容子集，支持 stream 为 true 或 false。请求体必须带平台扩展字段 `x_combo: {user_id, agent_id, turn_id}`，转发给 provider 前剥离；其余字段原样透传。转发前先调 billing 创建预授权，billing 返回 402 时把状态码与响应体原样透传给调用方；billing 超时或 5xx 时本期唯一的 chat 维度 fail-open 放行并记警告日志。流式请求自动补 `stream_options.include_usage` 以拿真实 usage。流结束后按真实用量折算金额，先推两条计量事件（llm_token_in 与 llm_token_out，带 hold_id、model、unit_cost、source 为 gateway），再调结算；usage 缺失时按估算结算，billing 会自动补 source 为 estimated 的计量行。provider 返回非 2xx 时状态与响应体原样透传，并按零用量结算以释放冻结。结算或推账失败只记 error 日志，冻结留给 billing 的清扫任务过期解冻。
- `GET /health` 与 `GET /ready` 是健康与就绪探针。

## 上下游

上游是各 Agent（经 SDK 的 llm client，持平台内部 token）。下游是 apps/billing（hold / settle / usage 三个接口，Bearer `BILLING_INTERNAL_TOKEN`，`BILLING_BASE_URL` 指向它）和 OpenAI 兼容的模型 provider（`PROVIDER_BASE_URL` + `PROVIDER_API_KEY`，key 的唯一持有者）。单价表走 `LLM_GATEWAY_PRICING_JSON`（必须含 default 条目）。
