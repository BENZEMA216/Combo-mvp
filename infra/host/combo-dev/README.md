# combo-dev 主机准备

combo-dev 只复用 `combo-preview` 命名空间。主机所有者必须确认该命名空间是唯一的开发预览环境，并明确批准其中数据可丢弃。若数据不能丢弃，应停止实施并另行制定备份恢复方案。

## 主机外部前置条件

共享 k3s 只能依赖生产需要的父数据盘 `/home/xingzheng/data`，其 systemd 单元必须声明 `RequiresMountsFor=/home/xingzheng/data`。该单元不得依赖开发专用挂载 `/home/xingzheng/data/combo-dev`，也不得依赖这个路径下的任何子路径。主机所有者必须通过受控重启证明父数据盘缺失时 k3s 不启动，并证明只有开发挂载缺失时 k3s 仍能启动生产命名空间。验证完成后，owner-only 文件 `/etc/combo-dev/data-mount-reboot.approved` 必须写成固定状态 `controlled-reboot=parent-data-mount-pass`。

combo-dev 的业务持久数据只能写入 `/home/xingzheng/data/combo-dev`。该路径必须是单独挂载的读写文件系统，挂载源必须不同于父数据盘，挂载选项必须包含 `nodev` 和 `nosuid`，总容量不得小于 16 GiB 或大于 18 GiB。这个固定大小的文件系统是硬容量边界，不能用普通目录或 PVC 请求容量代替。主机所有者必须在确认挂载真实生效后创建 root-owned 且非 root 不可写的 `/home/xingzheng/data/combo-dev/.combo-dev-mounted`，文件内容必须是 `combo-dev-storage-mount=v1`。bootstrap 会在这个挂载内创建 PostgreSQL、队列 Redis 和 MinIO 的固定数据目录及独立标记，并在暴露任何 PV 前设置精确所有权。主机准备阶段不得在未挂载状态下预建这三个卷根目录。静态本地 PV 只接受预先存在的路径，不会创建父数据盘或根盘回退目录；所有 Pod 只挂载 PVC，不挂载主机哨兵。`/etc/combo-dev/storage-pool.approved` 必须写成固定状态 `combo-dev-storage=dedicated-hard-18GiB-max`。

`/home/xingzheng/data` 的直接父目录不是 root 独占边界，因此 Combo 不把它下面的普通路径直接作为运行时可信路径。主机所有者先把数据盘 UUID 固定到 root-only `/etc/combo-dev/data-mount.identity`，再把数据盘上的 root-owned `/home/xingzheng/data/combo-host` bind 到 root-owned canonical anchor `/var/lib/combo-host-data`。`combo-host-data-mount-check` 每次验证 UUID、独立设备、精确 FSROOT、source/anchor inode、权限和 sentinel；任何消费者都必须依赖该 checker。即使普通用户改名或替换 `/home/xingzheng/data` 下的路径，已经固定的 anchor 不会跟随替换，checker 也会在下一次操作时 fail closed。

部署包、release、部署工作区等可增长的控制面数据使用另一块 4 GiB 有界文件系统。它的 backing file 通过 canonical path `/var/lib/combo-host-data/control-state.img` 使用，物理文件位于数据盘 `/home/xingzheng/data/combo-host/control-state.img`，规范挂载点为 `/opt/combo-dev/state`，并使用 `nodev`、`nosuid` 和 `noexec`。挂载内固定包含 `incoming`、`releases`、`releases/.staging`、`work` 和 `evidence`；旧的 `/opt/combo-dev/incoming` 与 `/opt/combo-dev/releases` 只是兼容 bind mount，物理数据不再落在根盘。主挂载、两个 bind mount、backing file、哨兵、目录身份或容量任何一项不符时，bootstrap、reset、deploy 和持续守卫都会 fail closed，不能在根盘自动创建同名回退目录。`/opt/combo-dev/bin`、`/etc/combo-dev`、`/run` 锁和 `/var/lib/combo-dev` 中少量失败标记继续留在根盘。

