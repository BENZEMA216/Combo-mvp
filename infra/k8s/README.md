# Combo 单机 k3s 清单

这套清单把生产 Docker Compose 栈中的 PostgreSQL、两个 Redis 实例、MinIO、桶初始化任务、数据库迁移任务和三个业务镜像部署到单节点 k3s（tecent2）。持久卷使用默认可用的 `local-path` 存储类。

三个环境全部在这台主机上，应用使用 in-place 命名：

| 环境       | 应用 namespace  | 基建 namespace                    |
| ---------- | --------------- | --------------------------------- |
| Test       | `combo-test`    | `combo-test`（自己的 foundation） |
| Preview    | `combo-preview` | `combo-foundation`（共享）        |
| Production | `combo-prod`    | `combo-foundation`（共享）        |

Preview 与 Production 共用一套 Postgres、Redis（queue/hot）和 MinIO，放在 `combo-foundation` namespace；Test 有独立的一套 foundation，数据常驻保留。两套 foundation 由 `environments/test-foundation/` 与 `environments/shared-foundation/` 两个 kustomize overlay 定义，复用根目录的 `postgres.yaml`、`redis-queue.yaml`、`redis-hot.yaml`、`minio.yaml` 与 `job-minio-init.yaml`，并把 MinIO Service 收敛为 ClusterIP。

## 应用清单

`api.yaml`、`worker.yaml`、`runtime.yaml`、`web.yaml` 是四个共享业务面的基础清单，引用 `combo-env` Secret（凭证）与 `ghcr-pull`（镜像拉取）并带环境占位符。`release/base/apps/` 与 `release/base/migrate/` 提供发布专用补丁（`envFrom: combo-release` ConfigMap、迁移 PGHOST），`release/overlays/{test,preview,production}/` 按环境设置 namespace。schema v2 的 `release/overlays/test/apps-v2/` 额外加入独立 Agent Gateway 镜像、ClusterIP Service 和两个 hardened Deployment 副本；Preview、Production 与 legacy schema v1 不含该资源。发布渲染由 `scripts/render-env.mjs` 完成，把占位符替换为每环境实际主机名、公开入口与 Secret 名。

所有应用与迁移镜像必须使用 `repository@sha256` 摘要引用，不允许可移动标签。`combo-env` 必须包含 PostgreSQL 管理密码、三个独立应用角色密码、S3、Resend、OTP HMAC 和 LLM 配置。凭据只允许在受信任运维边界原位轮换，不删除重建；现有 helper 尚不生成 VNext Gateway 键，部署前必须另行以不回显方式预置。

### Test-only Agent Gateway

schema v2 Test 清单要求 `POSTGRES_AGENT_API_PASSWORD`、`POSTGRES_AGENT_BROKER_PASSWORD`、`POSTGRES_AGENT_RECONCILER_PASSWORD` 成组存在。Test migration 的三个引用均为 optional，以便旧 Test Secret 在三键全缺时继续迁移并保留 NOLOGIN；部分键存在会由角色 provision 脚本拒绝，三键齐全才原子 provision。Gateway Pod 只读取 `POSTGRES_AGENT_BROKER_PASSWORD`，不读取 API/Reconciler 密码或管理员 `PGPASSWORD`。

四个 compatibility policy 键 `AGENT_GATEWAY_ACCEPTED_WORKER_VERSIONS`、`AGENT_GATEWAY_ACCEPTED_CODEX_RUNTIME_ARTIFACTS`、`AGENT_GATEWAY_ACCEPTED_CODEX_PROTOCOL_SCHEMA_DIGESTS`、`AGENT_GATEWAY_ACCEPTED_ISOLATION_MODES` 必须是应用契约接受的非空 JSON 数组；缺键会让 Pod fail closed。publisher 显式为 false，publisher Deployment allowlist 可缺；未来打开 publisher 时必须同时提供非空的 `AGENT_GATEWAY_PUBLISHER_DEPLOYMENT_ALLOWLIST`。Service 仅暴露集群内 3300 WebSocket，3301 只供 Pod `/health` 与 `/ready` 探针，Preview/Production 不创建 Gateway Service 或 Deployment。

