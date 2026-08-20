<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-004: Snapshot path normalization and case collision

- Status: accepted
- Owner: Snapshot/Version
- Decision date: 2026-08-13

## Decision

Wire path 必须是 UTF-8 NFC、相对路径、正斜杠、按 UTF-8 bytes 严格排序；NFC 后逐路径做 Unicode lowercase collision key，任何重复或 collision 整包拒绝，不做自动改名。禁止项按 lowercase 检查，包括 .git、.gitmodules、.env\*、.ssh、.codex、.aws、node_modules、特殊路径和全部 C0/C1。

## Alternatives considered

- 保留 NFD 或区分大小写冲突；拒绝，因为 macOS/Linux 恢复语义不一致。
- 自动重命名冲突项；拒绝，因为会改变 Creator 确认的 Context。

## Evidence

- SnapshotPathSchema case-fold/control tests
- project-hostile-paths design fixture

## Privacy and security impact

防 traversal、跨平台覆盖和危险配置目录泄漏；发布与解包必须复用同一 authoritative schema。

## Reversal triggers

- 采用 Unicode full case-fold 新版本并完成跨文件系统迁移/golden 审查。

## Affected protocol versions

- combo.snapshot-manifest/1
