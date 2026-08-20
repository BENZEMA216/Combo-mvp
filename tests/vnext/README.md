# VNext 验收注册表

这个目录保存 Creator-hosted Agent VNext 的机器可读验收真源。设计文档解释为什么测试；这里的 YAML 明确列出每条不变量、每个测试 ID、要求的环境、证据等级、实现状态和发布 Gate。

- `invariants.yaml` 固定 25 条系统不变量、严重度、Owner 和关联 Gate。
- `decisions.yaml` 是 34 份 ADR 的机器真源；保留 `ADR-VNEXT-001..020`，由 `ADR-VNEXT-021..032` 以必填 `architectureDecisionId` 和逐字 `architectureDecisionSummary` 一一映射冻结技术方案 §25 的 `D001..D012`，并以 `ADR-VNEXT-033/034` 冻结 Client Idempotency UUIDv4 与 public resource-limit closure 决策。`docs/vnext/adr/` 由它生成并逐字校验。
- `data-flow-allowlist.yaml` 逐个固定 Prompt、Answer、Context 的具体 system/container/field、内容类型、AEAD/AAD、key owner、Retention 与删除语义；列表之外一律是 `SECURITY_LEAK`。控制 ID 不属于正文 allowlist，凭据、绝对路径和隐藏推理被全局禁止进入这些数据面。
- `registries.yaml` 将 `combo.creator-broker/1` 绑定到独立 `broker-contract.v1.json` 的 RFC 8785 JCS SHA-256；生成器、registry test 与 G0 同时校验路径和 digest，禁止握手自行声明另一份合同。
- Evidence level `E7` 专指 24 小时 soak，`E8` 专指 off-machine PG/MinIO/KEK DR；冻结环境名仍为 `T7-DR`，但两类证据不可相互替代。
- `cases/` 将测试方案中出现的 66 个显式测试 ID 逐项实例化；`implemented` 表示仓库已有可执行测试，`planned` 不能被发布 Gate 计为通过。

`pnpm vnext:test:fast` 会检查生成的 Schema/OpenAPI/ADR、解析全部 YAML，并双向核对测试方案中的 ID 与注册表中的 ID。缺字段、重复 ID、未知不变量、没有实现文件或 fixture digest 漂移都会失败。当前 66 条中 `17 implemented / 49 planned`，G0 的 `SCH-001..010` 均已有绑定测试；G1 的 `SNP-008` 已绑定真实 canonical 50 MiB ±1 builder/verifier，`AVR-001..006` 已绑定递归 key order、display metadata、whitespace、Snapshot/Behavior/Codex/Schema/Model/Effort 的 exact digest corpus。`AVR-007..009` 仍保持 planned；`implemented` 只表示仓库已有可执行实现，不等于当前 release PASS。正式 Linux、SHA-bound G1 evidence 缺失仍必须报告 `BLOCKED/NOT_RUN`，不能因为注册表存在或本机测试通过就写成 `PASS`。

正式 T0 repository mechanism 使用 `.github/workflows/vnext-t0.yml`：PR checks 与 Release build 调用同一只读 reusable job，在 `ubuntu-24.04` 上执行 format、lint、source/test typecheck 和唯一 `pnpm vnext:test:g0`。该命令覆盖全部 SCH 登记的 T0 文件及自身 workflow/evidence 防漂移契约；需要真实 PostgreSQL 的两项 SCH-010 supporting test继续由 T1 job执行。property matrix 固定为 base seed `12648430`、100 个唯一 seed、每个 model合计100,000 runs。PR merge SHA与分支 build artifact永远是 `ADVISORY_ONLY`；只有 GitHub 标记为protected的 main push、测试前后clean tested SHA、成功 GitHub job、五份 JUnit、canonical evidence、上传后重新下载验证和GitHub artifact digest同时匹配，才能在外部记录 `FORMAL PASS`。该artifact尚未进入release manifest，不能单独证明RC/release；源码 registry与closure仍保留 `NOT_RUN`，不会把尚未发生的远端 run静态写成通过。
