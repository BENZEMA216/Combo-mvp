# 部署拓扑与规范

本文档定义 Combo 当前服务部署的拓扑结构、角色分工与发布规范。它是仓库内对部署系统的权威说明；任何涉及部署、命名空间、workflow、基础资源的改动都应与本文档一致，不一致时应先改文档再改代码。

## 1. 目标拓扑

三个环境运行在同一台 tecent2 主机的 k3s 集群上，应用使用 in-place 命名（无 SHA 前缀）。命名空间与基础资源归属固定如下：

| 环境       | 应用 namespace  | 基础资源          | 说明                           |
| ---------- | --------------- | ----------------- | ------------------------------ |
| Test       | `combo-test`    | 自己的 foundation | 分支验证沙箱；数据常驻保留     |
| Preview    | `combo-preview` | 共享 foundation   | 只部署 main                    |
| Production | `combo-prod`    | 共享 foundation   | 只部署 preview 验证通过的 main |

基础资源（PostgreSQL、Redis queue、Redis hot、MinIO）只存在两套：

- `combo-test` namespace 内一套，仅 Test 应用使用。
- `combo-foundation` namespace 内一套，**Preview 与 Production 应用共同使用**（跨 namespace 连接）。Preview 不建立独立的基础资源。

这是有意设计：Preview 是 Production 的预发布验证，共享同一套数据与存储可以验证「真实生产数据上的行为」，并且避免维护两套同构基础资源。**不得为 Preview 单独隔离一套 foundation。**

## 2. 三环境角色与晋级链

- **Test**：任意同仓库分支可部署，作为分支验证沙箱。开发者手工触发 `workflow_dispatch` 选择分支及精确 tip SHA 部署到 Test。
- **Preview**：只接受可达 main 的修订。`Release build` 成功后自动部署同一 main 提交；也可手工 `workflow_dispatch`（仅 main 修订）。
- **Production**：只有该修订已经运行在 Preview（Preview 验证通过，即 Preview 域名当前返回该 SHA）且人工显式确认（`confirm_production` 勾选）后才可部署。

晋级方向固定为：分支 → Test，main → Preview，Preview 验证 + 人工确认 → Production。不存在其他晋级路径。

## 3. workflow 清单

| workflow                       | 显示名        | 触发                                  | 作用                                                                                                                                                        |
| ------------------------------ | ------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/pr-ci.yml`  | PR checks     | pull_request                          | 合并前质量门禁：依赖安装、shared 构建、format、lint、typecheck、无容器快速测试、ShellCheck；不构建或发布镜像                                                |
| `.github/workflows/ci.yml`     | Release build | main push、workflow_call              | 全量构建：集成测试、容器契约、三个镜像（api/runtime/web），并发布绑定精确提交 SHA 的不可变 `combo-build-<SHA>-<attempt>` 构建清单；也是分支构建的可复用入口 |
| `.github/workflows/deploy.yml` | Deploy        | Release build 完成、workflow_dispatch | 统一部署三环境，执行晋级链                                                                                                                                  |

`deploy.yml` 的 `workflow_run` 触发器必须引用 `Release build` 显示名；重命名 ci.yml 时需要同步。

`ci.yml` 的并发组名是 `main-cd-*`（main push 时 `main-cd-main`，分支构建时 `main-cd-<revision>`），与 `combo-deploy-<env>` 部署锁互不相交。自动部署只作用于 Preview（main 的 `Release build` 成功后触发）；Test 没有自动触发路径，只接受手工 `workflow_dispatch`。

## 4. 域名

| 环境       | 域名                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Test       | `https://test.43-160-242-46.sslip.io`                                                                                              |
| Preview    | `https://review.43-160-242-46.sslip.io`                                                                                            |
| Production | `https://buildwithcombo.com`（正式）、`https://www.buildwithcombo.com`（别名）、`https://agora.43-160-242-46.sslip.io`（验收入口） |

