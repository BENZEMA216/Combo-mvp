# apps/runtime-web（Agent 消费与充值前端）

这个包提供 `/try/` 下的 Agent 消费界面。它读取 `@cb/shared` 的 Runtime 契约，通过同源 HttpOnly Cookie 调用 Runtime，并使用 SSE 展示 Turn 与 Artifact 的实时状态。

## 计费交互

- 每次真实发送在浏览器生成一个 UUID `usageId`。网络结果不确定时只复用该值；服务端接受并返回原 Turn 后才生成下一值。402 尚未创建 Turn，充值到账或用户明确放弃后会清理原请求，再次发送使用新值。
- Runtime 在免费额度耗尽且余额不足时返回 HTTP 402 充值业务体。界面不会把前端跳转或收银台页面视为支付成功。
- 充值套餐和金额只从 Authoring 的配置化接口读取。移动收银台使用 H5；桌面场景可以展示本地生成的聚合付款二维码。
- H5 收银台在新页面打开，支付确认期间原任务草稿和 `usageId` 留在当前页面。界面只轮询 Combo 内部充值订单；状态变为 `credited` 后才提示余额到账并解除原 402 请求。
- 一个充值 intent、内部订单和乐收赢流水保持一一对应。支付失败后“重新充值”会生成新的 intent 和订单，不会修改或重放旧网关流水。
- 支付入口失效或订单结果未知时，用户可以明确放弃原任务；旧充值订单不会被删除或改写，后续若确认成功仍会正常入账。
- 服务端达到主动查单次数或时间上限后，界面降为低频观察可信回调；用户新建充值前会再复核旧订单。旧订单仍保留，后续可信回调仍可独立完成入账。

## 源码结构

- `src/api/client.ts` 是同源 HTTP 边界，并保留经过明确识别的 402 业务体。
- `src/api/runtime.ts` 与 `src/api/useSessionStream.ts` 管理发送、SSE 和使用幂等。
- `src/api/billing.ts` 提供钱包、套餐、创建充值和内部订单轮询。
- `src/components/RechargeDialog.tsx` 只渲染后端允许的 H5 跳转或聚合二维码支付动作。

## 验证

```sh
pnpm -F @cb/shared build
pnpm -F @cb/runtime-web typecheck
pnpm -F @cb/runtime-web typecheck:test
pnpm -F @cb/runtime-web test
```

前端测试使用 fake API，不连接乐收赢，也不保存或输出完整收银台地址、回调、签名或机构密钥。