主机必须有独立审核的 Pod 到节点边界。该边界可以由 CNI 主机端点策略或 nftables 实现，但必须实际阻断 `combo-preview` Pod 到节点管理端口、Kubernetes 控制面和生产 NodePort 的流量，不能把同节点 NetworkPolicy 当作证明。主机所有者必须把只读检查器安装到 `/opt/combo-dev/host-boundary/check`。该文件必须归 root 所有、不可被非 root 修改，并在执行 `--check` 时只用退出码表示边界是否生效。通过后，owner-only 文件 `/etc/combo-dev/host-network-boundary.approved` 必须写成固定状态 `combo-dev-host-boundary=audited-and-active`。bootstrap、部署和网络 canary 都会再次验证这项控制。

k3s 的真实数据目录必须写入 owner-only 文件 `/etc/combo-dev/k3s-data-dir`。内容是数据盘内的绝对规范路径，不是 TLS 子目录。bootstrap 只从该目录下的 `server/tls/client-ca.crt` 和 `client-ca.key` 签发客户端证书；API 服务端信任根从展平后的管理 kubeconfig 读取。这样不会把客户端 CA 错当成服务端 CA，也不依赖标准安装路径。

主机必须用原生 journald 或 syslog 配置限制日志占用，不能用 Docker 清理代替根盘治理。bootstrap 继续把既有受控策略 `infra/host/combo-dev/combo-host-syslog` 安装为 `/etc/logrotate.d/combo-host-syslog`：只管理 `/var/log/messages`、`secure`、`cron`、`maillog` 和 `spooler`，单文件达到 256 MiB 时轮转，保留 7 份并压缩，轮转后向 `rsyslog.service` 发送 HUP。验证完成后，owner-only 文件 `/etc/combo-dev/journal-retention.approved` 必须写成固定状态 `journald=native-retention-bounded`。本 PR 不改变现有日志保留策略，也不执行首次日志治理。

部署容量只由父数据盘、4 GiB 控制状态盘和 18 GiB 业务存储池决定。控制状态盘必须保留至少 1 GiB 和 4096 inode，业务存储池继续保留至少 1 GiB 和 4096 inode。父数据盘低于 `max(30 GiB, 15%)` 时只告警，低于 `max(20 GiB, 10%)` 时阻断 Test 写入。根盘不再使用 45/40 GiB 部署阈值，而是作为独立 OS 健康边界：低于 `max(20 GiB, 15%)` 时只告警，低于 `max(10 GiB, 10%)` 时关闭并阻断 `combo-preview` 写入者。根盘和父数据盘的 inode 使用相同比例。健康恢复到告警水位以上持续十五分钟后只清除容量低水位状态，不自动恢复工作负载；下一次受信任部署才能解除持久写入阻断。

所有受限 sudo 入口必须使用包含 `/usr/local/bin` 的固定 `secure_path`。仓库内的 root 脚本也会主动把 `PATH` 固定为 `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`，不会继承调用者路径。

## 开发专用配置

`/etc/combo-dev/combo-dev.env` 必须归 root 所有且权限为 `0600`。它保存 PostgreSQL 管理身份、互不相同的 `POSTGRES_API_PASSWORD`、`POSTGRES_WORKER_PASSWORD`、`POSTGRES_RUNTIME_PASSWORD`，MinIO 配置，`S3_PUBLIC_ENDPOINT`，`RESEND_API_KEY`、`OTP_HMAC_SECRET` 和 LLM 配置。MinIO 管理身份必须与应用存储身份不同。Test 使用生产式邮箱 OTP，不创建 `combo-dev-session`，也不接受任何 Logto 配置。

