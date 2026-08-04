# 发布与运维脚本

本目录保存仓库级验证、部署和运维脚本。发布脚本不得输出、落盘、复制或提交任何环境 Secret 值；部署前只允许核对 Secret 名称与键名。需要凭据的步骤只能在对应的受保护 GitHub Environment 中运行。

## 环境拓扑

三个环境全部运行在同一台 tecent2 主机的 k3s 上，应用使用 in-place 命名（无 SHA 前缀）：

| 环境       | 应用 namespace  | 基建 namespace / overlay                                     | 域名                                                                  |
| ---------- | --------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| Test       | `combo-test`    | `combo-test` / `test-foundation`                             | `https://test.43-160-242-46.sslip.io`                                 |
| Preview    | `combo-preview` | `combo-preview-foundation` / `preview-foundation`            | `https://review.43-160-242-46.sslip.io`                               |
| Production | `combo-prod`    | `combo-foundation` / `shared-foundation`（生产专用历史命名） | `https://agora.43-160-242-46.sslip.io` / `https://buildwithcombo.com` |

Test、Preview 与 Production 各有独立的一套 Postgres、Redis（queue/hot）和 MinIO，数据常驻保留，应用通过跨 namespace Service DNS 连接到本环境 foundation。三套 foundation 分别位于 `combo-test`、`combo-preview-foundation` 与 `combo-foundation` namespace，均包含 `postgres`、`redis-queue`、`redis-hot`、`minio` 与 `minio-init` 任务。`shared-foundation` 是 Production overlay 的历史名称，不代表 Preview 与 Production 共享数据面。

## 部署脚本

`render-env.mjs` 按环境渲染 k8s 清单。它读取 canonical 发布清单（`release-manifest.mjs` 生成），把镜像 digest、`combo-release` ConfigMap（release 元数据）和每环境占位符注入应用 overlay。占位符包括 `combo-env`、`ghcr-pull`、`combo-postgres-host`、`combo-public-app-origin`、`combo-session-cookie-secure`，以及 `postgres:5432`、`redis-queue:6379`、`redis-hot:6379`、`minio:9000` 主机名。Test、Preview、Production 的 Postgres/Redis/MinIO 主机分别解析到 `combo-test`、`combo-preview-foundation`、`combo-foundation` 的本环境服务名。支持 `boundary`（仅 Preview）、`foundation`、`migrate`、`apps` 四个 phase；渲染绝不包含 Secret。

`deploy-env.sh` 在主机上执行部署，四个子命令：

- `boundary` —— 仅 Preview 使用；先应用应用侧 egress 与 foundation 侧 ingress 边界，后续 migrate/apps 缺失该边界时直接失败。
- `foundation` —— 确保 foundation namespace 存在、应用 foundation 清单并等待就绪。持环境独立的 per-foundation 锁（`test` / `preview` / `shared`），幂等，不重建不重置。
- `migrate` —— 删除旧迁移 Job 后应用新迁移 Job 并等待完成。持本环境的同一 per-foundation 锁；三个环境的迁移不会访问或锁住其他环境的 foundation。
- `apps` —— 应用应用清单（含 `combo-release` ConfigMap）并等待 rollout。不持 foundation 锁，三环境应用 rollout 互不阻塞。

`deploy-env.sh` 支持 `--render-dir`：workflow 在 runner 上先渲染 YAML，再上传到主机用预渲染文件执行。

Preview 部署会在主机上通过 `$HOME/combo-deploy/bin/bootstrap-preview-foundation.sh --bootstrap` 幂等建立独立数据面，并紧接着运行 `--verify`。脚本生成独立的 PostgreSQL、S3、应用角色与 OTP 凭据，固定 `review-s3` 公开端点，保持 Preview 应用 Secret 与 foundation Secret 的必要键一致，并用真实 SigV4 请求确认 Preview 凭据访问 Production S3 得到 403；值只在进程内存和 `kubectl` stdin 中流转。重复执行不会轮换已建立的 foundation。紧急或手工恢复时也使用主机已安装的同一路径，不能从其他环境复制 Secret。

