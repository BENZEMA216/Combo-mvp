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

## 部署前准备

先创建命名空间，再从服务器上的生产环境文件创建应用配置 Secret：

```sh
kubectl apply -f infra/k8s/namespace.yaml
kubectl -n combo create secret generic combo-env --from-env-file=/opt/combo/infra/.env
kubectl -n combo create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=<GitHub 用户名> --docker-password=<具有 read:packages 权限的 PAT>
```

`ghcr-pull` 用的 token 需要长期有效：CD 流水线用的是 GitHub Actions 的临时 token、部署完即登出，集群里拉镜像必须另建一个 read:packages 权限的个人访问令牌（PAT）。

`combo-env` 必须包含 PostgreSQL 管理密码、三个独立应用角色密码、S3、Resend、OTP HMAC 和 LLM 配置。`RESEND_FROM_EMAIL` 固定为 `Combo <auth@buildwithcombo.com>`，不从 Secret 覆盖。部署前还必须把三个业务镜像的 `latest` 改成不可变摘要。

```sh
kustomize edit set image ghcr.io/dangdang-tech/combo-api=ghcr.io/dangdang-tech/combo-api:<SHA> ghcr.io/dangdang-tech/combo-runtime=ghcr.io/dangdang-tech/combo-runtime:<SHA> ghcr.io/dangdang-tech/combo-web=ghcr.io/dangdang-tech/combo-web:<SHA>
```

## 首次部署

首次部署应先创建基础设施，并等待 PostgreSQL、Redis 和 MinIO 就绪：

```sh
kubectl apply -f infra/k8s/postgres.yaml -f infra/k8s/redis-queue.yaml -f infra/k8s/redis-hot.yaml -f infra/k8s/minio.yaml
kubectl -n combo rollout status statefulset/postgres
kubectl -n combo rollout status statefulset/redis-queue
kubectl -n combo rollout status statefulset/minio
kubectl -n combo rollout status deployment/redis-hot
```

基础设施就绪后创建建桶任务和数据库迁移任务，并等待它们成功完成：

```sh
kubectl apply -f infra/k8s/job-minio-init.yaml -f infra/k8s/job-migrate.yaml
kubectl -n combo wait --for=condition=complete job/minio-init job/migrate --timeout=300s
```

两个任务完成后创建业务工作负载：

```sh
kubectl apply -f infra/k8s/api.yaml -f infra/k8s/worker.yaml -f infra/k8s/runtime.yaml -f infra/k8s/web.yaml
```

完成首次分阶段部署后，整套声明也可以使用 `kubectl apply -k infra/k8s` 重复应用。就绪探针会阻止尚未就绪的 API 和 runtime 接收流量，但不会替代首次部署时对任务完成状态的检查。

## 日常更新

Production 不随 `main` 自动更新。受保护的 CD 流水线只接受已经通过 Preview 的完整 main SHA，并消费同一个 release artifact 和 digest-pinned 镜像。服务器使用 `scripts/deploy-release.sh` 分阶段激活候选、保留旧 release、等待六区验收，再完成清理和证据提交；Production 不重新构建镜像，也不接受服务器直接应用本目录文件。

## 当前生产状态与流量拓扑

系统 Nginx 只反向代理到 release systemd 单元维护的 IPv4 loopback 端口。Production Web 使用 `18082`，Production MinIO 使用 `19002`；Kubernetes Service 保持 ClusterIP，公网不暴露 NodePort。`buildwithcombo.com` 的切换由版本化脚本按配置摘要和精确 server block 完成，不能通过旧 compose、手工 sed 或恢复旧 NodePort 配置回滚。

观测栈部署在 `observability` 命名空间，用 Helm 单独安装与升级，配置和安装说明在 `observability/` 子目录；业务三进程的 OTLP 上报地址已写进各自清单的环境变量。Grafana 在节点的 30300 端口。

## combo-dev 覆盖层

开发组合环境的固定覆盖层位于 `overlays/combo-dev/`。它只复用 `combo-preview` 命名空间，并用 Kubernetes 内置的静态卷模式把三个 PVC 预绑定到独立有界挂载中的三个本地 PV，不包含自定义存储 provisioner。共享 k3s 只依赖生产所需父数据盘，开发工作负载只挂载 PVC，不使用 `hostPath`。主机 bootstrap 会先完成全部只读检查，再写入持久阻断、关闭转发器并验证所有写入者停止，随后才清理通过精确绑定验证的旧 Cloud Review 三卷数据、创建固定目录或应用平台对象。额外、部分或路径漂移的旧存储不会被自动删除。Namespace、集群 RBAC、StorageClass 和三个 PV 必须与 bootstrap 保存的规范契约完整一致。应用清单只能由手工触发的受保护工作流处理；工作流要求当前 `main` 的完整 SHA 与成功 CI，并与生产 CD 共用 `cd-tecent2` 并发组。它注入镜像摘要后，从五个固定阶段的已验证字节按覆盖层 README 的顺序部署，不能直接应用仓库模板。

Sandbox Tools 的 PR 合并前现场验收清单位于 `overlays/sandbox-tools/review/`。它把动态沙箱放入独立的 `combo-review-sandbox` 命名空间，并为 `combo-review` Runtime 提供默认关闭的单独补丁。这个目录固定测试节点、四个测试专用静态本地卷和当前测试镜像摘要，不属于生产部署入口。使用前必须按目录 README 完成主机 loopback 准备、测试 Runtime 镜像部署和分阶段启用。