`/etc/combo-dev/registry.json` 必须归 root 所有且权限为 `0600`，只包含 `ghcr.io` 的开发只读拉取身份。`/etc/combo-dev/production-observer.kubeconfig` 必须使用单一嵌入式客户端证书，并与本机审核凭据使用完全相同的 API 服务端和证书颁发机构。该身份只能在生产命名空间对 Deployment、StatefulSet、Service、PVC 和 Pod 执行 `get`、`list` 与 `watch`。bootstrap、部署和重置会解析全部命名空间的有效规则与关联绑定，拒绝通配符、Secret 读取、任何持久变更权限、生产命名空间之外的资源权限和额外集群资源权限。Kubernetes 为已认证身份提供的不落盘自省请求与只读发现端点是唯一例外。

部署 SSH 用户不得持有 Kubernetes 凭据。它只能向带粘滞位且不可列目录的 `/opt/combo-dev/incoming` 投递文件，并通过受限 sudo 规则调用固定的 root-owned 调度器。GitHub 的 `combo-dev` Environment 必须只允许 `main`，不得配置部署审核人；开发 SSH 和 Resend 验收材料只能保存在该 Environment 中。这项分支策略保护的是读取 Secret 的受信任控制器，不是 Test 候选源码：Test 不由 PR 或 `main` 自动触发，具有仓库写入权限的成员只能从 `main` 上的 `workflow_dispatch` 控制器选择一个仍开放的同仓库 PR 及其当时的精确 tip SHA。PR 的 base 分支、base SHA 及候选与控制器的祖先关系都不构成 Test 授权条件。

手工 PR 路径会在启动时验证触发者和重新运行者权限、受信任控制器、PR 开放状态、同仓库归属、分支 tip 与完整 SHA，然后调用已冻结控制器定义的可复用 Main CD 为候选 SHA 构建不可变 artifact；候选分支的 workflow、部署脚本和验收脚本不会在受保护 Environment 中执行。后续步骤会继续复验 PR 开放状态和同仓库归属，并锁定启动时的 controller SHA、候选 SHA、workflow run、run attempt 和 artifact 身份。`main` 或 PR 分支在构建期间前进不会改变这次快照；PR head 变化只会生成告警，已冻结的完整 SHA 仍会继续部署。它还会复验 release manifest、Web asset manifest、迁移头、三个镜像摘要和完整文件集。远端 bundle、reset proof、migration proof 和环境证据均绑定 Test workflow 的完整 SHA、run ID 与 run attempt；只有同一三元组才能被原子消费。上传的 `combo-branch-test-evidence-*` 只用于该 PR 的 Test 验证，不能进入 Preview 或 Production。Test、Preview 与 Production 共用 `cd-tecent2` 并发组，后触发的部署必须排队。

每次受保护 Test 在上传 bundle 和执行破坏性 reset 之前，都会先运行：

```sh
sudo -n /opt/combo-dev/bin/combo-dev-reset \
  --prepare-capacity \
  --incoming-bytes "$ARCHIVE_BYTES"
```

只有远端 reset 与 deploy 都成功后，workflow 才设置 `deployment_completed` 输出并启用后置 attempt fence。上传、权限复验或 reset/deploy 前置拒绝不会覆盖既有的 `external-fence=system`；已经进入主机变更后的失败由 root-owned reset/deploy trap 收敛。trap 会独立尝试停止转发器、关闭写入者和复核完整 inventory；deploy trap 还会先删除本次三元组尚未消费或已经消费的两种 reset proof。只有 proof 清理成功，且 Deployment、StatefulSet、ReplicaSet、ReplicationController 和 Pod 都已归零并证明不存在 DaemonSet、Job、CronJob 或 HPA 后，才会原子记录本次 SHA/run/attempt 的成对恢复能力；下一次不同 workflow attempt 必须从破坏性 reset 重新开始。无法完整证明收敛，或遇到 system、损坏、软链接和身份不匹配标记时，继续要求主机所有者介入。部署成功但 runner 未确认输出的极小 ACK 窗口由两小时 `acceptance-pending` 定时收敛。

