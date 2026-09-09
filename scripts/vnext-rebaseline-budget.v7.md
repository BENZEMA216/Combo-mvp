# 轻量 Agent 页面精确范围扩展

`vnext-rebaseline-budget.v7.json` 是当前活动合同，替代 v6 的活动范围，不创建新的预算阶段。
它仍使用 `lightweight-agent-transfer-loop` 和基准 `39e5b1b5c281c864a62974a15b51b6d0572cf6d0`，
每个 PR 最多 30 个文件、5,000 行增删、单文件 1,200 行增删，累计最多 15,000 行增删。
本次治理改动和后续产品改动都继续从这个原基准计数，治理和产品仍不能混在同一个 PR 中。

## 不可变历史

v1 至 v6 JSON 合同保持原字节；v6 的历史说明保留原样。验证器继续执行原 v6 parser、v5 收据、v1 至 v4
历史校验和规范 Main 第一父链证明。`legacyV6` 额外锁定 v6 合同 SHA-256
`2ba62ced5559bd73417eae141b03d3a376bdf8843359ec26ad9fe5292699b0fc`，并与已合入 Main 的
`78792c0d3a006239d0628dc51c0371086f265853` 中的实际文件比较；该 SHA 只是范围版本的历史证明，不是新的预算基准。
v6 原始范围、维护分类和累计策略仍可按归档合同独立验证，v7 不能反向扩张归档范围。

## 精确准入

为已确认的 Agent 页面设计增加以下 15 个精确路径；v6 已有路径不重复加入，没有增加任何目录前缀：

- `apps/web/src/App.landing.test.tsx`
- `apps/web/src/components/AgentIcon.tsx`
- `apps/web/src/components/CopyButton.tsx`
- `apps/web/src/components/CopyInstruction.test.tsx`
- `apps/web/src/components/CopyInstruction.tsx`
- `apps/web/src/components/copyInstruction.css`
- `apps/web/src/pages/LoginPage.test.tsx`
- `apps/web/src/pages/LoginPage.tsx`
- `apps/web/src/pages/agents/AgentPackageReview.tsx`
- `apps/web/src/pages/agents/AgentTransferState.ts`
- `apps/web/src/pages/landing/LandingPage.test.tsx`
- `apps/web/src/pages/landing/LandingPage.tsx`
- `apps/web/src/pages/landing/landing.css`
- `apps/web/src/shell/PublicLayout.test.tsx`
- `apps/web/src/shell/PublicLayout.tsx`

只有 v7 将 `LoginPage.test.tsx` 从独立维护范围迁入产品范围，并将 `maintenanceFile` 明确设为 `null`。
归档 v5/v6 的维护路径、独立维护贡献限制及固定基准和四个精确路径的一次性 bootstrap 校验不变；
v7 不接受旧 bootstrap 作为治理与产品混改的例外。

范围准入不等于页面已经实现、真实 Plugin 或跨用户验收通过，也不修改 `PROJECT.md`、兼容约束、权限与验收规则，
不授权产品 PR 合并、发布或部署。
