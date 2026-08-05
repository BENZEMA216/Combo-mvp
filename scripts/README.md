# 发布与运维脚本

本目录保存仓库级验证、部署和运维脚本。发布脚本不得输出、落盘、复制或提交任何环境 Secret 值；部署前只允许核对 Secret 名称与键名。需要凭据的部署步骤只运行在受信任的 `main` 控制器（`deploy.yml`）上，通过仓库级 Secret（`DEPLOY_SSH_KEY`、`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KNOWN_HOSTS`）SSH 到 tecent2 执行；主机侧应用凭证以 k8s `combo-env` 与 `ghcr-pull` Secret 就位。

## 环境拓扑

三个环境全部运行在同一台 tecent2 主机的 k3s 上，应用使用 in-place 命名（无 SHA 前缀）：

| 环境       | 应用 namespace  | 基建                                   | 域名                                                                  |
| ---------- | --------------- | -------------------------------------- | --------------------------------------------------------------------- |
| Test       | `combo-test`    | 自己的 foundation（`test-foundation`） | `https://test.43-160-242-46.sslip.io`                                 |
| Preview    | `combo-preview` | 共享 foundation（`shared-foundation`） | `https://review.43-160-242-46.sslip.io`                               |
| Production | `combo-prod`    | 共享 foundation（`shared-foundation`） | `https://agora.43-160-242-46.sslip.io` / `https://buildwithcombo.com` |

Preview 与 Production 共用一套 Postgres、Redis（queue/hot）和 MinIO，放在 `combo-foundation` namespace，应用跨 namespace 连接；Test 有自己独立的一套 foundation，数据常驻保留。两套 foundation 分别是 `combo-test` 与 `combo-foundation` namespace 内的 `postgres`、`redis-queue`、`redis-hot`、`minio` 与 `minio-init` 任务。

## 部署脚本

`render-env.mjs` 按环境渲染 k8s 清单。它读取 canonical 发布清单（`release-manifest.mjs` 生成），把镜像 digest、`combo-release` ConfigMap（release 元数据）和每环境占位符注入应用 overlay。占位符包括 `combo-env`、`ghcr-pull`、`combo-postgres-host`、`combo-public-app-origin`、`combo-session-cookie-secure`，以及 `postgres:5432`、`redis-queue:6379`、`redis-hot:6379`、`minio:9000` 主机名。Preview/Production 的 Postgres/Redis/MinIO 主机解析为 `combo-foundation` 的跨 namespace 服务名。支持三个 phase：`apps`、`migrate`、`foundation`。渲染结果只含 Service、Deployment、Job 与允许的 ConfigMap，绝不含 Secret。

`deploy-env.sh` 在主机上执行部署，三个子命令：

- `foundation` —— 确保 foundation namespace 存在、应用 foundation 清单并等待就绪。持 per-foundation 锁（`test` / `shared`），幂等，不重建不重置。
- `migrate` —— 删除旧迁移 Job 后应用新迁移 Job 并等待完成。持同一 per-foundation 锁，因此 Preview 与 Production 对共享 foundation 的迁移串行执行。
- `apps` —— 应用应用清单（含 `combo-release` ConfigMap）并等待 rollout。不持共享锁，三环境应用 rollout 互不阻塞。

`deploy-env.sh` 支持 `--render-dir`：workflow 在 runner 上先渲染 YAML，再上传到主机用预渲染文件执行。

`release-manifest.mjs` 创建和校验 canonical、不可覆盖的发布清单。清单把一个完整源码 SHA 唯一映射到 API、Runtime、Web 三个 `repository@sha256` 镜像、迁移头和 Web 静态资源摘要。Worker 与 migration 固定使用 API 镜像。

`web-asset-manifest.mjs` 为 Web 与 Runtime Web 的实际构建文件生成严格、确定性的内容摘要清单。正式 CI 从最终 Web 镜像中提取并复验这份清单，而不是从标签或宿主构建目录推断。

## 部署 workflow

`.github/workflows/deploy.yml` 统一处理三环境部署：

- `workflow_run`：main CI 成功后自动部署 Preview。
- `workflow_dispatch`：手工部署到 test（任意同仓库分支或 main）/ preview / production（main 修订）。

`select` job 校验触发源、分支 tip、main 可达性并解析该 SHA 的 `combo-build-<SHA>-<attempt>` 构建清单 artifact；`deploy` job 按环境并发（`combo-deploy-<env>`），在 runner 上渲染 YAML、scp 到主机，再由主机上的 `deploy-env.sh` 依次执行 foundation、migrate、apps，最后验证环境域名返回该 SHA 的版本元数据。分支 Test 通过 `build_branch` job 回调 main 定义的 `ci.yml` 构建不可变 artifact；候选分支的 workflow 与脚本不会在受保护 Environment 中执行。

`deploy.yml` 需要仓库级 Secret：`DEPLOY_SSH_KEY`、`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KNOWN_HOSTS`（SSH 到 tecent2 执行部署）。这些 Secret 只被运行在 `main` 上的受信任控制器读取。主机上各 namespace 的 `combo-env`（Postgres/S3/Resend/OTP/LLM 凭证）与 `ghcr-pull`（镜像拉取）Secret 需要预先就位，`deploy-env.sh` 在缺失时直接失败。

## 其他脚本

- `start.sh` / `smoke.sh` / `migrate.sh` / `acceptance-smoke.sh`：本地开发与冒烟。
- `check-production-artifacts.sh`：CI gate，校验生产构建产物不含测试文件、测试邮件基础设施或已废弃认证栈。
- `scripts/integration/`：CI 集成测试脚本。