这个模式持有与 reset/deploy 相同的主机排他锁，但始终保持应用数据面和写入者不变。workflow 会把本次 archive 的精确字节数传入，远端同时验证 archive 不超过 512 MiB，并在任何 Test 变更前为 incoming 与受信 work 两份 archive、512 MiB 日志上限、128 MiB 解压与验收开销和最终至少 1 GiB 水位预留空间。容量准备继续调用既有 `systemd-tmpfiles-clean.service` 与受控 syslog 轮转，并只删除控制状态盘中当前版本和最近回滚版本之外的旧 Test release，以及超过两天且名称精确匹配 Test workflow attempt 的普通 incoming 文件。它不会直接通配删除 `/tmp`，也不会清理 Kubernetes volume、Docker/containerd 镜像、容器或任何生产目录。挂载契约、原生 tmpfiles、release 树、incoming、日志策略或实际数据盘水位异常都会在 upload 和破坏性 reset 之前 fail closed。

首次启用控制状态盘时不能直接运行新版 workflow；合并后的第一次手工 Test 会在主机迁移完成前按设计 fail closed，不能作为部署证据。主机所有者必须先排空 `cd-tecent2`，从 root-owned、完整祖先均不可被非 root 写入且对应精确 `main` 的审核快照，先安装新版 `combo-dev-storage-guard`（以及同快照的 production safety helper），然后执行 `sudo /opt/combo-dev/bin/combo-dev-storage-guard --fence-host-maintenance`。该固定模式不读取 control-state，会停止两个转发器、写入 owner-only fence，并使用最小 fencer 凭据把 Test 固定写入者缩到零且验证终态；命令没有 PASS 时不得继续。随后还必须验证 `/var/lib/combo-dev/writers-fenced` 为 `root:root 0600` 且两个 forwarder 均为 inactive。

在上述 fence 已被证明后，主机所有者先从同一审核快照运行 `combo-host-prepare-data-anchor.sh --confirm=PREPARE-COMBO-HOST-DATA-ANCHOR`。该命令只建立 UUID 身份、root-owned source、canonical bind、checker 与两个 systemd unit；不会改动 Test 数据或启动应用。它没有输出 PASS 时不得继续。随后把 `combo-dev-prepare-control-state.sh` 安装为 `/opt/combo-dev/bin/combo-dev-prepare-control-state`，再把 `opt-combo\x2ddev-state.mount`、`opt-combo\x2ddev-incoming.mount`、`opt-combo\x2ddev-releases.mount` 与 `var-lib-combo\x2ddev-evidence.mount` 原样安装到 `/etc/systemd/system/`。这些 state unit 此时只安装，不能手工启动。持有固定确认串运行准备脚本；它会再次验证 canonical anchor，取得与 deploy/reset 相同的锁，先证明分配精确 4 GiB 后父数据盘仍高于 Critical 水位，再逐树校验旧 incoming、releases 和 evidence，建立主挂载及兼容 bind mount，并把旧根盘目录改名保留为回滚副本。任何失败都会先验证所有新挂载确已停止，才尝试用持久摘要恢复旧树；无法证明时会保留旧树、副本和摘要供人工恢复。任何旧副本都不得在同一窗口删除。

控制状态准备成功后、执行 bootstrap 之前，必须先从同一份 root-owned 精确 `main` 审核快照运行 `combo-dev-prepare-public-domain.sh --confirm=PREPARE-COMBO-DEV-PUBLIC-DOMAIN`。只有域名、Nginx、TLS 和 Certbot 续期契约全部输出 PASS 后，才能从同一快照执行 bootstrap，安装新版 controller 和主机日志策略。这个顺序是首次安装契约：bootstrap 会在任何变更前反向验证公网配置，因此不得先运行 bootstrap。旧 controller 的工作目录在根盘，不能在状态盘切换后继续执行新部署。

首次准备和控制文件升级时，主机所有者必须先把相关脚本、主机文件和 combo-dev 覆盖层复制到 root-owned 且非 root 不可写的审核快照中，再从该快照执行：