系统 Nginx 将域名反代到主机回环端口（由 systemd forwarder 维护），Kubernetes Service 保持 ClusterIP，公网不暴露 NodePort。部署验证以环境正式域名为准：Production 验证 `buildwithcombo.com`。

## 5. 锁模型

- **应用 rollout**：每环境一把 GitHub concurrency 锁（`combo-deploy-<env>`），三环境应用部署互不阻塞。
- **基础资源变更**：主机侧 per-foundation flock（`combo-foundation-<test|shared>.lock`）。Preview 与 Production 对共享 foundation 的迁移串行执行。

## 6. 部署机制

`scripts/deploy-env.sh` 在主机上按阶段执行：

- `foundation`：确保 foundation namespace 与资源存在（幂等 apply，不重建不重置）。
- `migrate`：删除旧迁移 Job 后应用新迁移 Job 并等待完成（幂等，per-foundation 锁串行）。
- `apps`：应用应用清单（含 `combo-release` ConfigMap）并等待 rollout。

`scripts/render-env.mjs` 按环境渲染 apps / migrate / foundation 三份清单，替换镜像 digest 与每环境占位符（Secret 名、Postgres/Redis/MinIO 主机、公开入口、Cookie 安全标志）。Preview/Production 的 Postgres/Redis/MinIO 主机解析为 `combo-foundation` 的跨 namespace 服务名。

## 7. 凭证规范

- 各应用 namespace 必须存在 `combo-env` Secret（Postgres/S3/Resend/OTP/LLM 配置）与 `ghcr-pull`（镜像拉取）。
- 共享 foundation（`combo-foundation`）的 Postgres/S3 凭证必须与 `combo-preview`、`combo-prod` 的凭证一致；否则应用无法连接共享数据库。
- 凭证只通过 `scripts/configure-first-party-auth-secrets.sh` 原位轮换，不删除重建；轮换目标是各应用 namespace 的 `combo-env`（test→`combo-test`、preview→`combo-preview`、production→`combo-prod`）。
- 部署脚本不得输出、落盘、复制或提交任何 Secret 值。

## 8. 更新流程

- **控制面（workflow / 部署脚本）**：改动 → PR（PR checks 门禁）→ 合入 main → 对后续触发生效，无需构建镜像。
- **基础资源**：改动清单 → 合入 main → 下次部署时 `deploy-env.sh foundation` 幂等应用；实例常驻不重建，数据保留。
- **应用代码**：改动 → PR → 合入 main → Release build 构建镜像与构建清单 → Deploy 自动部署 Preview → 人工确认后部署 Production。分支验证走 Test。

## 9. 明确约束

1. Preview 不建立独立 foundation；它与 Production 共享 `combo-foundation`。
2. Test 有独立 foundation，数据常驻，不做销毁重建。
3. 生产正式域名是 `buildwithcombo.com`，部署验证以此为准。
4. 三环境应用部署互不阻塞；共享 foundation 的迁移串行。

## 10. combo-v2：V2 架构验证命名空间

`combo-v2` 是 V2 平台架构验证的独立命名空间，与三环境晋级链完全无关：

