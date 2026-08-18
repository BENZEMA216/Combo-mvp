# scripts/gates — VNext 物理 Gate 机制骨架

状态矩阵（2026-08-18，全部 **NOT_RUN**；本目录只做机制准备，不改变任何 Gate 状态）：

| 脚本 | Gate | 状态 | 阻塞 |
| --- | --- | --- | --- |
| e4-real-runtime.sh | E4 Real Runtime | NOT_RUN | 真实 Codex 会话/模型额度授权；Codex Desktop 需重新登录 |
| e5-isolation-canary.sh | E5 Real Isolation | NOT_RUN | Apple container/lima 缺失；canary 二进制未随镜像构建 |
| e6-cloud-e2e.sh | E6 Real Cloud E2E | NOT_RUN | 无 Test 云部署/第二网络设备；无部署授权 |
| e7-soak-dr.sh | E7 Soak/DR/UAT | NOT_RUN | 依赖 E6；需 24h 窗口与 DR 演练 |

约定：
- 所有脚本 fail-closed：前置缺失时非零退出（exit 2）并打印 NOT_RUN 原因；绝不伪造通过。
- 可本地真实执行的部分（preflight 检查）会真实运行；真机步骤一律留钩子。
- 执行任何部署/真机操作前必须获得用户显式授权（VNX_E6_DEPLOY_AUTHORIZED=true）。
- 详细步骤见 docs/测试/vnext-physical-gates-runbook-20260818.md。

