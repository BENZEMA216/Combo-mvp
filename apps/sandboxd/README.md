# apps/sandboxd

这个应用只运行在按需创建的沙箱 Pod 内，为 Runtime 的模型工具提供受限文件和命令协议。它不持有模型、数据库、Redis、MinIO 或登录凭据。每个 Pod 在存活期间只绑定一个 Session，并把临时工作区固定在 `/workspace`。

## 文件职责

- `package.json` 把 Go 构建、vet 和测试接入 pnpm 工作区。
- `go.mod` 与 `go.sum` 固定 Go 版本、模块名和 `x/sys` 校验值。
- `main.go` 负责启动 HTTP 服务、应用进程资源限制和处理退出信号。
- `config.go` 负责读取 Pod 身份、公钥、监听地址和固定安全上限。身份或公钥缺失时进程拒绝启动。
- `capability.go` 验证 Ed25519 能力令牌、请求正文哈希、Session、Pod UID、操作、请求编号、有效期和取消目标，并在内存中拒绝短期重放。
- `path.go` 只接受工作区内的相对 POSIX 路径，并拒绝绝对路径、父目录、反斜杠、空段、过长路径和过深路径。
- `files_linux.go` 使用 `openat2` 和目录文件描述符完成受限读取、父目录创建、原子写入和原子编辑。内核不支持所需解析标志时会失败关闭，不使用 `realpath` 降级。
- `files_unsupported.go` 让非 Linux 构建明确拒绝文件操作。
- `process_linux.go` 串行执行命令，使用独立进程组、子进程收割、超时和输出预算，并重复扫描进程命名空间清理普通及脱离进程组的后代。生产命令必须先经过 `sandbox-exec`；包装器缺失时 sandboxd 拒绝启动。
- `cmd/sandbox-exec/` 提供命令写入边界。Linux 实现要求 Landlock ABI 3，只允许命令在 `/workspace`、`/tmp` 和 `/dev/null` 写入，然后才执行 Bash。非 Linux 实现直接拒绝执行。测试验证工作区写入成功且白名单外文件保持不变。
- `process_unsupported.go` 让非 Linux 构建明确拒绝命令操作。
- `ndjson.go` 负责线程安全的命令流写入、逐帧刷新、线路帧大小检查和写入超时。
- `server.go` 定义健康检查、协议路由、严格 JSON 解码、稳定错误信封和脱敏日志。
- `wipe-workspace.sh` 由每个新 Pod 的受限初始化容器调用。它先恢复挂载根和子目录的属主权限，再在不跟随符号链接的前提下清空固定槽位。
- `capability_test.go` 覆盖声明绑定、过期和重放拒绝。
- `path_test.go` 覆盖相对路径、遍历、深度和长度限制。
- `files_linux_test.go` 覆盖符号链接拒绝、原子写入、编辑前提和文件上限。
- `process_linux_test.go` 覆盖 NDJSON 所需进程事件、非零退出、输出上限、超时、取消、真实 HTTP 断连、脱离后代清理和日志文件描述符隔离。
- `server_test.go` 覆盖健康检查、认证路由、取消目标绑定、同步清理响应、无效能力请求编号隔离和错误脱敏。

## HTTP 协议

`GET /health` 是唯一不需要认证的端点。以下端点都使用 `POST`，都要求 `Authorization: Bearer <capability>`、`X-Request-Id`、`X-Sandbox-Session-Id` 和 `X-Sandbox-Pod-Uid`：

| 端点                              | 能力操作   | 请求用途                                                   |
| --------------------------------- | ---------- | ---------------------------------------------------------- |
| `/v1/describe`                    | `describe` | 返回协议版本、Pod 身份、工作区、命令输出编码和服务端上限。 |
| `/v1/files/read`                  | `read`     | 有界读取 UTF-8 文件。                                      |
| `/v1/files/write`                 | `write`    | 有界原子写入文件，可显式创建父目录。                       |
| `/v1/files/edit`                  | `edit`     | 按旧文本前提做有界原子替换。                               |
| `/v1/commands`                    | `command`  | 执行一个命令并返回 NDJSON 流。                             |
| `/v1/commands/{commandId}/cancel` | `cancel`   | 幂等终止指定命令，并等待后代清理完成后响应。               |

能力令牌的声明至少包含签发方、受众、Session ID、Pod UID、操作、请求编号、签发时间、生效时间、过期时间和请求正文 SHA-256。取消令牌还绑定 URL 与正文中的命令编号。公钥位于 Pod，私钥和模型凭据始终留在 Runtime。

命令流只有四种帧。`start` 声明命令编号，`output` 用 `stream` 区分标准输出和标准错误，并把原始字节放在标准 Base64 的 `data` 中；`exit` 是唯一正常终态，`error` 表示命令尚未形成正常终态。Runtime 按标准输出和标准错误分别做增量 UTF-8 解码，因此多字节字符跨帧时不会损坏，非文本字节会稳定替换为 Unicode 替代字符。JSON 请求最大 8 MiB，文件最大 512 KiB，单个 NDJSON 线路帧最大 16 KiB，单条命令最多发送 4096 个输出帧，累计命令原始输出最大 1 MiB。输出超过上限时服务端立即终止命令；默认超时是 120 秒，允许的最大值是 300 秒。服务端按 Base64 膨胀比例切分输出，并给每次线路写入设置五秒超时，因此客户端停止读取也不会无限占住命令。