```sh
sudo bash scripts/combo-dev-bootstrap.sh \
  --approve-disposable-preview-data \
  --approve-development-only-credentials
```

bootstrap 会先完成主机、配置、生产观察身份、生产指纹、节点身份、静态存储现状和集群级期望对象的全部只读检查。随后它先写入持久阻断标记，停止并验证两个回环转发器，再动态列出并关闭命名空间内全部 Deployment、StatefulSet、ReplicaSet、ReplicationController、DaemonSet、HPA、Job、CronJob 和独立 Pod，不只处理新版清单中的固定名称。完成这三步后，它才会清理命名空间、创建固定数据目录或应用平台对象。若现有 Cloud Review 使用固定名称的三份旧 `local-path` PVC，bootstrap 会核对 PVC UID、PV 绑定、本地路径和回收策略，只在三卷完整匹配时删除已批准可丢弃的数据，并等待旧 PV 与目录消失；额外、部分或漂移的存储状态会直接阻断。提交新的 safe-idle 前，bootstrap 还会严格枚举并清空全部合法的 reset proof；异常名称、链接、目录、所有权、权限或硬链接都会保持普通阻断并要求主机所有者处理，不能把旧 proof 带入新的安全空闲 epoch。任何命名空间、旧存储清理、RBAC、静态卷、Secret 或凭据步骤失败时，退出清理都会再次写入阻断标记并验证全部写入者关闭。

普通调度证书有效期为 90 天，剩余 30 天以内时 bootstrap 会轮换证书；部署、重置和定时守卫要求它至少还可用 7 天。独立失败收敛证书有效期为 365 天，剩余 90 天以内时 bootstrap 会轮换证书，定时守卫在剩余 30 天时先关闭写入者。失败收敛身份只能读取和缩容八个固定控制器、删除三个固定任务及其 Pod，不能创建工作负载、列举控制器、读取 Secret 或修改生产。bootstrap 会把 Namespace、ClusterRole、ClusterRoleBinding、StorageClass 和三个静态 PV 的规范化期望内容写入 owner-only 契约文件。部署、smoke 和重置会对这些对象执行完整规范比较。覆盖层、命名空间、RBAC、StorageClass、静态卷清单或控制脚本发生变化都会改变控制摘要，并强制主机所有者重新运行 bootstrap。bootstrap 不会启动应用或回环转发器；它只在写入者为零、转发器关闭且生产指纹不变后，把持久标记提交为 `combo-dev-writers=safe-idle-v1`。部署必须先原子消费这个安全空闲状态并将其降级为普通失败阻断，完整部署成功后才删除标记。

## 独立存储守卫

`combo-dev-bounded` StorageClass 使用 Kubernetes 内置的静态本地卷模式。三个 PV 分别固定到 `/home/xingzheng/data/combo-dev/postgres`、`/home/xingzheng/data/combo-dev/redis-queue` 和 `/home/xingzheng/data/combo-dev/minio`，回收策略为 `Retain`。每个 PV 根目录归 root 所有，并包含只读卷标记和 `data` 子目录。PostgreSQL 的 `data` 目录必须保持 `70:70` 和 `0700`，队列 Redis 的 `data` 目录必须保持 `999:1000` 和 `0700`，MinIO 的 `data` 目录必须保持 `1000:1000` 和 `0700`。数据容器只通过 PVC 挂载 `data` 子目录，并在启动业务进程前读取同一 PVC 中的固定标记。

部署和 smoke 会验证静态 StorageClass、固定 PV 名称、PVC 预绑定、本地规范路径、节点亲和性和主机挂载。`combo-dev-storage-guard.service` 不带凭据文件存在条件，因此定时器每次都会真正执行。检查内容包括业务存储池、控制状态盘及其兼容 bind mount、三个卷标记、目录身份、k3s 挂载依赖、根盘与父数据盘健康水位、可用字节、inode、持久失败标记、普通调度凭据和独立失败收敛凭据。

