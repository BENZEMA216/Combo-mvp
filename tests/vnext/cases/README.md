# VNext 测试用例

每个 YAML 文件都是 `combo.vnext-test-registry/1`。每条用例必须包含环境、证据等级、不变量、fixture、步骤、断言、证据、执行频率、Owner、独立 Reviewer、Gate、实现状态、release tuple 和 fixture digest。

用例可以在后续 Track 中从 `planned` 变为 `implemented`，但不得删除原 ID 或把更低证据等级改名冒充更高等级。新增设计文档 ID 时必须在同一个改动中新增注册项和可执行实现，或明确保持 Gate 为 `BLOCKED`。
