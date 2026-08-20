<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-017: Twenty four hour soak leak budget

- Status: accepted
- Owner: Security/SRE
- Decision date: 2026-08-13

## Decision

Alpha RC 用同一 release tuple 和 max-alpha-load 连续运行 24 小时；前 30 分钟 warmup 不计 slope，每 10 秒采样，采样空洞>60秒 BLOCKED。warmup 后 Worker RSS 净增<=64MiB且线性 slope<=1MiB/hour，FD 净增<=8，tmp/outbox disk 净增<=64MiB；orphan Sandbox/scratch 数须在5分钟归零。重复 final、第二 provider attempt、false-online、跨租户泄漏必须为0；核心 p95 相对上个接受 RC 回退>20%即 BLOCKED。Evidence taxonomy 中 E7 专指同 release tuple 的 24h soak，E8 专指 off-machine PG/MinIO/KEK DR；两者都可在冻结的 T7-DR 实验环境执行，但不得以 E7 soak 替代 E8 异机恢复。

## Alternatives considered

- 只跑 8 小时冒充 Alpha soak；拒绝，DoD 明确要求 24 小时。
- 只看最终 RSS；拒绝，隐藏中途峰值、重启和样本空洞。

## Evidence

- creator-hosted-agent-vnext-test-plan.md §21, §25 and §31
- max-alpha-load fixture definition

## Privacy and security impact

资源泄漏会触发保护模式而非通过自动重启掩盖；测试不得含真实用户数据。

## Reversal triggers

- 硬件规格或 Alpha load envelope 改变；新基线必须与旧 tuple 并行测量。

## Affected protocol versions

- combo.vnext-evidence-bundle/1
