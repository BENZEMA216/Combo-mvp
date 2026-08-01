# Combo 单机 k3s 清单

这套清单把生产 Docker Compose 栈中的 PostgreSQL、两个 Redis 实例、MinIO、桶初始化任务、数据库迁移任务和三个业务镜像部署到单节点 k3s。所有资源位于 `combo` 命名空间，持久卷使用默认可用的 `local-path` 存储类。

清单保留数据持久化、Redis 队列不驱逐、Redis 热数据可驱逐、MinIO 建桶和独立数据库迁移等语义。Kubernetes 没有采用 Compose 的 `depends_on`；基础设施的就绪探针负责报告状态，两个一次性任务和业务工作负载由部署命令按顺序创建。认证由 API 的第一方邮箱 OTP、PostgreSQL 摘要和不透明会话完成。

## 可选 Sandbox Tools

`overlays/sandbox-tools/` 保存模型文件与命令工具的可选清单。根 `kustomization.yaml` 和 `scripts/deploy-k8s.sh` 不引用该目录。持续部署仍递归同步普通 `infra/` 内容，但同步命令显式排除 sandboxd Dockerfile、四槽清单和第五槽清单，并删除服务器上的旧残留，因此生产发布不会携带沙箱权限、存储或 Pod 清单。

普通可选入口包含四个固定 Local PV/PVC、四 Pod 配额、受限的 Pod 与现有 PVC 管理权限和默认拒绝网络。每个 PV 指向 `/var/lib/combo-sandbox-slots/slot-N`，该路径必须由维护脚本挂载到数据盘上的独立 1 GiB ext4 loopback 文件。维护脚本删除初始 `lost+found` 并设置槽位属主；Pod 按需创建，新 Pod 启动前先恢复挂载根权限并清空槽位，同一 Session 在 Pod 存活期间复用内容。

普通 Pod 的处理器请求为 100m，上限为 500m；内存请求和上限都是 384 MiB；`/tmp` 上限是 256 MiB；进程预算是 256；`activeDeadlineSeconds` 与 Runtime 清扫都把绝对生命周期限制在三十分钟内。Bash 还使用 Landlock 写入白名单，不能写入 Kubernetes 终止消息文件。普通清单只允许四个槽位。

Runtime 在创建动态 Pod 前先用 PVC 资源版本原子写入 Session 和分配编号，删除前再把 PVC 标为隔离。只有节点状态确认主容器和初始化容器都已终止，Runtime 才会移除 Pod finalizer；确认原 UID 消失后才清除 PVC 分配标记并允许下一个 Session 复用。节点分区、Pod 被强制移除或终止状态缺失都会让 PVC 保持隔离，不能只凭 Pod UID 消失判定清理成功。

`overlays/sandbox-tools-fifth-slot/` 是独立的第五槽维护入口。只有完成真实集群调度、隔离、容量和清理验证后，管理员才可以选择它并设置验证开关。它还会递增沙箱配置修订号，避免旧 Runtime 副本回收第五槽。普通入口和自动生产路径都不会引用第五槽。

`overlays/sandbox-tools/maintenance/runtimeclass-gvisor.yaml` 只是未引用的维护样例。仓库不会安装 runsc、重启 k3s 或自动应用任何沙箱资源。`pnpm -F @cb/infra test` 只做本地静态渲染和断言，不能替代 gVisor、Local PV 或 NetworkPolicy 的现场验证。

## 受控发布前置条件

tecent2 的 Test、Preview 和 Production 命名空间及凭据 Secret 都由现有受控发布契约维护。管理员不得通过 `kubectl create secret`、环境文件导入或删除后重建来更新凭据，也不得在服务器上把业务镜像改成可移动标签。需要轮换第一方认证凭据时，应使用 `scripts/configure-first-party-auth-secrets.sh` 做带 UID 和 resourceVersion 条件的原位更新；镜像拉取凭据也必须原位轮换并保留 Secret 身份。

`combo-env` 必须包含 PostgreSQL 管理密码、三个独立应用角色密码、S3、Resend、OTP HMAC 和 LLM 配置。`RESEND_FROM_EMAIL` 固定为 `Combo <auth@buildwithcombo.com>`，不从 Secret 覆盖。Preview 和 Production 的业务镜像只能来自成功 `main` CI 生成的不可变 release artifact；Test 还允许由受信任 `main` 控制器为任意同仓库分支的精确 tip SHA 构建不可变 artifact。所有环境都必须使用清单中记录的摘要引用。

