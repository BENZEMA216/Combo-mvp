# combo-dev Kubernetes 清单

这套清单把逻辑环境 `combo-dev` 固定部署到现有的 `combo-preview` 命名空间，并继续使用受限级别的 Pod 安全策略。它不会创建第三套业务命名空间，也不会修改生产清单。

PostgreSQL、队列 Redis 和 MinIO 分别使用 `data-postgres-0`、`data-redis-queue-0` 和 `data-minio-0`。三个 PVC 与 `combo-dev-postgres`、`combo-dev-redis-queue` 和 `combo-dev-minio` 三个静态本地 PV 一一预绑定，请求容量分别为 8 GiB、2 GiB 和 6 GiB。热 Redis 继续使用有容量上限的临时卷。

`platform/storage-class.yaml` 使用 Kubernetes 内置的 `kubernetes.io/no-provisioner`，仓库不包含自定义存储 provisioner。`platform/storage-volumes.yaml` 把三个 PV 固定到 `/home/xingzheng/data/combo-dev/postgres`、`/home/xingzheng/data/combo-dev/redis-queue` 和 `/home/xingzheng/data/combo-dev/minio`，并用节点亲和性绑定唯一的就绪节点。每个 PV 根目录包含只读标记和 `data` 子目录；业务进程只把 `data` 子目录挂载为数据目录，并在启动前通过同一 PVC 校验标记。bootstrap 接受全空、已经完整符合静态契约，或历史 Cloud Review 留下的精确三卷布局。历史布局必须同时匹配固定 PVC 名称、PVC UID、PV 绑定、本地路径、`local-path` 存储类和 `Delete` 回收策略；bootstrap 只有在关闭全部旧工作负载后才删除这三份已批准可丢弃的数据，并等待旧 PV 与目录消失。任何额外或部分存储状态都会阻断接管。普通部署不会创建、删除或改绑 PV 与 PVC。

主机 bootstrap 必须先确认 `/home/xingzheng/data/combo-dev` 是容量不超过 18 GiB 的独立挂载，再创建三个固定数据目录和对应标记。PostgreSQL 目录归 UID/GID `70:70` 所有，队列 Redis 目录归 `999:1000` 所有，MinIO 目录归 `1000:1000` 所有，目录权限统一为 `0700`。PV 只使用必须预先存在的 `local.path`，因此挂载缺失时 Kubernetes 不会在父数据盘或根盘自动创建替代目录。

所有 `combo-preview` Pod 都只挂载 PVC、ConfigMap、Secret 或有界临时卷，不包含 `hostPath`。部署、smoke 和主机存储守卫会验证独立挂载、挂载源、固定路径、卷标记、目录身份、PV/PVC 预绑定和节点亲和性。共享 k3s 只能依赖生产所需的父数据盘，不能依赖开发挂载或其任何子路径。

PostgreSQL 使用固定摘要的 Alpine 镜像，并按镜像内真实的 UID/GID `70:70` 运行。`foundation/postgres-entrypoint.sh` 把旧根目录布局迁移到 `pgdata` 子目录，只使用该镜像实际提供的 Bash、`cat`、`mkdir`、`mv`、`chmod`、`rm` 和 `sync`。脚本在移动前写入状态文件，先移动并验证普通条目，最后移动 `PG_VERSION`；非空目标、移动失败或中断都会保留失败关闭状态。新卷初始化、成功迁移和重复启动都使用同一入口。

`platform/` 负责命名空间配额、默认资源边界、默认拒绝网络策略、普通调度角色、最小失败收敛角色、静态存储类和静态卷绑定。`platform/namespace.yaml`、`platform/rbac.yaml`、`platform/storage-class.yaml` 和 `platform/storage-volumes.yaml` 只能由 bootstrap 应用，并全部纳入主机控制摘要。bootstrap 会保存 Namespace、ClusterRole、ClusterRoleBinding、StorageClass 和三个 PV 的规范化期望内容。部署、smoke 和重置会读取每个固定对象，去除 Kubernetes 明确生成的元数据后执行完整比较，任何额外字段或内容变化都会阻断操作。`platform/kustomization.yaml` 只聚合普通部署可更新的 `quota.yaml`、`limit-range.yaml` 和 `network-policies.yaml`。调度身份只能按固定名称读取三个 PV，不能列举或修改集群存储资源。

`foundation/resources.yaml` 定义 PostgreSQL、双 Redis、MinIO 和它们的私有 Service。`migrate/resources.yaml` 固定校验 `0008` 迁移头，在同一空库上连续执行两遍迁移扫描，并配置 API、Worker、Runtime 三个固定数据库角色。`apps/resources.yaml` 定义生产式邮箱 OTP 的 API、Worker、Runtime、Web 和私有 Service；不存在 dev-login 或开发会话 Secret。Nginx 固定 hashed asset 缺失为 `404`。四个应用使用 `Recreate` 更新策略，并由固定字段管理器显式关闭和恢复副本。

调度角色对 Secret 没有读取、列举、创建、修改或删除权限。为生成不含 Secret 的完整 Test 清单，它只读列举 DaemonSet、CronJob、Ingress、HPA、ServiceAccount、ResourceQuota 和 LimitRange。

仓库中的应用镜像引用只是未发布模板，不能直接应用。受保护工作流必须先把当前 `main` 的 SHA 标签解析为 OCI 摘要，再由 `combo-dev-deploy.sh` 注入摘要。调度器只应用经过固定资源清单、Service 暴露、NetworkPolicy、镜像、命令、安全上下文、PVC 挂载和 Secret 引用检查的五个阶段渲染结果。

配置保存在主机 `/etc/combo-dev` 的 owner-only 文件中，由主机所有者在 bootstrap 时写入命名空间 Secret。仓库与工作流只处理配置键是否存在，不读取或输出配置值。Web 浏览器来源固定为 `http://127.0.0.1:18080`，S3 浏览器端点固定为 `http://127.0.0.1:19000`。

部署会先执行服务端 dry-run，再关闭全部应用、基础服务和一次性任务。基础服务恢复后，部署必须验证静态存储与主机挂载，随后执行网络检查、MinIO 初始化、数据库迁移和应用恢复。网络 canary 使用固定摘要的 Python 镜像和标准库 TCP 连接探针。它会先在 Pod 回环地址建立监听并证明探针能够识别成功连接，再检查生产 Service、控制面、元数据地址和节点端口均不可达。该 Job 符合受限 Pod 安全策略，不使用 `hostPath`。

生产指纹保留对象 UID、Pod UID、owner UID、Pod IP、Pod 启动时间和容器启动时间，同时继续保留完整 spec 与就绪状态。相同名称的 Pod 删除重建、路由变化或容器重建都不能比较为相同。任何存储路径漂移、状态读取失败、主机边界缺失、日志证据缺失或生产指纹变化都会让全部写入者保持关闭。

破坏性重置不会删除或改绑静态 PV/PVC。它会先关闭并删除固定控制器，再次验证挂载和绑定，然后只清空三个规范数据目录并恢复精确所有权。基础服务完成冷启动验证后会再次缩容，持久阻断标记只能由后续完整部署清除。
