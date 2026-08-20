# Isolation Canary 契约（scripts/integration/isolation-canary/）

> 交付位置：E5 脚本（scripts/gates/e5-isolation-canary.sh）要求此目录存在两个可执行二进制。
> 当前状态：**未交付**（NOT_RUN）——随隔离镜像构建流程实现，本文件只冻结契约。

## syscall-canary

在真实隔离运行时（Apple `container` / `limactl`）内执行，逐项触发禁止集合，预期全部 BLOCKED：

| #   | syscall/能力                  | 预期    | 对应 RuntimePolicy 字段               |
| --- | ----------------------------- | ------- | ------------------------------------- |
| 1   | exec（fork/exec 任意二进制）  | BLOCKED | filesystem.context = read-only-noexec |
| 2   | mount / 宿主文件系统访问      | BLOCKED | filesystem.hostMounts = forbidden     |
| 3   | 凭据读取（credential store）  | BLOCKED | hostCredentials = forbidden           |
| 4   | raw socket / 网络绑定         | BLOCKED | network = model-proxy-only            |
| 5   | 跨 conversation 共享内存/进程 | BLOCKED | isolation = conversation-vm-required  |

输出：逐项 `PASS: <canary>` / `BLOCKED: <canary>` + 耗时；退出码 0 当且仅当全部符合预期。
禁止集合的意外放行必须 FAIL 并触发隔离告警（E5 不通过）。

## network-canary

仅 Model Credential Proxy 白名单端点（VNX_E5_MODEL_PROXY_URL）可达：

- 白名单端点 GET /healthz → 200；
- 公网直连（如 https://example.com）→ 连接被拒；
- 局域网/宿主网络探测 → 被拒；
- DNS 解析仅允许代理所需域。

输出同上；任何非预期可达即 FAIL。

## 构建与升级策略

- canary 二进制随隔离镜像交付，版本与不可变镜像 digest 绑定并记录；
- Apple container patch 升级至少重跑完整 deterministic Isolation Gate（测试方案 §326）；
- minor 升级跑 Full Runtime + Isolation + 8h Soak。
