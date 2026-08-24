# @cb/creator-agent-persistence

本包是本地、尚未发布的 Creator Agent Catalog。它用独立 Node 24 SQLite 保存 V1、V2 或 V3 Draft
handoff、按 revision 修订的不可执行 DraftSnapshot，以及 immutable AgentVersion。V1
继续兼容 `combo.creator-agent-draft-handoff/1`；Project Context Compiler 产出的 V2 使用
`combo.creator-agent-draft-handoff/2`，behavior-only V3 使用 `/3`，并在 Draft 内持久化 compact Project source ledger。本包不复用 Worker
Journal/Transport，也不负责扫描 Project、调用模型或读取 Codex task/session、日志和隐藏 Host 状态。

## 持久语义

- `createFreshCreatorAgentCatalog()` 只创建全新 0600 数据库；`openExistingCreatorAgentCatalog()` 只打开精确
  application ID、schema/catalog digest 和 catalog identity 均匹配的旧库。
- 导入只接受 protocol parser 验证后的 exact canonical UTF-8 JSON，并按明确 protocol 分派 V1、V2 或 V3。同一
  handoff exact replay 返回原 Draft；相同 Draft identity 配不同内容、revision gap 或 base Version 漂移都会
  fail-closed。三代对象沿用现有 JSON row 与 SQLite schema，可以在同一个 Catalog 中冻结并重开，不需要
  schema migration。
- `createFreezeReview()` 返回完整 Draft 与 Catalog 签发的逐字确认文本。`freezeDraft()` 不 trim、不接受
  `yes`/`force`；同一 Draft 成功重试只返回原 Version。
- `freezeDraftForLocalExperience()` 只接受 exact Draft fingerprint 和固定
  `LOCAL_UNPUBLISHED_AUTO_FREEZE_V1` 授权，并与人工确认走同一个原子冻结事务；它不会伪造“已经逐字检查”的
  review 文本，也不能表示 public share 或发布授权。
- Draft revision、Version number、base Version 与 source Draft 构成一条可重开的因果链；open 时逐行重算
  protocol fingerprint 并做跨行校验。
- Catalog 保存 Definition、Draft、handoff wrapper 与 Version 内容；Version 可能来自严格人工审阅，也可能
  来自明确的本地体验自动冻结。V2/V3 Draft 中只包含
  compact source ledger 的扫描 profile、Project root digest、coverage counts 和被引用 source 的路径、digest
  与执行可用性；Catalog 不另存 full Project inventory 或 Project 文件附件，但 Draft 自由文本仍可能含
  Project 摘录。Catalog 不保存运行 prompt、回答、本机 Project 绝对路径、task/thread/session ID 或 Host
  wrapper。`rawStored=false` 只是合同声明，不是自动脱敏或模型服务保密证明。

Catalog fingerprint 只用于一致性，不是签名、身份认证或公开发布授权。当前没有 Conversation、Cloud
Catalog、Capability 或 `combo.codex-agent-share/1` 投影。

## 验证

```bash
pnpm -F @cb/creator-agent-persistence build
pnpm -F @cb/creator-agent-persistence typecheck:test
pnpm -F @cb/creator-agent-persistence test
```