## 文件系统边界

Linux 文件实现使用 `RESOLVE_BENEATH`、`RESOLVE_NO_SYMLINKS` 和 `RESOLVE_NO_MAGICLINKS`，并在已打开的父目录文件描述符中写临时文件后原子改名。确定存在的符号链接会被拒绝，写入不会跟随链接逃出工作区。

普通 Node 路径检查和 `realpath` 无法消除检查与使用之间的竞争，因此 Runtime 没有 Node 文件实现，也没有宿主文件系统回退。即使使用内核文件描述符，也不能把两个同时拥有同一工作区写权限的进程变成事务系统；另一个进程仍可能在两次独立操作之间修改工作区内容。这个同工作区内容竞争被限制在单个非特权 Pod 内，并依赖 gVisor、独立挂载和默认拒绝网络阻止它越过沙箱边界。模型工具在 Pi 中声明为串行，sandboxd 同时只允许一个命令，以进一步缩小竞争窗口。

Bash 启动前必须进入 Landlock 写入域。命令可以读取镜像中的普通程序和系统文件，但只能在 `/workspace`、`/tmp` 和 `/dev/null` 发起文件写入。这个边界同时阻止命令写入 Kubernetes 注入的 `/dev/termination-log`，避免工作区内容通过 Pod 终止消息进入控制面。内核或运行时不支持要求的 Landlock ABI 时命令失败关闭，不回退为无写入白名单的 Bash。

## 运行边界

生产 Pod 使用只读根文件系统、非 root 用户、全部能力移除、禁止提权、默认 seccomp、无 ServiceAccount 令牌和无服务环境变量。处理器请求为 100m，上限为 500m；内存请求和上限都是 384 MiB。`/tmp` 是最大 256 MiB 的内存卷。

`/workspace` 挂载固定槽位的 Local PVC。每个 PVC 对应数据盘上的 1 GiB ext4 loopback 块设备，容量不依赖 `emptyDir.sizeLimit` 或 kubelet 延迟驱逐。主机准备步骤会先删除 ext4 初始的 root 属主 `lost+found`，新 Pod 再由同一槽位 UID 的初始化容器清空挂载点；即使命令移除了挂载根权限，下一次清空也会先恢复。同一 Session 复用存活 Pod 时保留文件。Pod 的 `activeDeadlineSeconds` 与 Runtime 清扫都把绝对生命周期限制在三十分钟内。

文件描述符上限是 128，用户进程软硬上限是 256。Docker 端到端测试还使用 256 的容器 PID 上限；gVisor 节点上的最终 PID 行为仍需在维护窗口现场核对。

sandboxd 不继承 Runtime 或 Kubernetes 凭据。子进程只获得固定的 `HOME`、`PATH`、`TMPDIR` 和语言环境，不能自行调高文件描述符或进程上限。守护进程启动后不可转储，子进程不能通过 `/proc` 打开其日志文件描述符，也不能写入 Kubernetes 终止消息文件。

HTTP 处理器总并发限制为 32。没有 Bearer 能力或能力无效的 loopback 请求不会把攻击者提供的请求编号写入响应或日志。只有认证成功的请求编号才会记录，日志不保存能力令牌、路径、文件正文或命令正文。对外错误只返回稳定分类。

## 验证

在当前平台运行可移植测试：

```sh
go test ./...
```

Linux 路径和进程测试应在 Linux 或临时容器中运行。仓库脚本会构建真实镜像，并通过 Docker internal network 从独立驱动容器调用认证协议：

```sh
bash scripts/integration/sandbox-tools-local.sh
```

这个脚本加载 Runtime 编译产物中的生产 Pi 工具、`SandboxClient` 和能力签名器，通过 Docker 内部网络调用 sandboxd。Linux CI 使用 1 GiB loopback ext4 工作区和 384 MiB 容器内存，并验证超额写入失败、初始化清空、文件变更、命令流、超时、HTTP 取消、Abort、HTTP 断连、脱离进程组后代、日志文件描述符和模拟 Kubernetes 终止消息文件的隔离。

宿主单元测试按 Go package 串行运行，避免进程清理契约与同一测试进程树中的并发 package 相互干扰。宿主内核没有 Landlock ABI 3 时，只跳过无法执行的 Landlock 写边界用例；GitHub Actions 的受控 Sandbox 容器验收仍必须实际通过 Landlock 和完整协议测试。

脚本不会创建 Kubernetes 资源，也不会验证 gVisor、Local PV 调度、NetworkPolicy 或 k3s。真实集群验证只能在获批维护窗口中进行。
