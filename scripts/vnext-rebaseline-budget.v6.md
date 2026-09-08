# 轻量 Agent 产品阶段预算

`vnext-rebaseline-budget.v6.json` 是当前增量合同。新阶段从已合并到规范仓库 `dangdang-tech/Combo`
的 `main` 提交 `39e5b1b5c281c864a62974a15b51b6d0572cf6d0` 开始；该提交是 compiler PR #344
的真实合并结果，不是功能分支顶端、未合并候选或产品验收结论。

## 固定历史

v1 至 v5 合同文件保持原字节。v6 的 `legacyV5` 收据锁定 v5 文件 SHA-256、旧基准
`9997aedceeba5ff68cf50b6bc52a85e952121f15`、新阶段基准，以及两者之间的完整 Git 差异。
旧阶段包含 147 个文件、14,060 行增删，单文件最大增删 571 行。原始差异使用以下固定参数：

```sh
git diff --raw -z --full-index --no-renames --abbrev=40 \
  9997aedceeba5ff68cf50b6bc52a85e952121f15 39e5b1b5c281c864a62974a15b51b6d0572cf6d0
```

每次检查都会重新读取锁定提交中的 v5 文件，核对现存归档字节及其摘要，重新统计完整差异并校验原始差异摘要，
继续按 v5 范围与累计上限检查旧阶段，同时保留既有 v1 至 v4 历史验证。收据不能代替这些检查。

## 新阶段

新旧阶段均保留每个 PR 最多 30 个文件、5,000 行增删、单文件 1,200 行增删，以及累计 15,000 行增删的上限。
新阶段自身的治理改动也从该阶段基准计入累计预算。治理与产品改动不能混在一个 PR 中。

v6 保留 v5 全部范围，仅增加合同列出的 15 个精确文件：3 个 Authoring transfer 测试文件、Agent Draft 的
`apps/authoring/src/modules/agent-draft/index.ts` 正式模块导出面，以及 11 个 Web 路由、接口、页面、样式及
测试文件。业务域通过正式导出面复用 Draft 服务，不放宽跨域深层导入规则；没有增加路径前缀。
PostgreSQL 和 Worker SQLite 的历史兼容约束不变。

验证器要求新阶段基准同时是比较基准与 HEAD 的祖先，且位于规范 Main 的第一父链中。GitHub PR 使用已验证的
双亲合并提交和 `BASE_SHA`，只接受规范仓库的 Main 目标；Main push 使用 exact `SOURCE_SHA` 和第一父提交。
本地及其他 CI 来源使用 canonical origin 的 `origin/main` 第一父链。缺失完整历史、错误仓库、非 Main 基准、
侧分支祖先、修改收据或改变归档字节都失败关闭。

这份合同不表示真实 Plugin、跨用户运行或普通用户验收通过，也不授权发布或部署。
