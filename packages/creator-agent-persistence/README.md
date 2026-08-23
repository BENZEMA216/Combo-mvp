# @cb/creator-agent-persistence

本包是本地、尚未发布的 Creator Agent Catalog。它用独立 Node 24 SQLite 保存用户已经看见的
`combo.creator-agent-draft-handoff/1`、按 revision 修订的不可执行 DraftSnapshot，以及经逐字确认冻结的
immutable AgentVersion。它不复用 Worker Journal/Transport，也不读取 Codex task/session、日志或隐藏 Host
状态。

## 持久语义

- `createFreshCreatorAgentCatalog()` 只创建全新 0600 数据库；`openExistingCreatorAgentCatalog()` 只打开精确
  application ID、schema/catalog digest 和 catalog identity 均匹配的旧库。
- 导入只接受 protocol parser 验证后的 exact canonical UTF-8 JSON。同一 handoff exact replay 返回原 Draft；
  相同 Draft identity 配不同内容、revision gap 或 base Version 漂移都会 fail-closed。
- `createFreezeReview()` 返回完整 Draft 与 Catalog 签发的逐字确认文本。`freezeDraft()` 不 trim、不接受
  `yes`/`force`；同一 Draft 成功重试只返回原 Version。
- Draft revision、Version number、base Version 与 source Draft 构成一条可重开的因果链；open 时逐行重算
  protocol fingerprint 并做跨行校验。
- Catalog 保存经过人工审阅的 Definition/Draft/Version 内容，但不保存运行 prompt、回答、本机 Project
  绝对路径、task/thread/session ID 或 Host wrapper。`rawStored=false` 只是合同声明，不是自动脱敏证明。

Catalog fingerprint 只用于一致性，不是签名、身份认证或公开发布授权。当前没有 Conversation、Cloud
Catalog、Capability 或 `combo.codex-agent-share/1` 投影。

## 验证

```bash
pnpm -F @cb/creator-agent-persistence build
pnpm -F @cb/creator-agent-persistence typecheck:test
pnpm -F @cb/creator-agent-persistence test
```
