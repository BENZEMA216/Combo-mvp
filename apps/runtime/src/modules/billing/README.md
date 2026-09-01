# modules/billing 使用计费

这个目录管理共享 Agent 的免费额度、全局钱包预留和按次结算。乐收赢只负责向钱包充值，不参与每轮 Agent 调用。

## 文件

- `service.ts` 计算请求指纹，按用户与 Capability 判断 owner 免计费、免费额度或钱包来源，并提供成功结算和失败释放。active recovery 重试只使用数据库冻结的 policy、validator、价格和免费额度快照，强制从钱包按冻结价格预留，不会因后来释放出的免费名额重新进入免费分配。
- `repo.ts` 封装账户、免费额度、用量记录和不可变钱包流水的 SQL。所有方法接收调用方事务，开轮预留与 Turn 创建、终态结算与 Turn 收尾因此可以共同提交。
- `pending-recovery.ts` 在 402 前冻结知识请求、Session、exact Package、策略和价格快照；同一 owner/usage advisory lock 后才锁恢复行。到账后的原 `usageId` admission 保留 active 行，回答或失败的 receipt 终态事务再清除请求正文并转为 accepted/abandoned。未 admission 的用户取消、Session 关闭和过期 sweep 只允许 abandoned 清文。
- `pending-recovery-handlers.ts` 与 `pending-recovery-routes.ts` 提供 owner-scoped list、exact read 和取消端点。响应只返回恢复任务所需的 request、binding、价格、当前充值 intent 和过期时间，不返回 owner、receipt 或支付网关字段；写端点沿用可信 Origin 与 Cookie 鉴权。

每个发送请求使用用户生成的 `usageId`。Turn 编排入口要求调用方同时提供该标识和 Capability 的数据库 owner，不会按运行轮次或 Session owner 猜测计费身份。共享请求边界将 UUID 规范化为小写，数据库 advisory lock 也先按 `uuid::text` 规范化，因此大小写变体不能绕过跨 Session 幂等栅栏。相同用户与 `usageId` 只有请求指纹完全一致时才返回原 Turn；不同请求会被拒绝。免费次数只在 Turn 成功时从预留转为已使用，钱包也只在成功时把预留转成资金流水；失败、中断和超时清扫都会释放预留。

知识 Agent 指纹还绑定 Session 冻结的 Release、Package、知识资源和 validator policy。只有平台验证为 `answered` 才完成免费额度或钱包结算；证据不足、验证失败、中断都写零结算 receipt 并释放预留。通用 reconciler 仅处理 legacy charge，不会从知识 Turn 状态猜测是否收费。

余额不足不会创建 Turn、Message、usage charge 或调用模型。相同 `usageId` 的重试必须与服务端恢复行完全一致；同一 Session 用另一 `usageId` 再次撞到 402 时返回既有 active recovery，不覆盖原请求。终态锁序固定为 Session → owner/usage advisory → pending recovery → Turn → usage charge。
