<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-031: Alpha 仅 text-in/text-out、无外部 Action

- Status: accepted
- Owner: Product/Web
- Decision date: 2026-08-13
- Architecture decision: D011 — Alpha 仅 text-in/text-out、无外部 Action

## Decision

Alpha IOContract 只允许 UTF-8 text input/output，files=false、actions=false、rawReasoning=false；RuntimePolicy 禁用 external tools、Project execution、任意网络和 Host credentials。Guest 仅有闭世界 read_context/list_context/search_context，只读 Snapshot 且不执行 Project bytes。

## Alternatives considered

- 支持文件、多模态、外部写操作或第三方工具；后置，因为这些能力明确不在 Alpha 范围且需要新的权限与安全协议。
- 提供通用 shell、解释器或任意 exec；拒绝，因为 Project bytes 必须 noexec 且安全不能依赖 Prompt。

## Evidence

- creator-hosted-agent-vnext-architecture.md §1.3
- creator-hosted-agent-vnext-architecture.md §4.3-4.4
- creator-hosted-agent-vnext-architecture.md §7.8 and §23.2

## Privacy and security impact

text-only 和无 Action 限制 Prompt 注入造成外部副作用；闭世界 Context Reader、noexec 和 model-proxy-only 缩小文件与网络能力。

## Reversal triggers

- 引入文件、多模态、外部工具或写操作前，必须新增独立 capability、数据流、授权、审计和安全 Gate。

## Affected protocol versions

- combo.agent-version-manifest/1
- combo.creator-agent-http/1
- combo.sandbox-spec/1
