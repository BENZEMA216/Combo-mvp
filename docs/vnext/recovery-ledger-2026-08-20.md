# Creator-hosted Agent VNext 接管与恢复账本

> 状态：工程取证与恢复计划；不是架构真源、发布证据或 Gate PASS 记录。
> 快照：`codex/creator-hosted-agent-vnext@7cae535c4b18cbe57364d0ba724ad513bf53ca06`。
> 可信集成基线：`origin/main@d15a985`。最终 PR 必须从该基线重建可评审提交栈。

## 接管结论

`7cae535` 包含大量可复用协议、持久化和测试资产，但当前不是可直接合并或发布的产品分支：

- 相对 `origin/main` 共 86 个本地提交，涉及 462 个文件，净变化约 `+215316/-104`；远端没有对应 PR 或完整 CI/独立评审。
- 架构镜像仍是 `Proposed Architecture`；缺失的真实产品接线和物理 Gate 证据不能由本地单元/vertical 测试替代。
- Creator Worker、Broker Client、Gateway Invocation、Runtime send/transcript 与 Consumer 闭环尚未接通。
- 当前实现有 22 个新增 TS/SQL 文件超过 1200 行，且有大型生成 fixture；在安全评审和长期维护前必须拆分责任边界。

因此保留 `7cae535` 作为取证快照和 donor，使用 `codex/vnext-recovery` 做清理与验证；对外集成时按 tranche 从 `origin/main` 选择性重建，不把 86 个提交整批推送。

## 来源边界

| 范围                             | 来源                                                      | 处理原则                                                     |
| -------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `5eada50..961dadf`（74 commits） | 旧 Codex 主任务与并行 worktree 汇总                       | 逐模块保留、重验、拆分评审                                   |
| `14be972`                        | DeepSeek Harness 接管 checkpoint；一次提交 193 个继承文件 | 不视为 DSH 原创；按协议/DB/Gateway/Worker/测试/workflow 重建 |
| `d1118df..7cae535`（11 commits） | DSH 接管后的实际增量，43 文件，约 `+5435/-769`            | cancelled authority 可复核保留；物理 Gate 骨架重写           |

Git author 不能区分来源：86 个提交都使用同一作者身份。以上边界来自 checkpoint 正文、reflog 与会话记录，而不是 author 字段。

## 当前证明边界

已证明：

- 基线 `7cae535` 可完成 install、build、lint、source/test typecheck 与本地包测试；部分 PostgreSQL/物理环境测试会按声明跳过。
- 恢复提交 `ac01b5f` 清除了文本源码中的真实 NUL 字节，并恢复 Prettier 基线。
- 恢复提交 `48bd00d` 让 E4-E7/T1 未实现 runner 全部 fail-closed；`PRECHECK_READY` 仍以 exit 2 返回 `NOT_RUN`。
- FLT-001..020 的 `kill/expected` 已逐行绑定冻结测试方案 §12.2；CI 会扫描 Gate ShellCheck 和 tracked 文本 NUL。
- `pnpm test:local` 在上述恢复提交上以 exit 0 完成；SQLite durable transport 单文件耗时约 192 秒。环境门控的 PostgreSQL 测试保持 skipped，不计入真实 PG 通过。

未证明：

- 真实 Creator Worker 能从 Cloud 收 command、调用真实 generation-bound Codex Host、提交唯一终态并获得 Cloud ACK。
- Gateway 能发布 `invocation.prepare/start/cancel` 并投影 prepared/started/succeeded/failed/cancelled。
- Runtime 的 send、transcript、SSE、cancel、retry 产品路径可用。
- Apple Container/Lima 隔离、Secure Enclave/Keychain、真实模型、NAT/第二网络、24h soak 或异机 DR。
- 任何 E4-E8/T1 Gate PASS、Test Alpha 完成、生产就绪或正式发布。

## 阻断项

### P0 — 产品闭环

1. `apps/creator-worker` 没有构造 Broker Client、文件 SQLite、command/fact/ACK pump 或恢复循环。
2. Host composition 丢失真实 `HostThread.generation` 和 `TurnHandle.result`，Fake Host vertical 掩盖真实首个 dispatch 的 `HOST_SESSION_LOST` 风险。
3. Gateway runtime 只启用 conversation open/ready；Invocation projector、Cloud Journal、assistant sealer、challenge API pool 未注入，publisher 只认 `conversation.open`。
4. Runtime 只有默认关闭的 create route；send/transcript/SSE/cancel/retry 尚未形成产品 API。

### P0 — 证据与发布

1. 架构待评审，历史分支没有 PR、远端 CI 或独立 reviewer sign-off。
2. E4-E8/T1 没有真实 runner 和完整 Evidence Bundle producer；只能保持 `NOT_RUN/BLOCKED`。
3. T0 Evidence 对部分执行的 SCH-010 仍可能给出完整 case 集语义；必须改成逐 test-file coverage 或拆分 T0/T1 case。

### P1 — 可维护性与安全边界

1. SQLite transport/journal、Cloud journal 和 Gateway PG authority 已形成数千行单体，需要按 storage、migration、integrity、operations、recovery 拆分。
2. dispatch receipt 未绑定完整 Invocation authority；Host registry 的覆盖、abort、终态注销和 generation clear 语义不完整。
3. Device signer、Cloud challenge、真实 sandbox supervisor/attestation 没有生产实现；当前本地 Host 仍可能读取真实机器凭据。
4. 大型生成 fixture 应与手写代码分提交，记录生成器、输入、digest 和 reviewer；评估从发布包排除 closure ledger。

## 恢复 tranche

1. **R0 仓库可信基线**：format/diff/NUL、Gate fail-closed、CI 入口、状态文档和精确 golden table。
2. **R1 Host contract**：保留完整 generation-bound thread/turn，接 result/failure/recovery，修 receipt authority 和 registry 生命周期；先跑真实 Codex app-server contract。
3. **R2 Worker composition root**：单一生产入口构造 Broker/SQLite/Journal/Host/Signer/Challenge/Isolation，并实现 command/fact/ACK/recovery loop。
4. **R3 Cloud Invocation**：Gateway typed publisher/projector/CloudJournal/sealer/challenge 与 Runtime send/transcript/SSE/cancel/retry。
5. **R4 Evidence correctness**：SCH-010 粒度、case-to-assertion/JUnit 绑定、物理 Gate runner/packager、E7 24h 与 E8 off-machine DR 分离。
6. **R5 可维护性**：拆巨型模块、压缩生成物审查面、补安全与性能预算。
7. **R6 集成与发布**：从 `origin/main` 重建小提交栈，逐 tranche 本地门禁、Draft PR、独立 review、远端 CI；获得显式授权后才部署 Test 并执行真实 E2E。

每个 tranche 必须同时满足：工作树 clean、format/lint/typecheck/test/diff-check 通过、没有新增 skip/假证据、README/registry 同步、提交范围可独立复核。部署、push、PR、merge 与服务器 Secret 不属于本账本的隐含授权。
