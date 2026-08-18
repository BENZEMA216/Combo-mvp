# nextjs-agent 模板

这是收编 Agent 的最小模板骨架：fork 它、改业务逻辑，就满足平台的薄容器契约。本期是验证期骨架，不追求开箱即跑完整链路。

## 文件

- `agent.yaml` 是 Agent 与平台之间的唯一契约文件：端口、探针、资源、环境变量名与 capabilities。环境变量只声明名字，值由平台注入。
- `app/api/chat/route.ts` 是调用 SDK 的示例路由：验证 `x-combo-assertion` 头里的身份断言（aud 强制等于本 Agent 的 agent_id），然后把对话请求流式透传给平台模型网关。

## 用法说明

- 身份：路由处理器里用 `createAssertionVerifier(...).verifyRequest(request)` 拿 `userId`。断言只带身份，不带权益。
- 对话：用 `createLlmClient(...)` 调平台模型网关，`userId` 必填，`turnId` 一轮对话复用同一个以对齐计量；余额不足时网关返回 402，SDK 抛 `LlmGatewayError`（status 402，body 含当前钱包），Agent 据此引导充值。
- 权益：用 `createEntitlementClient(...).check(userId)` 读余额与冻结，权益判定在 Agent 代码里完成。
- 配置：五个 `COMBO_` 环境变量在本地开发时自行设置，平台上由 agent.yaml 声明、平台注入。`loadAgentSdkConfig()` 启动即校验，缺失直接报错。

## 本期边界

模板没有包含完整 Next.js 工程文件（package.json、tsconfig 等），收编首个 Agent 时按真实工程补齐；CLI（combo push）、storage 能力与消息 envelope 都不在本期范围。
