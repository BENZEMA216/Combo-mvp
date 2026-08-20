# scripts/gates — VNext 物理 Gate 前置检查骨架

状态矩阵（2026-08-20，全部 **NOT_RUN**；本目录只做前置检查和计划展示，不改变任何 Gate 状态）：

| 脚本                   | Gate                            | 状态    | 阻塞                                                             |
| ---------------------- | ------------------------------- | ------- | ---------------------------------------------------------------- |
| e4-real-runtime.sh     | E4 Real Runtime                 | NOT_RUN | 尚无真实 Codex/model turn runner 与完整 Evidence Bundle          |
| e5-isolation-canary.sh | E5 Real Isolation               | NOT_RUN | 尚无 Apple container/limactl VM runner 与 canary Evidence Bundle |
| e6-cloud-e2e.sh        | E6 Real Cloud E2E               | NOT_RUN | 无 Test 云部署/第二网络设备；无部署授权                          |
| e7-soak-dr.sh          | E7 Soak；legacy DR/UAT 计划输出 | NOT_RUN | E7 需同 release tuple 的 24h 窗口；DR 属于 E8，不能由 E7 替代    |
| t1-fault-injection.sh  | T1 INV-010/016                  | NOT_RUN | 尚无 20 个远端 failpoint runner 与逐项 Evidence Bundle           |

约定：

- 所有脚本 fail-closed：前置缺失或真实 runner 未实现时均以 exit 2 打印 `NOT_RUN`；绝不伪造通过。
- `PRECHECK_READY` 只表示已检查的前置满足，仍然以 exit 2 结束，不等于 Gate `PASS`。
- E6 不得创建空 evidence 目录；物理 Gate 只有在真实断言执行且完整 Evidence Bundle 验证成功后才可 exit 0。
- 执行任何部署/真机操作前必须获得用户显式授权（VNX_E6_DEPLOY_AUTHORIZED=true）。
- 当前权威要求见 `docs/vnext/creator-hosted-agent-vnext-test-plan.md` 与机器 registry；缺少独立 runner/runbook 本身就是阻塞项。
