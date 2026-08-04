# Combo 单机 k3s 清单

这套清单把生产 Docker Compose 栈中的 PostgreSQL、两个 Redis 实例、MinIO、桶初始化任务、数据库迁移任务和三个业务镜像部署到单节点 k3s（tecent2）。持久卷使用默认可用的 `local-path` 存储类。

三个环境全部在这台主机上，应用使用 in-place 命名：

| 环境       | 应用 namespace  | 基建 namespace             |
| ---------- | --------------- | -------------------------- |
| Test       | `combo-test`    | `combo-test`               |
| Preview    | `combo-preview` | `combo-preview-foundation` |
| Production | `combo-prod`    | `combo-foundation`         |

Test、Preview 与 Production 各有独立的一套 Postgres、Redis（queue/hot）和 MinIO，数据常驻保留。Preview 使用独立凭据；`preview/boundary` 在 workload 前阻断 Preview 应用与 foundation 对其他集群私网数据面的访问，只放行本环境内部依赖、DNS、OTEL 与必要公网。三套 foundation 由 `environments/test-foundation/`、`environments/preview-foundation/` 与 `environments/shared-foundation/` 三个 kustomize overlay 定义；`shared-foundation` 是 Production overlay 的历史名称。它们复用根目录的 `postgres.yaml`、`redis-queue.yaml`、`redis-hot.yaml`、`minio.yaml` 与 `job-minio-init.yaml`，并把 MinIO Service 收敛为 ClusterIP。

## 应用清单

`api.yaml`、`worker.yaml`、`runtime.yaml`、`web.yaml` 是四业务面的基础清单，引用 `combo-env` Secret（凭证）与 `ghcr-pull`（镜像拉取）并带环境占位符。`release/base/apps/` 与 `release/base/migrate/` 提供发布专用补丁（`envFrom: combo-release` ConfigMap、迁移 PGHOST），`release/overlays/{test,preview,production}/` 按环境设置 namespace。发布渲染由 `scripts/render-env.mjs` 完成，把占位符替换为每环境实际主机名、公开入口与 Secret 名。

所有应用与迁移镜像必须使用 `repository@sha256` 摘要引用，不允许可移动标签。`combo-env` 必须包含 PostgreSQL 管理密码、三个独立应用角色密码、S3、Resend、OTP HMAC 和 LLM 配置。Preview 首次隔离使用 `scripts/bootstrap-preview-foundation.sh --bootstrap` 建立配对且区别于 Production 的应用 / foundation Secret；日常认证凭据通过 `scripts/configure-first-party-auth-secrets.sh` 原位轮换，不删除重建。

## 可选 Sandbox Tools

`overlays/sandbox-tools/` 保存模型文件与命令工具的可选清单。根 `kustomization.yaml`、部署脚本与 workflow 都不引用该目录。普通可选入口包含四个固定 Local PV/PVC、四 Pod 配额、受限的 Pod 与现有 PVC 管理权限和默认拒绝网络。`overlays/sandbox-tools-fifth-slot/` 是独立的第五槽维护入口。`overlays/sandbox-tools/maintenance/runtimeclass-gvisor.yaml` 只是未引用的维护样例。仓库不会安装 runsc、重启 k3s 或自动应用任何沙箱资源。`pnpm -F @cb/infra test` 只做本地静态渲染和断言，不能替代 gVisor、Local PV 或 NetworkPolicy 的现场验证。

## 发布顺序

`.github/workflows/deploy.yml` 统一处理三环境部署。Preview 先执行 boundary，再依次确保 foundation 就绪、跑迁移 Job、应用应用清单并等待 rollout；migrate/apps 缺少边界时失败关闭。三套基础实例均常驻、数据保留；Test、Preview 与 Production 的应用 rollout 和 foundation 锁互不干扰。

## 日常更新

Production 不随 `main` 自动更新。Preview 与 Production 都只消费已通过对应前置检查的 `combo-build-<SHA>` 构建清单与摘要镜像；服务器上的 `kubectl apply`、Kustomize 镜像改写或 Nginx 热改都不是正式发布入口。Secret、TLS、namespace 和无关资源始终不在部署删除范围。

## 当前生产状态与流量拓扑

系统 Nginx 只反向代理到 systemd 单元维护的 IPv4 loopback 端口。Test Web `18083` / S3 `19003`，Preview Web `18081` / MinIO `19001`，Production Web `18082` / MinIO `19002`；Preview MinIO forwarder 指向 `combo-preview-foundation`，Production MinIO forwarder 指向 `combo-foundation`。Kubernetes Service 保持 ClusterIP，公网不暴露 NodePort。forwarder 单元模板在 `infra/host/release/`。

观测栈部署在 `observability` 命名空间，用 Helm 单独安装与升级，配置和安装说明在 `observability/` 子目录；业务三进程的 OTLP 上报地址已写进各自清单的环境变量。Grafana 在节点的 30300 端口。
