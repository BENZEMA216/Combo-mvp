# apps/runtime-web（Agent 消费与充值前端）

这个包提供 `/try/` 下的 Agent 消费界面。它读取 `@cb/shared` 的 Runtime 契约，通过同源 HttpOnly Cookie 调用 Runtime，并使用 SSE 展示 Turn 与 Artifact 的实时状态。

## 计费交互

- 每次真实发送在浏览器生成一个 UUID `usageId`。网络结果不确定、409 或 402 时保留该值；只有服务端接受/重放原 Turn，或用户明确放弃 402 原任务后才清理。充值到账会以完全相同的规范化文本和 `usageId` 自动恢复原任务，不生成第二个任务编号。
- `PendingUsageV2` 在 `sessionStorage` 中分开保存不可变的任务 `usageId` 与当前支付 `activeRechargeIntentId`。刷新后优先查询持久化的 active intent；同一原任务再次返回 402 不得把 replacement intent 覆盖回 `usageId`。旧 V1 没有 replacement 指针，迁移时只保留可证明的原任务，并先用同一 `usageId` 重新取得权威 402，绝不猜测旧页面最后操作的订单。
- Runtime 在免费额度耗尽且余额不足时返回 HTTP 402 充值业务体。界面不会把前端跳转或收银台页面视为支付成功。
- 充值金额由用户在对话框手动输入（元，最多两位小数），最低值是 `max(1 分, requiredCents - balanceCents)` 的实际差额。支付统一使用扫码（C扫B 二维码），没有 H5 收银台跳转。
- 界面只轮询 Combo 内部充值订单，浏览器持久化只保存恢复指针，不是订单真源。订单状态变为 `credited` 且返回的 intent 与 active intent 精确匹配后，才刷新钱包并通过单一同步锁恢复原请求；React StrictMode 的重复 effect 不会产生重复 POST。
- 一个充值 intent、内部订单和乐收赢流水保持一一对应。支付失败后“重新充值”会生成新的 intent 和订单，不会修改或重放旧网关流水。
- 支付入口失效或订单结果未知时，用户可以明确放弃原任务；旧充值订单不会被删除或改写，后续若确认成功仍会正常入账。
- 服务端达到主动查单次数或时间上限后，界面降为低频观察可信回调；用户新建充值前会再复核旧订单。旧订单仍保留，后续可信回调仍可独立完成入账。

## 源码结构

- `src/api/client.ts` 是同源 HTTP 边界，并保留经过明确识别的 402 业务体。
- `src/api/runtime.ts` 与 `src/api/useSessionStream.ts` 管理发送、SSE 和使用幂等。
- `src/api/billing.ts` 提供钱包、创建充值和内部订单轮询。
- `src/components/RechargeDialog.tsx` 提供手动金额输入和快捷金额，并只渲染后端允许的扫码支付动作。
- `src/sessionExperience.ts` 根据持久化会话模式和明确的 Agent 绑定选择 Studio、知识问答或普通消费体验。
- `src/components/KnowledgeConversation.tsx` 只从权威知识结果渲染回答、引用和使用收据，并忽略助手消息、工具消息和流式候选文本。
- `src/pages/ChatPage.tsx` 为知识会话提供全高对话界面，不挂载输入表单或产物画布。

## 验证

```sh
pnpm -F @cb/shared build
pnpm -F @cb/runtime-web typecheck
pnpm -F @cb/runtime-web typecheck:test
pnpm -F @cb/runtime-web test
```

前端测试使用 fake API，不连接乐收赢，也不保存或输出完整收银台地址、回调、签名或机构密钥。
