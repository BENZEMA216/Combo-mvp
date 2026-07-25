# combo-dev 主机准备

combo-dev 只复用 `combo-preview` 命名空间。主机所有者必须确认该命名空间是唯一的开发预览环境，并明确批准其中数据可丢弃。若数据不能丢弃，应停止实施并另行制定备份恢复方案。

## 主机外部前置条件

共享 k3s 只能依赖生产需要的父数据盘 `/home/xingzheng/data`，其 systemd 单元必须声明 `RequiresMountsFor=/home/xingzheng/data`。该单元不得依赖开发专用挂载 `/home/xingzheng/data/combo-dev`，也不得依赖这个路径下的任何子路径。主机所有者必须通过受控重启证明父数据盘缺失时 k3s 不启动，并证明只有开发挂载缺失时 k3s 仍能启动生产命名空间。验证完成后，owner-only 文件 `/etc/combo-dev/data-mount-reboot.approved` 必须写成固定状态 `controlled-reboot=parent-data-mount-pass`。

combo-dev 的持久数据只能写入 `/home/xingzheng/data/combo-dev`。该路径必须是单独挂载的读写文件系统，挂载源必须不同于父数据盘，挂载选项必须包含 `nodev` 和 `nosuid`，总容量不得小于 16 GiB 或大于 18 GiB。这个固定大小的文件系统是硬容量边界，不能用普通目录或 PVC 请求容量代替。主机所有者必须在确认挂载真实生效后创建 root-owned 且非 root 不可写的 `/home/xingzheng/data/combo-dev/.combo-dev-mounted`，文件内容必须是 `combo-dev-storage-mount=v1`。bootstrap 会在这个挂载内创建 PostgreSQL、队列 Redis 和 MinIO 的固定数据目录及独立标记，并在暴露任何 PV 前设置精确所有权。主机准备阶段不得在未挂载状态下预建这三个卷根目录。静态本地 PV 只接受预先存在的路径，不会创建根盘回退目录；所有 Pod 只挂载 PVC，不挂载主机哨兵。`/etc/combo-dev/storage-pool.approved` 必须写成固定状态 `combo-dev-storage=dedicated-hard-18GiB-max`。

主机必须有独立审核的 Pod 到节点边界。该边界可以由 CNI 主机端点策略或 nftables 实现，但必须实际阻断 `combo-preview` Pod 到节点管理端口、Kubernetes 控制面和生产 NodePort 的流量，不能把同节点 NetworkPolicy 当作证明。主机所有者必须把只读检查器安装到 `/opt/combo-dev/host-boundary/check`。该文件必须归 root 所有、不可被非 root 修改，并在执行 `--check` 时只用退出码表示边界是否生效。通过后，owner-only 文件 `/etc/combo-dev/host-network-boundary.approved` 必须写成固定状态 `combo-dev-host-boundary=audited-and-active`。bootstrap、部署和网络 canary 都会再次验证这项控制。

k3s 的真实数据目录必须写入 owner-only 文件 `/etc/combo-dev/k3s-data-dir`。内容是数据盘内的绝对规范路径，不是 TLS 子目录。bootstrap 只从该目录下的 `server/tls/client-ca.crt` 和 `client-ca.key` 签发客户端证书；API 服务端信任根从展平后的管理 kubeconfig 读取。这样不会把客户端 CA 错当成服务端 CA，也不依赖标准安装路径。

主机必须用原生 journald 或 syslog 配置限制日志占用，不能用 Docker 清理代替根盘治理。验证完成后，owner-only 文件 `/etc/combo-dev/journal-retention.approved` 必须写成固定状态 `journald=native-retention-bounded`。部署前根盘和父数据盘都必须至少有 45 GiB 可用空间，验收后都必须至少有 40 GiB。只允许清理主机所有者批准的内容。

所有受限 sudo 入口必须使用包含 `/usr/local/bin` 的固定 `secure_path`。仓库内的 root 脚本也会主动把 `PATH` 固定为 `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`，不会继承调用者路径。

## 开发专用配置

`/etc/combo-dev/combo-dev.env` 必须归 root 所有且权限为 `0600`。它只保存开发专用的 PostgreSQL、MinIO、身份提供商和大语言模型配置。必须提供 `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`、`MINIO_ROOT_USER`、`MINIO_ROOT_PASSWORD`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`LOGTO_ENDPOINT`、`LOGTO_ISSUER`、`LOGTO_JWKS_URI`、`LOGTO_APP_ID`、`LOGTO_APP_SECRET`、`LOGTO_AUDIENCE`、`LLM_PROVIDER` 和 `RUNTIME_LLM_PROVIDER`。MinIO 管理身份必须与应用存储身份不同。所选模型提供商还必须有对应的开发密钥。身份提供商端点必须使用 HTTPS。

