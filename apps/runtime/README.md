# apps/runtime（能力运行与界面设计后端）

Runtime 是 Capability 运行与界面设计端的独立后端。它管理登录校验、普通与 Studio Session、Turn、Message、Redis SSE 和 Artifact，并在接收请求的实例内异步运行 Pi Agent。同一个 Session 同时最多只有一个 `running` Turn，并发提交继续使用现有的 `SESSION_BUSY` 409 错误信封。

## 服务边界

Runtime 读取 Capability 定义，并在 Studio Turn 成功时更新 Capability 的当前 UI Artifact 指针。它读写 `sessions`、`turns`、`messages` 和 `artifacts`，并按对象键访问 MinIO。模型、模型凭据、Pi 会话和流式事件都留在 Runtime。

`upsert_artifact` 仍是可信的 Runtime 本地工具。它先写不可变对象，再只在绑定 Turn 仍为 `running` 时提交带来源 Turn 的 Artifact 索引。模型使用的 `read`、`write`、`edit` 和 `bash` 只调用独立 sandboxd Pod，不访问 Runtime 宿主文件系统，也不启动宿主子进程。功能关闭或远程调用失败时都没有宿主回退。

## 源码结构

- `platform/` 保存环境变量、数据库、Redis、对象存储、登录验签、模型选择和可选沙箱后端。
- `modules/capability/` 负责能力列表、权限判断、对象存储加载和定义校验。
- `modules/session/` 负责普通与 Studio Session、Message 的数据访问和 HTTP 处理。
- `modules/agent/` 负责 Turn 生命周期、Pi Agent、Redis 事件流、Studio 模式和模型工具。
- `modules/artifact/` 负责 Artifact 索引、正文对象、Studio HTML 契约、UI 隔离副本和 `upsert_artifact`。
- `bootstrap/` 负责组装 Fastify、基础设施、TurnRunner 和路由。
- `processes/api.ts` 是唯一 HTTP 进程入口，默认监听 3100。

## Turn 与流式事件

Turn 创建受数据库部分唯一索引保护。两个 Runtime 副本同时为一个 Session 提交消息时，只有一个副本能插入 `running` Turn。只有目标索引的 PostgreSQL 唯一冲突会映射为 `SessionBusyError`。

每个非终态 Redis 事件都会先锁住 Session，并确认同一个 Turn 仍为 `running`。终态状态、错误和消息先在 PostgreSQL 事务中提交，随后才按 `runId` 幂等追加 Redis 终态。数据库终态一旦提交，旧 Pi 的文本与产物状态就不能再通过运行态守卫；Redis 的终态标记还会拒绝同一 Turn 的迟到普通事件和不同终态。终态标记缺失或仍是旧版 `OPEN` 时，普通事件脚本会先扫描保留的 Stream 并恢复终态标记，不会把已终止的 Turn 重新开放。

终态 Redis 写入有硬超时，但超时或结果不明确不会回滚已经提交的 PostgreSQL 终态。下一轮创建前会在 Session 行锁内读取最近的持久终态，并确保对应 Redis 事件存在，然后才插入新 Turn。数据库修复路径可以替换升级前遗留的冲突终态；即使现有标记已经匹配，只要同一 Turn 在旧终态后还有迟到普通事件，修复也会删除旧终态并在 Stream 尾部重放数据库终态。普通竞争终态仍会失败。恢复 `RUN_ERROR` 时只按受信错误码生成固定公开文案，不会把历史 `last_error.message` 的内部诊断发送到 SSE。因此新一轮的 `RUN_STARTED` 一定排在修复后的旧终态之后。

Runtime 关闭时会中止 Pi，并让 Turn、PostgreSQL 查询、Kubernetes 后端和基础设施连接共用一个绝对截止时间。关闭流程同时跟踪尚未发布活动句柄的开轮事务；未进入提交阶段的事务会被取消，已经提交的 Turn 会加入同一轮远程清理和终态收口。关闭事务设置 PostgreSQL 锁等待与语句超时。只有远程清理已经确认且截止时间尚未耗尽的 Turn 才会认领终态；其他 Turn 保留 `running` 唯一约束。对象存储写入在中止后才返回时不会提交 Artifact。

Studio Session 会给 Pi 注入界面设计协议、视觉连续性规则和首版视觉合同。`upsert_artifact` 只接受符合 Miniapp 运行契约的 HTML revision；只有完整 Turn 成功后，本轮最后一个 revision 才会在同一终态事务中成为 Capability 当前 UI。详情恢复时只展示种子副本、每个成功 Turn 的最终 revision 和 active Turn 的最新候选，失败或中断 Turn 的 Artifact 不进入历史。新普通 Session 会复制创建时的 UI 隔离副本，已有 Session 不随之后的 Studio 修改漂移。

