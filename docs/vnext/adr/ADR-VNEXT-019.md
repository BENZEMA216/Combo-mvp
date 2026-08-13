<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-019: Local Control API trusts the signed-in macOS user

- Status: accepted
- Owner: Creator Worker
- Decision date: 2026-08-13

## Decision

Alpha release Local Control 只监听 parent 0700、socket 0600 的 Unix domain socket；禁用 loopback HTTP。每次连接验证 socket inode/owner/device、peer uid和macOS audit token；状态变更生成短期 nonce并要求 Creator Console 前台确认后由安装 Device key签名，nonce一次性且60秒失效。威胁模型明确不防已控制同一macOS账号且能自动化用户界面的恶意进程；此边界必须在产品/证据中披露。

## Alternatives considered

- 仅 Host/Origin loopback token；拒绝，不是正式本地身份边界。
- Alpha 即拆独立 OS user/XPC privileged service；暂缓，复杂度高且需单独安装/升级模型。

## Evidence

- creator-hosted-agent-vnext-test-plan.md §17.2
- Creator Console confirmation architecture

## Privacy and security impact

同 UID 进程不能仅凭 socket 请求静默 publish/online；长期 credential 和绝对路径不进入 argv/env/log。不能宣传防本机账号失陷。

## Reversal triggers

- 面向非受控 Creator 或要求抵抗同UID恶意进程时，升级独立OS user/XPC/code-signing ACL。

## Affected protocol versions

- combo.local-control/1
