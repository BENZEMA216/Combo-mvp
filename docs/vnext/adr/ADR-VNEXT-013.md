<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-013: Project code execution is forbidden

- Status: accepted
- Owner: Runtime/Sandbox
- Decision date: 2026-08-13

## Decision

Alpha 把 Project 作为只读 Context，不执行任何 Project bytes。Guest 仅内置 read_context/list_context/search_context，绑定启动 root fd、Version 和 Conversation；shell、解释器、编译器、dynamic loader、external tool 与 Host Context Tool Broker 均关闭。复制到 scratch、memfd、execve/execveat/dlopen 也必须由机器策略拒绝。

## Alternatives considered

- 依赖 Prompt 告诉模型不要执行；拒绝，Prompt 不是安全边界。
- Host 上执行只读命令；拒绝，会打开 Creator HOME/凭据边界。

## Evidence

- AgentVersion RuntimePolicy and SandboxSpec/1 literals
- creator-hosted-agent-vnext-test-plan.md §15.5

## Privacy and security impact

将公开 Agent 的能力固定为问答，不成为 RCE/供应链执行服务；失败不得回退 native runtime。

## Reversal triggers

- 新产品明确需要 Action，必须独立 capability、隔离、审批和协议立项，不能沿用本 Gate。

## Affected protocol versions

- combo.agent-version-manifest/1
- combo.sandbox-spec/1