Session 详情的 owner 重验、Message、Artifact、当前 UI 和 active Turn 全部来自同一 `REPEATABLE READ READ ONLY` PostgreSQL 快照，避免刷新撞上终态提交时拼接出不可能同时存在的状态。Capability 定义的 MinIO 读取在快照事务结束后执行，不占用数据库连接。并发进入同一 Studio 时，UI seed 会在对象上传后锁住并核验目标 Session，并在锁内复查已有 HTML，因此只会提交一条不关联 Turn 的种子副本；竞争落败的不可变对象不进入数据库可见历史。

## 可选沙箱工具

`SANDBOX_TOOLS_ENABLED` 默认是 `false`。关闭时不加载 Kubernetes 客户端模块或集群配置，不要求沙箱镜像或签名私钥，也不注册四个远程工具。开启时必须提供使用 SHA-256 摘要的 sandboxd 镜像和 Ed25519 PKCS#8 私钥，RuntimeClass 固定为 `gvisor`。镜像、公钥、容量或安全规格变化时必须递增配置修订号；滚动发布期间只有较新修订能替换较旧 Pod，旧副本不能把新 Pod 回滚。

Runtime 默认竞争四个固定 Pod 名称。Pod 按需创建，同一 Session 在 Pod 存活期间复用工作区。普通配置使用以下边界：

- 处理器请求为 100m，上限为 500m。
- 内存请求和上限都是 384 MiB。
- `/workspace` 挂载固定槽位的本地 PVC。每个 PVC 的底层是数据盘上的 1 GiB ext4 loopback 文件，因此容量由块设备物理限制。
- `/tmp` 使用 256 MiB 的内存卷。
- 文件描述符上限为 128，进程预算为 256。
- Pod 空闲十五分钟后可回收；Pod 的 `activeDeadlineSeconds` 和 Runtime 清扫都把绝对生命周期限制在三十分钟内。

每个新 Pod 都先由非特权初始化容器清空固定槽位，再启动 sandboxd。Runtime 在创建 Pod 前使用 PVC 资源版本原子记录 Session 和分配编号，删除前把该 PVC 标为隔离。Runtime 只有看到节点上主容器和初始化容器都进入终止状态、移除 Pod finalizer 并确认原 UID 消失后，才会清除 PVC 分配标记。节点失联、强制删除或终止状态无法确认时，PVC 标记会继续阻止所有副本复用槽位，当前 Turn 也保持 `running`。第五个槽位不在普通清单中；只有完成真实集群验证后，管理员才能同时选择独立的第五槽清单和显式验证开关。

每次工具调用都会重新确认 owner、active Session 和 running Turn。Runtime 为单次请求签发绑定 Session、Pod UID、操作、请求编号和正文哈希的短期能力令牌，Pod 只获得公钥。Kubernetes 读取、创建、删除和列表请求都有可取消硬超时。

命令取消会等待 sandboxd 完成后代扫描。Bash 启动前还会建立 Landlock 写入白名单，只允许写 `/workspace`、`/tmp` 和 `/dev/null`，因此不能把工作区内容写进 Kubernetes 终止消息。取消超时、断流或协议失败时，Runtime 会使用 UID 与资源版本前置条件删除 Pod，并等待节点终止状态和该 UID 消失。删除仍无法确认时，沙箱工具会中止 Pi 且不释放当前 `running` Turn。

## 基础设施边界

可选清单位于 `infra/k8s/overlays/sandbox-tools/`。根生产 kustomization 和生产部署脚本不会引用它。持续部署的递归同步命令显式排除 sandboxd Dockerfile、四槽清单和第五槽清单，并清理服务器上可能残留的旧副本。仓库不会自动安装 runsc、重启 k3s 或向集群应用这些资源。

普通清单包含四个固定 Local PV/PVC。`infra/k8s/overlays/sandbox-tools-fifth-slot/` 是独立的第五槽维护入口，普通清单不会引用它。真实 gVisor、Local PV 调度和 NetworkPolicy 仍需在获批维护窗口现场验证。

## 本地验证

```sh
pnpm -F @cb/shared build
pnpm -F @cb/runtime typecheck
pnpm -F @cb/runtime typecheck:test
pnpm -F @cb/runtime test
DATABASE_URL=<测试库地址> pnpm -F @cb/db migrate
RUNTIME_TERMINAL_FENCE_DATABASE_URL=<测试库地址> \
RUNTIME_TERMINAL_FENCE_REDIS_URL=<测试 Redis 地址> \
pnpm --dir apps/runtime exec vitest run src/__tests__/terminal-fence.integration.test.ts
RUNTIME_TERMINAL_FENCE_DATABASE_URL=<测试库地址> \
pnpm --dir apps/runtime exec vitest run src/__tests__/session-consistency.integration.test.ts
bash scripts/integration/sandbox-tools-local.sh
```

最后一条脚本通过 Docker 内部网络运行生产 `SandboxClient`、四个 Pi 工具和 sandboxd。Linux CI 使用 1 GiB loopback ext4 工作区，并验证超额写入失败、清空复用、文件操作、命令流、超时、HTTP 取消、Abort、断连、脱离进程组后代和日志边界。脚本不创建 Kubernetes 资源，也不能替代真实 gVisor 和集群网络验证。