普通调度凭据缺失、格式错误、过期或权限漂移时，守卫会在持有转发器状态锁期间先原子发布 writers 与 external 阻断，再删除全部租约和公网发布标记并停止、验证四个回环转发器，最后使用独立最小凭据删除固定任务、缩容固定控制器，并用普通调度身份复核命名空间完整动态 writer inventory。即使主机侧阻断或转发器停止失败，Kubernetes 最小收敛仍会独立尝试；任何非固定控制器、活动 Pod 或不可读 inventory 仍存在时都不会报告 PASS，持久阻断和已关闭的转发器继续保留给主机所有者处置。这样新租约无法插入“服务已停、标记未写”的窗口。存储与挂载失败也使用同一路径。只有 owner-only、内容精确的安全空闲标记，同时满足没有外部阻断、没有待验收或公网发布状态、四个转发器关闭和实际写入者为零，周期守卫才会保持该状态而不升级为 `external-fence=system`；普通值、未知值、错误权限、硬链接和软链接都继续失败收敛。external 单独存在而 writers 缺失也会立即重新建立普通阻断并收敛，转发租约在 writers 或 external 任一阻断存在时都不能启动服务。MinIO 的四个开发桶各有 1 GiB 配额，队列 Redis 也有内存上限；这些服务级限制不能替代独立文件系统硬边界。

## 私有租约与公网发布

`combo-dev-web-forward.service` 和 `combo-dev-s3-forward.service` 分别把私有 Web、MinIO Service 转发到 `127.0.0.1:18080` 与 `127.0.0.1:19000`，只服务部署 smoke 和 SSH 调试。`combo-dev-public-web-forward.service` 和 `combo-dev-public-s3-forward.service` 分别把相同 Service 转发到 `127.0.0.1:18083` 与 `127.0.0.1:19003`，由 Host Nginx 暴露为 `https://test.43-160-242-46.sslip.io` 与 `https://test-s3.43-160-242-46.sslip.io`。四个单元都没有 `[Install]` 段；私有单元不自动重启，公网单元只在已发布状态中使用 `Restart=on-failure`。每个固定端口只能存在一个归对应 systemd 主进程所有的 `127.0.0.1` 监听项。

开发者使用 `scripts/combo-dev-connect.sh` 时，远端 `/opt/combo-dev/bin/combo-dev-forwarder-lease` 会为该 SSH 会话持有共享操作锁和独立租约。多个开发者可以同时持有租约，一个会话退出只释放自己的租约，最后一个会话退出只停止两个私有转发器，不得触碰公网单元。部署、重置和 bootstrap 持有同一把排他锁，因此会拒绝新的开发连接；只要仍有开发租约，它们也不会开始。

部署基础 smoke 完成后只写入精确 SHA、workflow run 与 attempt 的两小时待验收标记，四个转发器仍保持关闭。受保护 workflow 随后调用 root-owned `combo-dev-publication --open-pending`；控制器按 operation、fence、forwarder-state 的锁序核对待验收标记、当前 release symlink、实际 Deployment release metadata 和公网监听身份，才启动两个公网单元。六区验收和对象存储探针成功后，`combo-dev-storage-guard --complete-acceptance` 先原子提交 `/var/lib/combo-dev/publication`，再清除待验收标记。周期守卫只在该标记与 live release 完全一致时保持或在重启后恢复公网单元。下一次 reset、bootstrap、失败隔离或 Critical 存储事件会先撤销合法发布标记并停止公网入口；损坏或身份漂移的标记不会被静默删除。

部署 SSH 身份必须在主机策略中被显式授权以非交互方式运行 root-owned `combo-dev-reset`、`combo-dev-deploy`、`combo-dev-publication --open-pending`、`combo-dev-public-s3-smoke`、`combo-dev-storage-guard --fence-only` 和 `--complete-acceptance`。如果主机使用 sudo 命令白名单，必须在启用新 workflow 前将新的 publication 与 S3 smoke 命令形状加入白名单；不得授权执行候选 PR 携带的任意脚本。workflow 全部使用 `sudo -n`，权限缺失会在公网入口开放前 fail closed。

