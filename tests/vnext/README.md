# VNext 验收注册表

这个目录保存 Creator-hosted Agent VNext 的机器可读验收真源。设计文档解释为什么测试；这里的 YAML 明确列出每条不变量、每个测试 ID、要求的环境、证据等级、实现状态和发布 Gate。

- `invariants.yaml` 固定 25 条系统不变量、严重度、Owner 和关联 Gate。
- `decisions.yaml` 是 32 份 ADR 的机器真源；保留 `ADR-VNEXT-001..020`，并由 `ADR-VNEXT-021..032` 以必填 `architectureDecisionId` 和逐字 `architectureDecisionSummary` 一一映射冻结技术方案 §25 的 `D001..D012`。`docs/vnext/adr/` 由它生成并逐字校验。
- `data-flow-allowlist.yaml` 逐个固定 Prompt、Answer、Context 的具体 system/container/field、内容类型、AEAD/AAD、key owner、Retention 与删除语义；列表之外一律是 `SECURITY_LEAK`。控制 ID 不属于正文 allowlist，凭据、绝对路径和隐藏推理被全局禁止进入这些数据面。
- `registries.yaml` 将 `combo.creator-broker/1` 绑定到独立 `broker-contract.v1.json` 的 RFC 8785 JCS SHA-256；生成器、registry test 与 G0 同时校验路径和 digest，禁止握手自行声明另一份合同。
- Evidence level `E7` 专指 24 小时 soak，`E8` 专指 off-machine PG/MinIO/KEK DR；冻结环境名仍为 `T7-DR`，但两类证据不可相互替代。
- `cases/` 将测试方案中出现的 66 个显式测试 ID 逐项实例化；`implemented` 表示仓库已有可执行测试，`planned` 不能被发布 Gate 计为通过。

`pnpm vnext:test:fast` 会检查生成的 Schema/OpenAPI/ADR、解析全部 YAML，并双向核对测试方案中的 ID 与注册表中的 ID。缺字段、重复 ID、未知不变量、没有实现文件或 fixture digest 漂移都会失败。当前只有被真实 G0 test file 标记并执行的 case 是 `implemented`；其余 59 条保持 `planned`，在对应 Track 给出所需真实证据前不得计为 PASS。真实环境缺失仍必须报告 `BLOCKED`，不能因为注册表存在就写成 `PASS`。
