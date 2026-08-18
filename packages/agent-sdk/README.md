# packages/agent-sdk — Agent 运行时 SDK

这个包给收编的 Agent 提供平台能力的进程内入口，是薄容器契约的默认实现，目标消费者是 Next.js 写的 Agent。包含三块：断言验签（校验 ForwardAuth 注入的 JWT 身份断言）、llm client（指向平台模型网关的 OpenAI 兼容客户端）、entitlement（查询计费服务的钱包读模型）。包不持有任何 provider key 与平台密钥；运行时不依赖 Node 专有 API，Next.js 的 Node 与 Edge 运行时都能用。

## 文件

- `src/config.ts` 从环境变量解析 SDK 配置（agent_id、内部 token、网关 / 计费 / JWKS 地址），缺失项一次性报错。
- `src/assertion.ts` 是断言验签：JWKS 公钥带缓存与 kid 轮换感知（未知 kid 强制刷新一次），强制 audience 等于本 Agent 的 agent_id，验签失败抛带结构化 code 的 AssertionVerificationError；`extractAssertion` 与 `verifyRequest` 负责从 Next.js Request 或普通 header 记录提取 `x-combo-assertion`。
- `src/llm.ts` 是模型网关客户端：自动注入 `x_combo` 平台扩展（user_id / agent_id / turn_id，turn_id 可传可自动生成），非流式返回 JSON，流式返回原始字节流供路由处理器直接透传，`parseChatStream` 提供逐帧 JSON 的异步迭代形态。
- `src/entitlement.ts` 读计费服务的钱包读模型（余额与冻结），是权益判定下沉 Agent 的落点；SDK 不缓存读模型。
- `src/index.ts` 汇总导出。
- `src/__tests__/` 是不依赖真实服务的 vitest 测试，JWKS 与 HTTP 调用全部用内存桩。

## 本期取舍

storage 能力本期不做：托管存储的开通是中台四 provisioner 的事，SDK 的 storage client 留到第一个 Agent 真正接入存储时再建。消息 envelope 与 CLI（combo push 等）同样不在本期范围。

## 上下游

被各 Agent 应用依赖（模板见 templates/nextjs-agent）。上游服务是 authz（JWKS 端点）、模型网关（chat completions）和计费服务（钱包读模型）；内部 token 由 Agent 的部署环境注入，SDK 只从环境变量读取。
