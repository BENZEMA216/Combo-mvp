<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-003: Archive compression ratio and byte limits

- Status: accepted
- Owner: Snapshot/Version
- Decision date: 2026-08-13

## Decision

Snapshot 同时执行 compressedBytes<=50MiB、expandedBytes<=200MiB、单文件<=10MiB、fileCount<=2000 和 expanded/compressed<=100。任何一项超限即在 VERIFIED 前拒绝；compressedBytes 必须大于 0，阈值按整数 bytes 比较，边界值允许，+1 拒绝。

## Alternatives considered

- 只限制 expanded bytes；拒绝，因为异常压缩比仍会消耗 CPU/内存。
- 自适应或按 Creator 配额放宽；拒绝，因为 Alpha 需要统一可测试边界。

## Evidence

- SnapshotManifest/1 constants and isCompressionRatioAllowed tests
- creator-hosted-agent-vnext-test-plan.md §8.2 and §8.3

## Privacy and security impact

限制 zstd/tar bomb、资源 DoS 与 verifier tmpfs 膨胀；错误只返回稳定代码。

## Reversal triggers

- 真实 Alpha 数据显示合法项目持续超限，并完成容量、DoS 与成本复审。

## Affected protocol versions

- combo.snapshot-manifest/1
