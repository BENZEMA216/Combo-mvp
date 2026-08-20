<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-034: Public protocol resource limits require an exact closure ledger

- Status: accepted
- Owner: Protocol/Security
- Decision date: 2026-08-18

## Decision

所有进入 ContractSchemaDefinitions、Broker contract、OpenAPI 或公开 raw parser 的长度、计数、properties、数值资源和 bytes cap 必须登记在 digest-bound public-boundary closure ledger；source AST、实际Zod row、全部生成artifact physical constraint与ledger row必须exact闭合，unknown、unclassified、implementation remaining和unreachable均为零后，SCH-004方可标记implemented。每个row必须绑定authority、实际runtime root/parser或已执行N-1/N/N+1的精确委托测试，fragment AJV只能证明advertised keyword，不能替代root refine、raw bytes、签名、transport或storage。当前repository closure满足implementation条件；正式T0 Linux仍以NOT_RUN单列，未绑定clean source SHA和workflow run前不得写Gate PASS。既有ADR-VNEXT-003/006/010/011的Snapshot、Conversation与Capability语义不变；本ADR额外冻结AgentVersion developerInstructions<=32，Evidence cloudImageDigests/runtimeVersions各<=64 properties，Broker frame<=65536 bytes，Evidence structured JSON<=1048576 bytes，Snapshot mediaType<=128 bytes、可达canonical manifest语义maximum=2536575 bytes、encrypted/raw defense maximum=4194304 bytes，Broker registration artifact/digest/mode counts<=8/8/2，Execution Capability input/output/cost预算<=200000/32768/100000000，Consumer transcript messages<=40、outbox attemptCount<=1000000，以及Evidence/Registry当前公开array/numeric limits。Registry YAML public alias expansion maximum为1000；yaml library使用strict threshold，因此内部maxAliasCount=1001仅是适配细节，不能冒充产品上限。Snapshot preparation marker使用由全字段合法最大值经RFC 8785 JCS得到的可达2992-byte maximum，2991/2992接受、2993在JSON parse前拒绝；commit marker所有字段均固定宽度或exact-derived，合法canonical bytes固定为456，455/457按exact length拒绝，不伪造padding、unknown key或whitespace。所有record property cap必须同时进入runtime与公开JSON Schema maxProperties。

## Alternatives considered

- 只维护若干 boundary fixture；拒绝，因为 fixture 存在不能证明没有第十五类遗漏 owner。
- 只扫描生成 JSON Schema 或只用 fragment AJV；拒绝，因为 Zod refine、raw-byte cap、签名与跨字段语义不可见。
- publication preparation/commit 共用任意16KiB cap；拒绝，因为该值不是可达 exact boundary，commit也不是 variable maximum。
- Evidence map 保持无界；拒绝，因为攻击者可在单个合法对象内制造不受控 properties 和 canonicalization 成本。

## Evidence

- public-boundary-closure.v1.json implemented zero-remaining source/artifact/manual-cap ledger
- public-boundary-row-probes.test.ts and public-string-pattern-census.test.ts actual per-row runtime probes
- public-source-ast-census.test.ts physical source census and exact owner reconciliation
- publication-marker-byte-boundaries.test.ts real canonical parser probes
- manifest-canonical-byte-maximum.test.ts reachable semantic and encrypted raw-defense probes
- Evidence cloudImageDigests and runtimeVersions maxProperties runtime and contract probes
- creator-hosted-agent-vnext-test-plan.md §6.1 SCH-004

## Privacy and security impact

fail-closed census阻止新增或漂移的公开资源上限绕过G0；bounded maps/raw bytes降低解析、canonicalization和内存DoS；实际root/parser验证避免局部Schema绿色却在运行路径失效。Ledger不证明SNP-008真实50MiB archive、TLS/WSS、对象存储、数据库或Production。

## Reversal triggers

- 任一上限调整必须新增协议/迁移与成本、DoS、兼容证据，并重新生成全量closure ledger。
- public root、Schema generator或raw ingress机制变化时，必须先使source/artifact/ledger exact set重新归零。

## Affected protocol versions

- combo.agent-version-manifest/1
- combo.creator-agent-http/1
- combo.creator-broker/1
- combo.vnext-evidence-bundle/1
- combo.snapshot-publication-preparation/1
- combo.snapshot-publication-commit/1