- 手工部署：代码从本地 rsync 到主机构建，镜像经 `docker save` 加 `k3s ctr images import` 进集群，不经过 GitHub CI/CD，不产生 `combo-build-<SHA>` 构建清单；验证结束后整个命名空间拆除。
- 不得修改、重启或删除三环境与 `combo-foundation`、`kol-agents`、`observability` 的现有资源。经用户明确授权的 V2 升级可以更新 V2 自有 Nginx 文件和 systemd 单元；其他主机配置保持不变。
- 数据按「实例共享、逻辑隔离」：在 `combo-foundation` 的共享 PostgreSQL 实例上新建独立 database `combo_v2`（不动现有 `combo` 库），三个 V2 PostgreSQL 客户端清单把非敏感 `PGDATABASE` 固定为 `combo_v2`，不从 Secret 选择数据库。Redis 复用 `redis-hot` 并用 `authz:v2:` 等 v2 前缀隔离键。正式迁移链保持 `db/migrations/0000` 至当前主线头；V2 runner 只复用其中 `0000` 至 `0011`，再执行 `db/v2-migrations/0012` 至 `0017`，两条 `schema_migrations` 序列互不混用。V2 runner 对迁移前已存在的 canonical API/worker/runtime 三角色只恢复 LOGIN 并保留原密码；V2 自有 `combo_authz`、`combo_billing` 角色绑定 V2 Secret。
- V2 迁移属于停机人工维护操作，只能通过主机侧 `scripts/migrate-v2-host.sh` 执行。先将 V2 四个 Deployment 缩到 0 并确认 Pod 消失，迁移成功后再应用同候选的新应用清单。该入口持有与 Preview/Production 正式迁移相同的 `$HOME/data/combo-foundation-shared.lock`，在锁内清理遗留 Job、确认 V2 writer 已停、以内存比较核对 V2/Preview/Production 三份共享角色 Secret、执行并等待 Job、核对五角色 LOGIN、从 Preview/Production 当前 Pod 建立六条新数据库连接并检查三环境 rollout。Job 超时或进程中断时，入口持续持锁直到 Job/Pod 已删除；任一步失败都不能把无人监护的迁移留在锁外。
- 入口为 `https://v2-test.43-160-242-46.sslip.io`。主机回环端口固定为 Authz 18091、Agent 18092、Billing 18093、Gateway 18094，集群 Service 仍为 ClusterIP。Billing 只公开支付、收银台和指定回调路径，管理入账及内部计费接口不出公网。
- 清单在 `infra/k8s/v2/`，所有对象固定到 `combo-v2`。平台与 Agent 镜像标注源码 SHA，清单只接受镜像摘要。Authz 使用 Resend 随机验证码，不允许开发固定码。平台密钥保留在 `combo-env`，Agent 凭据保存在独立的 `restart-life-credentials` Secret；Agent 不持有模型供应商密钥或平台内部密钥。
- V2 镜像先构建 `@cb/shared` 与 `@cb/payment-protocol`，再构建服务；运行层同时包含两个包的清单和产物。V2 清单启用独立支付准入凭据；服务的代码默认开关仍为关闭。
- Gateway 只接受 Authz 签名的 Agent 短期令牌和当前用户断言，拒绝旧共享入口凭据。代理转发给 Agent 前删除 Cookie 和 Authorization，只注入当前用户断言。升级时必须轮换曾交给旧 Agent 的 Billing 内部密钥。
- V2 Billing 仅启用乐收赢 TEST 渠道。经用户明确授权，`configure-v2-payment-secrets.mjs` 可在 V2 四服务停机后，于服务器内存中读取 `combo-test` 已有 TEST 商户配置并写入 V2 Secret；源环境必须启用 TEST 且关闭生产支付。脚本不输出或落盘凭据，不改源 Secret；重复执行复用已生成的 Agent 凭据，遇到不一致即停止。
- 收银台与 Host 共用该 HTTPS 来源，使用 Cookie 认证，尚未提供支付专用 Bearer。通知地址固定从该来源推导。启用前必须通过现有停机维护入口完成 V2 0017 迁移；支付就绪检查要求渠道表存在。
- 最新重启人生使用自己的 Redis 状态容器，只监听同 Pod 的 `127.0.0.1:6379`，使用独立 1Gi 持久卷、AOF 每次同步落盘及单实例替换。它不是共享 foundation，不接生产 Redis 或 Blob，仅保存会话协调元数据，不保存对话与地图正文。`render-v2.mjs` 还要求该 Redis 镜像的摘要。
- 配置合入、服务部署、渠道下单和用户真实付款分别记录验证结果。TEST 下单或模拟通知不得表述为用户真实付款成功。
- 失败重试升级追加 `0018_v2_call_attempts.sql`。仍使用上述四服务停机及共享锁入口，升级前准备好对应镜像；Billing 就绪检查还要求执行尝试表存在。0018 不推断历史失败，不改用户余额或旧账目。历史失败的恢复只在核对原网关错误记录后，向受保护的执行结果接口补记事实。