Host Nginx 只反代两个公网回环端口，上游关闭时返回固定 503。S3 vhost 关闭 access log 和 request URI 日志，Web 只记录不含路径与查询串的安全字段。ACME HTTP-01 challenge 固定使用 Nginx worker 可穿越的专用 `/var/www/combo-dev-acme`，证书状态继续由 Certbot 保存在 `/etc/letsencrypt`。准备脚本会在 Nginx reload 后进行有界重试，确认两个固定域名都能从回环地址取回随机路径的精确预检内容，再允许 Certbot 发起签发。主机所有者从精确 root-owned 审核快照运行 `combo-dev-prepare-public-domain.sh --confirm=PREPARE-COMBO-DEV-PUBLIC-DOMAIN`，以受控 CAS 方式安装 vhost、申请包含两个域名的 `combo-dev-test` 证书并安装 Certbot deploy hook。续期由现有 `certbot-renew.timer` 驱动，hook 只在 `nginx -t` 成功后 reload。

## 基础设施与六区验收

root-owned `combo-dev-smoke` 只负责主机和集群基础设施真实性：回环监听者、八个稳态工作负载、静态存储、资源上限、私有 Service、NetworkPolicy、健康与精确 Origin、网络 canary，以及当前窗口日志覆盖和凭据泄漏扫描。部署内的基线日志检查要求 API/Runtime 合成活动，但允许空数据 Worker 尚未产生 pipeline；不可变 artifact 完成真实流程后，同一 smoke 的后置模式会在转发租约仍有效时重新扫描八个来源，并强制要求 API、Runtime 与 Worker 的真实活动。它不执行登录或产品流程，也不读取 Resend full-access key。旧 `/opt/combo-dev/acceptance/run` 和 `product-flow.js` 不再属于 Test 准入链，不得通过恢复 dev-login、注入 Session 或向主机持久化验收 key 来兼容它们。

基础设施 gate 通过后，受保护的 Test workflow 使用受信任 `main` 控制器固定的 `live-browser-acceptance.mjs`、`resend-sent-email.mjs` 和精确 Playwright 依赖，在 tecent2 使用已安装的 Chrome 对唯一入口 `https://test.43-160-242-46.sslip.io` 运行完整六区验收。root-owned `combo-dev-public-s3-smoke` 会在不输出凭据、签名或完整 URL 的前提下，通过 `https://test-s3.43-160-242-46.sslip.io` 执行有界的短时 SigV4 PUT、GET、内容校验与 DELETE，workflow 另行验证对象存储健康与精确 CORS。候选分支只提供经清单验证的应用 artifact，不能替换这些高权限验收程序。该验收独占真实邮箱 OTP、双身份 owner 隔离、Session 持久化与登出，以及 Creation、Authoring、Studio、Runtime 和发布身份的产品判定。Resend full-access key 只由受保护的 GitHub Environment 提供，经标准输入短暂进入验收进程，不写入主机配置、Kubernetes、日志或 evidence。

