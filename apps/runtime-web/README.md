# apps/runtime-web（Agent 消费与充值前端）

这个包提供 `/try/` 下的 Agent 消费界面。它读取 `@cb/shared` 的 Runtime 契约，通过同源 HttpOnly Cookie 调用 Runtime，并使用 SSE 展示 Turn 与 Artifact 的实时状态。

## 计费交互

- 每次真实发送在浏览器生成一个 UUID `usageId`。Runtime 为 402 原任务保存待恢复记录；固定 Hosted Agent 在刷新、新标签页或浏览器重启后通过服务端 list 再 exact GET 恢复原始问题、Session、冻结绑定、计费策略、单价与当前充值 intent。浏览器存储不是这条链路的业务真源。
- 新 402 必须给出与原请求相同的 `recoveryUsageId`，支付 intent 可以由服务端替换；旧 402 只有在 `rechargeIntentId === usageId` 时才可识别。两种响应都必须再次 exact GET 到匹配的服务端待恢复记录才开放支付。
- Runtime 在免费额度耗尽且余额不足时返回 HTTP 402 充值业务体。界面不会把前端跳转或收银台页面视为支付成功。
- 固定 Hosted Agent 只按待恢复记录中的冻结单价创建订单，请求同时携带原 `recoveryUsageId` 和当前 intent；只有服务端 CAS 接受 replacement 后，界面才切换 intent。普通消费入口继续保留原有手动金额充值，不受固定入口约束。
- 界面只轮询 Combo 内部充值订单。恢复时先查询 `by-recovery`，已到账的旧 intent 优先于仍活跃的新 intent；订单到账并经服务端确认后，才通过浏览器级 Web Lock 重放原请求。锁在有界、可取消的终态确认窗内保持，直到 exact GET 返回 404；网络失败、超时或页面退出只释放浏览器锁并保留服务端恢复记录，不在本地宣告完成。
- 一个充值 intent、内部订单和乐收赢流水保持一一对应。支付失败后 replacement 会生成新的 intent 和订单，不会修改或重放旧网关流水。
- 用户放弃固定 Hosted Agent 的原任务时调用服务端 abandon；成功后才清理界面，409 保留恢复状态。旧充值订单不会被删除或改写，后续若确认成功仍会正常入账。
- 服务端达到主动查单次数或时间上限后，界面降为低频观察可信回调；用户新建充值前会再复核旧订单。旧订单仍保留，后续可信回调仍可独立完成入账。

## 固定 Hosted Test Agent

- 消费者入口固定为 `/try/agent/combo-knowledge`。匿名访问只渲染静态 Test Beta 外壳；AuthGate 只调用 `/me`，登录链接精确返回该路径，不请求 descriptor、recovery 或 start。
- 认证后读取严格公开 descriptor，再查询服务端待恢复记录；没有恢复项时，空 body 调用 `/runtime/agents/combo-knowledge/start`。响应只使用 `sessionId`，Package、Release、gate、对象键等内部选择器不会进入页面契约。
- 入口只接受 Runtime 已验证的 Test gate v2 与精确冻结 Package。404 表示入口关闭、漂移或不存在，503 表示真实依赖暂不可用；两者都不能创建 Session。
- 知识引用正文只显示 Session detail 中由 Runtime 从冻结 cited chunk 投影的 NFC 纯文本前缀，最大 2 KiB。前端按文本节点渲染，不从 receipt、response digest 或结算数据重建正文。

## 源码结构

- `src/api/client.ts` 是同源 HTTP 边界，并保留经过明确识别的 402 业务体。
- `src/api/runtime.ts` 与 `src/api/useSessionStream.ts` 管理发送、SSE 和使用幂等。
- `src/api/recovery.ts` 只从服务端 list → exact 恢复，并用浏览器级锁协调终态前的唯一重放。
- `src/api/billing.ts` 提供钱包、创建充值和内部订单轮询。
- `src/components/RechargeDialog.tsx` 同时提供普通手动充值与固定单价的服务端恢复支付。
- `src/sessionExperience.ts` 根据持久化会话模式和明确的 Agent 绑定选择 Studio、知识问答或普通消费体验。
- `src/components/KnowledgeConversation.tsx` 只从权威知识结果渲染回答、引用和使用收据，并忽略助手消息、工具消息和流式候选文本。
- `src/pages/HostedKnowledgeAgentPage.tsx` 提供固定消费者入口；`src/pages/ChatPage.tsx` 为知识会话提供全高对话界面，不挂载输入表单或产物画布。

## 验证

```sh
pnpm -F @cb/shared build
pnpm -F @cb/runtime-web typecheck
pnpm -F @cb/runtime-web typecheck:test
pnpm -F @cb/runtime-web test
```

前端测试使用 fake API，不连接乐收赢，也不保存或输出完整收银台地址、回调、签名或机构密钥。