`/etc/combo-dev/registry.json` 必须归 root 所有且权限为 `0600`，只包含 `ghcr.io` 的开发只读拉取身份。`/etc/combo-dev/production-observer.kubeconfig` 必须使用单一嵌入式客户端证书，并与本机审核凭据使用完全相同的 API 服务端和证书颁发机构。该身份只能在生产命名空间对 Deployment、StatefulSet、Service、PVC 和 Pod 执行 `get`、`list` 与 `watch`。bootstrap、部署和重置会解析全部命名空间的有效规则与关联绑定，拒绝通配符、Secret 读取、任何持久变更权限、生产命名空间之外的资源权限和额外集群资源权限。Kubernetes 为已认证身份提供的不落盘自省请求与只读发现端点是唯一例外。

部署 SSH 用户不得持有 Kubernetes 凭据。它只能向带粘滞位且不可列目录的 `/opt/combo-dev/incoming` 投递文件，并通过受限 sudo 规则调用固定的 root-owned 调度器。GitHub 的 `combo-dev` 环境必须配置与当前验收分支精确匹配的分支限制和必需审核人，开发 SSH 材料只能保存在该环境中。combo-dev 工作流只接受手工触发，并要求输入仍可从仓库任一当前分支到达的完整提交 SHA；工作流会校验触发者权限、远端可达性，并为该 SHA 重新执行受信 CI 和构建。它与生产 CD 共用 `cd-tecent2` 并发组，后触发的部署必须排队。

首次准备和控制文件升级时，主机所有者必须先把相关脚本、主机文件和 combo-dev 覆盖层复制到 root-owned 且非 root 不可写的审核快照中，再从该快照执行：

```sh
sudo bash scripts/combo-dev-bootstrap.sh \
  --approve-disposable-preview-data \
  --approve-development-only-credentials
```

bootstrap 会先完成主机、配置、生产观察身份、生产指纹、节点身份、静态存储现状和集群级期望对象的全部只读检查。随后它先写入持久阻断标记，停止并验证两个回环转发器，再动态列出并关闭命名空间内全部 Deployment、StatefulSet、DaemonSet、Job、CronJob 和独立 Pod，不只处理新版清单中的固定名称。完成这三步后，它才会清理命名空间、创建固定数据目录或应用平台对象。若现有 Cloud Review 使用固定名称的三份旧 `local-path` PVC，bootstrap 会核对 PVC UID、PV 绑定、本地路径和回收策略，只在三卷完整匹配时删除已批准可丢弃的数据，并等待旧 PV 与目录消失；额外、部分或漂移的存储状态会直接阻断。任何命名空间、旧存储清理、RBAC、静态卷、Secret 或凭据步骤失败时，退出清理都会再次写入阻断标记并验证全部写入者关闭。

普通调度证书有效期为 90 天，剩余 30 天以内时 bootstrap 会轮换证书；部署、重置和定时守卫要求它至少还可用 7 天。独立失败收敛证书有效期为 365 天，剩余 90 天以内时 bootstrap 会轮换证书，定时守卫在剩余 30 天时先关闭写入者。失败收敛身份只能读取和缩容八个固定控制器、删除三个固定任务及其 Pod，不能创建工作负载、列举控制器、读取 Secret 或修改生产。bootstrap 会把 Namespace、ClusterRole、ClusterRoleBinding、StorageClass 和三个静态 PV 的规范化期望内容写入 owner-only 契约文件。部署、smoke 和重置会对这些对象执行完整规范比较。覆盖层、命名空间、RBAC、StorageClass、静态卷清单或控制脚本发生变化都会改变控制摘要，并强制主机所有者重新运行 bootstrap。bootstrap 不会启动应用或回环转发器，并保留持久写入阻断标记，直到一次完整部署成功。

## 独立存储守卫

`combo-dev-bounded` StorageClass 使用 Kubernetes 内置的静态本地卷模式。三个 PV 分别固定到 `/home/xingzheng/data/combo-dev/postgres`、`/home/xingzheng/data/combo-dev/redis-queue` 和 `/home/xingzheng/data/combo-dev/minio`，回收策略为 `Retain`。每个 PV 根目录归 root 所有，并包含只读卷标记和 `data` 子目录。PostgreSQL 的 `data` 目录必须保持 `70:70` 和 `0700`，队列 Redis 的 `data` 目录必须保持 `999:1000` 和 `0700`，MinIO 的 `data` 目录必须保持 `1000:1000` 和 `0700`。数据容器只通过 PVC 挂载 `data` 子目录，并在启动业务进程前读取同一 PVC 中的固定标记。