`verify-preview-boundary.sh` 在迁移前运行两次真实 Pod 探针：先证明 Preview 无法连接 Production 的 PostgreSQL、Redis 与 MinIO，再在独立 foundation 就绪后证明 Preview 可以连接自己的四项依赖。任何探针失败都会让部署保持 502，不启动公开 forwarder。

`release-manifest.mjs` 创建和校验 canonical、不可覆盖的发布清单。清单把一个完整源码 SHA 唯一映射到 API、Runtime、Web 三个 `repository@sha256` 镜像、迁移头和 Web 静态资源摘要。Worker 与 migration 固定使用 API 镜像。

`web-asset-manifest.mjs` 为 Web 与 Runtime Web 的实际构建文件生成严格、确定性的内容摘要清单。正式 CI 从最终 Web 镜像中提取并复验这份清单，而不是从标签或宿主构建目录推断。

## 浏览器验收

`goal-b-test-acceptance.mjs` 是 Test、Preview 和 Production 共用的受控真实浏览器 runner。它使用主机已安装的 Chrome，在对应环境域名上完成任务幂等创建、合法 Claude JSONL 上传与断点恢复、能力勾选和 UI 发布、Studio 多轮与元素选择、Runtime SSE 断线重连和终态 replay、中断 Turn 的服务端失败产物隔离、当前 UI 隔离副本试用以及返回原任务。三个环境都使用 run-scoped Resend 测试别名完成两组独立邮箱 OTP 登录和 owner 隔离。浏览器网络只允许对应应用 origin，Resend 读取由 `resend-sent-email.mjs` 的 Node helper 完成。输出以 `0600` 创建，只保留公开发布身份、资源 UUID、检查状态与计数，不保存邮箱、OTP、Cookie、配对码、分享令牌、凭据或响应正文。

## 部署 workflow

`.github/workflows/deploy.yml` 统一处理三环境部署：

- `workflow_run`：`Release build` 成功后自动部署同一 `main` 修订到 Preview。
- `workflow_dispatch`：手工部署 test（任意同仓库分支或 main）、preview（main 修订），或将已经在 Preview 验证的修订显式晋级到 Production。

`select` job 校验触发源、分支 tip、main 可达性和 Production 晋级门禁，并解析该 SHA 的 `combo-build-<SHA>-<attempt>` 构建清单 artifact；`deploy` job 按环境并发（`combo-deploy-<env>`），在 runner 上渲染 YAML、scp 到主机。Preview 先验证独立 Secret、systemd 与端口，再 fail-closed 执行 boundary、foundation、migrate、apps，最后只在成功后恢复公网 forwarder。分支 Test 通过 `build_branch` job 回调 main 定义的 `ci.yml` 构建不可变 artifact；候选分支的 workflow 与脚本不会在受保护 Environment 中执行。

`deploy.yml` 需要仓库级 Secret：`DEPLOY_SSH_KEY`、`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KNOWN_HOSTS`（SSH 到 tecent2 执行部署），以及可选的 `REVIEW_ACCESS_TOKEN`（Preview 域名校验）。这些 Secret 只被运行在 `main` 上的受信任控制器读取。主机上各 namespace 的 `combo-env`（Postgres/S3/Resend/OTP/LLM 凭证）与 `ghcr-pull`（镜像拉取）Secret 需要预先就位，`deploy-env.sh` 在缺失时直接失败。

## 其他脚本

- `start.sh` / `smoke.sh` / `migrate.sh` / `acceptance-smoke.sh`：本地开发与冒烟。
- `check-production-artifacts.sh`：CI gate，校验生产构建产物不含测试文件、测试邮件基础设施或已废弃认证栈。
- `retire-legacy-auth-secrets.sh`：清理已废弃的 Logto 认证 Secret（历史清理工具）。
- `bootstrap-preview-foundation.sh`：一次性建立并验证 Preview 独立数据面凭据，不复制或输出 Production Secret。
- `scripts/integration/`：CI 集成测试脚本。