## 发布顺序

受保护工作流从不可变 release artifact 渲染并验证基础设施、建桶任务、迁移任务和四个业务面清单。部署控制器先等待 PostgreSQL、Redis 和 MinIO 就绪，再完成建桶和 `0000` 至 `0009` 迁移，最后启动 API、Worker、Runtime 和 Web。就绪探针只能报告单个工作负载状态，不能替代迁移、发布身份和真实六区验收。

成功的 `main` CI 自动部署同一候选到 Test；具有仓库写入权限的成员也可以通过只在 `main` 上运行的受信任手工控制器，把任意同仓库分支的精确 tip 构建并部署到 Test。只有 `main` 的自动 Test 成功证据可以继续进入 Preview，且 Preview 是否自动部署由 `COMBO_PREVIEW_AUTO_PROMOTION_MODE` 的 `enabled` 或 `paused` 状态控制。

Production 只允许通过 `.github/workflows/cd.yml` 晋级已经通过 Preview 的同一 artifact。服务器上的 `kubectl apply`、Kustomize 镜像改写或 Nginx 热改都不是正式发布入口。

## 日常更新

Production 不随 `main` 自动更新。受保护的 CD 流水线只接受已经通过 Preview 的完整 main SHA，并消费同一个 release artifact 和 digest-pinned 镜像。服务器使用 `scripts/deploy-release.sh` 分阶段激活候选、保留旧 release、等待六区验收，再完成清理和证据提交；Production 不重新构建镜像，也不接受服务器直接应用本目录文件。

## 当前生产状态与流量拓扑

系统 Nginx 只反向代理到 release systemd 单元维护的 IPv4 loopback 端口。Production Web 使用 `18082`，Production MinIO 使用 `19002`；Kubernetes Service 保持 ClusterIP，公网不暴露 NodePort。`buildwithcombo.com` 的切换由版本化脚本按配置摘要和精确 server block 完成，不能通过旧 compose、手工 sed 或恢复旧 NodePort 配置回滚。

观测栈部署在 `observability` 命名空间，用 Helm 单独安装与升级，配置和安装说明在 `observability/` 子目录；业务三进程的 OTLP 上报地址已写进各自清单的环境变量。Grafana 在节点的 30300 端口。

## combo-dev 覆盖层

开发组合环境的固定覆盖层位于 `overlays/combo-dev/`。它只复用 `combo-preview` 命名空间，并用 Kubernetes 内置的静态卷模式把三个 PVC 预绑定到独立有界挂载中的三个本地 PV，不包含自定义存储 provisioner。共享 k3s 只依赖生产所需父数据盘，开发工作负载只挂载 PVC，不使用 `hostPath`。主机 bootstrap 会先完成全部只读检查，再写入持久阻断、关闭转发器并验证所有写入者停止，随后才清理通过精确绑定验证的旧 Cloud Review 三卷数据、创建固定目录或应用平台对象。额外、部分或路径漂移的旧存储不会被自动删除。Namespace、集群 RBAC、StorageClass 和三个 PV 必须与 bootstrap 保存的规范契约完整一致。应用清单只能由受保护的 `main` 控制器处理；成功的 `main` CI 会自动发起 Test，手工入口则接受任意同仓库分支及其精确 tip SHA，并在进入受保护 Environment 前生成不可变 artifact。`combo-dev` Environment 只允许 `main` 是控制面 Secret 边界，不是目标源码分支限制。工作流与 Production CD 共用 `cd-tecent2` 并发组，注入镜像摘要后从五个固定阶段的已验证字节按覆盖层 README 的顺序部署，不能直接应用候选分支中的仓库模板。

Sandbox Tools 的 PR 合并前现场验收清单位于 `overlays/sandbox-tools/review/`。它把动态沙箱放入独立的 `combo-review-sandbox` 命名空间，并为 `combo-review` Runtime 提供默认关闭的单独补丁。这个目录固定测试节点、四个测试专用静态本地卷和当前测试镜像摘要，不属于生产部署入口。使用前必须按目录 README 完成主机 loopback 准备、测试 Runtime 镜像部署和分阶段启用。