部署和 smoke 会验证静态 StorageClass、固定 PV 名称、PVC 预绑定、本地规范路径、节点亲和性和主机挂载。`combo-dev-storage-guard.service` 不带凭据文件存在条件，因此定时器每次都会真正执行。检查内容包括独立挂载、三个卷标记、目录身份、k3s 挂载依赖、可用字节、inode、持久失败标记、普通调度凭据和独立失败收敛凭据。

普通调度凭据缺失、格式错误、过期或权限漂移时，守卫会先停止并验证两个回环转发器，再写入 `/var/lib/combo-dev/writers-fenced`，最后使用独立最小凭据删除固定任务、缩容固定控制器并验证终态。存储与挂载失败也使用同一路径。转发租约在阻断标记存在时不能启动服务。只有完整部署成功才会删除阻断标记。MinIO 的四个开发桶各有 1 GiB 配额，队列 Redis 也有内存上限；这些服务级限制不能替代独立文件系统硬边界。

## 回环转发租约

`combo-dev-web-forward.service` 只把 Web Service 转发到主机 `127.0.0.1:18080`。`combo-dev-s3-forward.service` 只把 MinIO Service 转发到主机 `127.0.0.1:19000`。两个单元没有 `[Install]` 段，也没有自动重启策略。部署和 smoke 会读取两个 systemd 主进程身份，并解析端口 `18080` 与 `19000` 的全部 IPv4 和 IPv6 监听项。每个端口只能存在一个归对应主进程所有的 `127.0.0.1` 监听项。

开发者使用 `scripts/combo-dev-connect.sh` 时，远端 `/opt/combo-dev/bin/combo-dev-forwarder-lease` 会为该 SSH 会话持有共享操作锁和独立租约。多个开发者可以同时持有租约，一个会话退出只释放自己的租约，最后一个会话退出才停止全局转发器。部署、重置和 bootstrap 持有同一把排他锁，因此会拒绝新的开发连接；只要仍有开发租约，它们也不会开始。受限 sudo 规则只能允许无参数执行这个 root-owned 租约协调器。

## 外部真实验收器

主机所有者必须在 `/opt/combo-dev/acceptance/run` 安装独立审核的基础真实验收器。部署只执行这份 root 所有且普通用户不可写的固定入口，不会从候选 bundle 安装或替换它。验收器必须在 60 分钟内完成 SPA、同源开发登录、身份读取、登出失效、生产开发登录不可用、任务幂等重放、合成配对上传、健康路径 SSE、Worker 完成、能力发布、单轮 Runtime、终态 SSE、持久助手输出、可读产物、私有签名 PUT、GET 与删除、精确 CORS、逐个重启与持久化回读、SSH 回环访问、异机不可达和临时产物清理。

验收器只能向标准输出写一份不超过 64 KiB 的 JSON。顶层只能有 `revision`、`createdAt` 和 `checks`。每个检查只能包含 `status` 与不含敏感信息的 `id`，状态必须为 `PASS`。它不得输出响应体、请求地址、会话材料、签名 URL、配对材料、日志正文或任何凭据。`combo-dev-smoke.sh` 会严格校验固定检查键；缺少验收器、缺少检查或证据过期都会返回 `BLOCKED`。

仓库中的 `scripts/goal-b-test-acceptance.mjs` 是 Goal B 的补充验收器，覆盖 Studio 多轮、元素选择、刷新恢复、revision、current UI、consume Session 和两个返回路径。它从与部署 SHA 完全一致的普通源码目录单独运行，使用同一条 `127.0.0.1` Web 回环转发，并生成独立的脱敏 `0600` JSON；它不能替代上述基础验收器，也不会被部署 bundle 自动安装。

## 重置

破坏性重置只接受受保护 Test workflow 传入的固定确认串、完整源码 SHA 和正整数 workflow run ID：

```sh
sudo /opt/combo-dev/bin/combo-dev-reset \
  --confirm=DESTROY-COMBO-PREVIEW-DATA \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --workflow-run-id 123456789
```

重置会先在服务端校验基础清单，再写入持久阻断标记，关闭全部写入者和两个转发器，并删除固定任务与基础控制器。它不会删除或改绑三个静态 PV/PVC，而是在再次验证独立挂载和规范路径后清空三个固定数据目录，证明目录为空，恢复精确所有权，轮换开发会话凭据，再重建基础服务。PostgreSQL 使用固定镜像内真实的 UID/GID `70:70` 创建 `pgdata` 子目录；旧根目录迁移会先确认子目录为空，写入显式迁移状态，逐项移动并验证普通条目，最后才移动 `PG_VERSION`。任何中断都会保留状态并阻止后续启动。成功重置会把 SHA、run ID、清空时间和重建基础 Pod 的非敏感 UID/时间写入 owner-only 单次回执；紧随其后的部署必须在十五分钟内以相同 SHA 与 run ID 原子消费它。重置结束时应用和四个基础服务全部保持关闭，持久阻断标记只能由后续完整部署清除。