workflow 使用受信任控制器中的 `scripts/promotion-evidence.mjs` 校验固定检查顺序、完整 release identity、source run/attempt、artifact ID/digest 和 Test workflow run/attempt；只有基础设施 evidence、六区浏览器 evidence、后置日志审计、identity 和上传步骤全部成功，才会生成 attempt-scoped 的 `combo-branch-test-evidence-<SHA>-<Test-attempt>`，并按精确 SHA/run/attempt 完成待验收标记。这个手工 PR Test artifact 只用于当前 PR 验证，不能进入 Preview 或 Production；Preview 直接消费成功 Main CD 的 release artifact。若浏览器返回受控产品失败，workflow 会先用独立 failure schema 验证并上传只含失败 JSON 与 identity 的 run/attempt 唯一 artifact，再显式失败；该 artifact 没有可用于晋级的 `source-release.json`。dispatcher 自身失败时由其 trap 关闭全部写入者；dispatcher 已开始后的端口、浏览器、日志、evidence、上传或完成确认失败时，workflow 调用独立最小 fencer，只关闭 Test 转发器、固定任务与固定控制器，不清数据，也不生成可重放的 reset proof。部署写入的 owner-only 待验收标记最多存活两小时；即使 runner 硬取消导致 workflow 清理未执行，持久 storage guard 也会在期限后收敛。主机状态根 `/var/lib/combo-dev` 固定为 root-owned `0711`：部署 SSH 用户不能列出其中的阻断标记或单次回执，但可以穿越到 `0755` 的 `evidence` 子目录，按已知 SHA/run/attempt 精确读取 `0644` 的脱敏环境证据；其余状态文件继续为 `0600`。远端 runner、依赖包、结果文件和上传临时文件无论成功或失败都会清理。

## 重置

破坏性重置只接受受保护 Test workflow 传入的固定确认串、完整源码 SHA、正整数 workflow run ID 和 run attempt：

```sh
sudo /opt/combo-dev/bin/combo-dev-reset \
  --confirm=DESTROY-COMBO-PREVIEW-DATA \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --workflow-run-id 123456789 \
  --workflow-run-attempt 2
```

重置会先在服务端校验基础清单，并在清空数据之前拒绝 `external-fence=system`、未知写入阻断、损坏标记以及不完整或身份不匹配的待验收状态。为了让失败的 Test 可以安全重试，它只允许消费一组精确的旧 attempt 能力：writers 必须是 owner-only 普通失败标记，external 必须是旧 `attempt <sha> <run> <attempt>`，acceptance-pending 必须具有完全相同的旧三元组，旧三元组不能等于本次 reset，两个转发器和命名空间完整 writer inventory 还必须实际为零。完整 inventory 会接受副本数和状态均为零的 Deployment、StatefulSet、ReplicaSet 与 ReplicationController，以及没有运行容器的终态 Pod；任何 DaemonSet、Job、CronJob、HPA、活动 Pod 或不可读清单都会拒绝恢复。验证和消费在 operation→fence 锁序内完成，先设置本次失败收敛责任并保持普通阻断，再删除两个旧 attempt 标记；system、generic-alone、缺失或不匹配状态仍只能由 bootstrap/主机所有者恢复。进入 mutation 后，reset 会在关闭数据面前以及写入新 proof 前各清空一次严格命名、root-owned、`0600`、单硬链接的 reset proof inventory，确保上一个 workflow attempt 的回执不能跨越新的数据清空 epoch。重置随后关闭两个转发器，删除命名空间内全部控制器、任务和 Pod，并在完整 inventory 复核后才清空数据。它不会删除或改绑三个静态 PV/PVC，而是在再次验证独立挂载和规范路径后清空三个固定数据目录，证明目录为空，恢复精确所有权，轮换开发会话凭据，再重建基础服务。PostgreSQL 使用固定镜像内真实的 UID/GID `70:70` 创建 `pgdata` 子目录；旧根目录迁移会先确认子目录为空，写入显式迁移状态，逐项移动并验证普通条目，最后才移动 `PG_VERSION`。中断后会清空整个 reset proof inventory；只有 proof 清理、转发器关闭和完整 writer inventory 收敛全部成功，才记录可供下一 attempt 消费的精确恢复对，否则保留不可恢复阻断并要求主机所有者介入。前置状态拒绝发生在 mutation 责任建立之前，因此不会误删既有 proof。成功重置会把 SHA、run ID、run attempt、清空时间和重建基础 Pod 的非敏感 UID/时间写入 owner-only 单次回执；紧随其后的部署必须在十五分钟内以相同三元组原子消费 attempt-scoped 回执。重置结束时应用和四个基础服务全部保持关闭，转发器保持关闭，持久标记重新提交为安全空闲状态，等待部署原子消费。