### Test-only visible transcript keyring

`release/overlays/test/apps/` 只给 Test Runtime 配置 `test-k8s-secret-file`，并把 `combo-visible-transcript-test-keyring` Secret 的 `keyring.json` 以 `0400`、`readOnly: true` 挂载到 `/var/run/secrets/combo/visible-transcript/keyring.json`。Secret 引用是 optional，且公开 flag 在清单中显式保持 false：未开始 VNext 联调时 Pod 可以没有该 Secret，Runtime 也执行零 keyring 读取；如果未来只在 Test 临时打开公开 flag，缺失或不合法 keyring 会让 `/ready` 返回 503，fresh create 同样失败关闭。

仓库不包含 Secret resource、生成命令或任何 key 值。由受信任的 Test 运维边界预置的文件必须是严格 JSON：顶层 `protocol` 为 `combo.visible-transcript-test-keyring/1`，包含匹配配置的 `keyNamespace`、十进制字符串 `activeKeyVersion`，以及最多 16 个唯一的 `keys`；每项包含唯一 `keyId`、`keyVersion`、允许 prefix 内的 `keyRef` 和无 padding 的 canonical 32-byte `keyBase64Url`。轮换通过新增 immutable version 并原子切换 active version 完成，active version 不得低于部署 policy。

Preview 和 Production overlay 不配置 provider、keyring path 或 volume。这个 Test Secret 文件 adapter 会让 root key 进入 Runtime 内存，因此不是 production KMS，也不是真实腾讯云 provider。生产方案必须由外部 authority 在不导出 raw key 的前提下完成 domain-separated HMAC，并通过真实腾讯云凭据 contract test；在能力选择和验证完成前保持 BLOCKED。

## 可选 Sandbox Tools

`overlays/sandbox-tools/` 保存模型文件与命令工具的可选清单。部署脚本与 workflow 都不引用该目录。普通可选入口包含四个固定 Local PV/PVC、四 Pod 配额、受限的 Pod 与现有 PVC 管理权限和默认拒绝网络。`overlays/sandbox-tools-fifth-slot/` 是独立的第五槽维护入口。`overlays/sandbox-tools/maintenance/runtimeclass-gvisor.yaml` 只是未引用的维护样例。仓库不会安装 runsc、重启 k3s 或自动应用任何沙箱资源。`pnpm -F @cb/infra test` 只做本地静态渲染和断言，不能替代 gVisor、Local PV 或 NetworkPolicy 的现场验证。

## 发布顺序

`.github/workflows/deploy.yml` 统一处理三环境部署。`render-env.mjs` 按环境渲染 foundation / migrate / apps 三份清单，`deploy-env.sh` 在主机上依次执行：确保 foundation 就绪（不重建）、跑迁移 Job（幂等，per-foundation 锁串行）、应用应用清单并等待 rollout。Test 每次只更新应用，基础实例常驻、数据保留。Preview 与 Production 的应用 rollout 互不阻塞，共享 foundation 的迁移串行执行。

## 日常更新

Production 不随 `main` 自动更新。Preview 与 Production 都只消费已通过对应前置检查的 `combo-build-<SHA>` 构建清单与摘要镜像；服务器上的 `kubectl apply`、Kustomize 镜像改写或 Nginx 热改都不是正式发布入口。Secret、TLS、namespace 和无关资源始终不在部署删除范围。

## 当前生产状态与流量拓扑

系统 Nginx 只反向代理到 systemd 单元维护的 IPv4 loopback 端口。Test Web `18083` / S3 `19003`，Preview Web `18081` / MinIO `19001`，Production Web `18082` / MinIO `19002`；Preview/Production 的 MinIO forwarder 都指向 `combo-foundation` 的 `minio` Service。Kubernetes Service 保持 ClusterIP，公网不暴露 NodePort。forwarder 单元模板在 `infra/host/release/`。

观测栈部署在 `observability` 命名空间，用 Helm 单独安装与升级，配置和安装说明在 `observability/` 子目录；业务三进程的 OTLP 上报地址已写进各自清单的环境变量。Grafana 在节点的 30300 端口。
