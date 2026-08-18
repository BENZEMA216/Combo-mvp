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

| workflow                         | 显示名            | 触发                                  | 作用                                                                                                                                                                      |
| -------------------------------- | ----------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/pr-ci.yml`    | PR checks         | pull_request                          | 合并前质量门禁：依赖安装、shared 构建、format、lint、typecheck、无容器快速测试、ShellCheck；不构建或发布镜像                                                              |
| `.github/workflows/ci.yml`       | Release build     | main push、workflow_call              | 全量构建：集成测试、容器契约、四个镜像（api/agent-gateway/runtime/web），并发布绑定精确提交 SHA 的不可变 `combo-build-<SHA>-<attempt>` 构建清单；也是分支构建的可复用入口 |
| `.github/workflows/vnext-t0.yml` | VNext T0 Linux CI | workflow_call                         | PR checks 与 Release build 共用的只读 Linux Gate：执行 format/lint/source+test typecheck、精确 `pnpm vnext:test:g0`，并生成 SHA-bound JUnit/evidence artifact             |
| `.github/workflows/deploy.yml`   | Deploy            | Release build 完成、workflow_dispatch | 统一部署三环境，执行晋级链                                                                                                                                                |

`deploy.yml` 的 `workflow_run` 触发器必须引用 `Release build` 显示名；重命名 ci.yml 时需要同步。

`ci.yml` 的并发组名是 `main-cd-*`（main push 时 `main-cd-main`，分支构建时 `main-cd-<revision>`），与 `combo-deploy-<env>` 部署锁互不相交。自动部署只作用于 Preview（main 的 `Release build` 成功后触发）；Test 没有自动触发路径，只接受手工 `workflow_dispatch`。

`vnext-t0.yml` 只接受同仓库 reusable workflow caller，不读取 Secret，不授予 package、OIDC 或其他写权限，并固定使用 `ubuntu-24.04`、Node 24 实际 patch 和 pnpm 11.0.9；checkout、pnpm setup、Node setup及artifact upload/download action均绑定审计时的完整commit SHA。PR merge SHA 的结果始终标记为 `ADVISORY_ONLY`；只有 `Release build` 在 GitHub标记为protected的 `main` push上测试同一SHA时才能生成 `FORMAL` disposition。分支 Test build 即使由 main 上的 Deploy 控制器调用，也继续标记 `ADVISORY_ONLY`。artifact 记录 tested/tree、top-level caller与实际reusable job workflow身份、runner/toolchain、100-seed property policy、SCH-001..010、source tuple、五份非空且零skip的JUnit digest与计数，且不包含 raw log、Prompt、答案或凭据。上传只接受已验证bundle，上传后会重新下载并复验，避免verify/upload间漂移。仓库中的 workflow/schema 只证明机制已实现；只有 GitHub job 对同一 clean SHA 成功、artifact 上传成功且 artifact digest 可核对后，才构成正式 T0 PASS。

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

`scripts/render-env.mjs` 按环境渲染 apps / migrate / foundation 三份清单，替换镜像 digest 与每环境占位符（Secret 名、Postgres/Redis/MinIO 主机、公开入口、Cookie 安全标志）。Preview/Production 的 Postgres/Redis/MinIO 主机解析为 `combo-foundation` 的跨 namespace 服务名。release schema v2 仅在 Test 加入 Agent Gateway；Preview/Production 和 schema v1 始终渲染零 Gateway 资源。

## 7. 凭证规范

- 各应用 namespace 必须存在 `combo-env` Secret（Postgres/S3/Resend/OTP/LLM 配置）与 `ghcr-pull`（镜像拉取）。
- 共享 foundation（`combo-foundation`）的 Postgres/S3 凭证必须与 `combo-preview`、`combo-prod` 的凭证一致；否则应用无法连接共享数据库。
- 凭证只在受信任运维边界原位轮换，不删除重建；现有 `scripts/configure-first-party-auth-secrets.sh` 负责 legacy 键，VNext Test Gateway 键需另行以不回显方式预置到 `combo-test/combo-env`。
- 部署脚本不得输出、落盘、复制或提交任何 Secret 值。
- Test 可额外预置 `combo-visible-transcript-test-keyring`，只供 Runtime 的 `test-k8s-secret-file` adapter 以 `0400` 只读 volume 使用。清单不创建或填充该 Secret；Preview 与 Production 禁止渲染此 provider、path 或 volume。它不是 production KMS，不能作为腾讯云真实 provider 验证。
- Test schema v2 还要求 `combo-env` 成组预置三个 VNext 角色密码和四个 Gateway compatibility JSON profile 数组。四个数组必须等长并按索引组成 Worker/Codex artifact/Codex schema/isolation exact profile，不能按独立 allowlist 做 Cartesian 组合；Worker version 不得重复。migration 对角色键 optional 是旧环境 expand compatibility，不代表 Gateway 可无凭据运行；Pod 只持 broker 密码且默认关闭 publisher。Preview/Production 不接受这些 Gateway 资源，当前 helper 也不会生成这些值。

## 8. 更新流程

- **控制面（workflow / 部署脚本）**：改动 → PR（PR checks 门禁）→ 合入 main → 对后续触发生效，无需构建镜像。
- **基础资源**：改动清单 → 合入 main → 下次部署时 `deploy-env.sh foundation` 幂等应用；实例常驻不重建，数据保留。
- **应用代码**：改动 → PR → 合入 main → Release build 构建镜像与构建清单 → Deploy 自动部署 Preview → 人工确认后部署 Production。分支验证走 Test。

## 9. 明确约束

1. Preview 不建立独立 foundation；它与 Production 共享 `combo-foundation`。
2. Test 有独立 foundation，数据常驻，不做销毁重建。
3. 生产正式域名是 `buildwithcombo.com`，部署验证以此为准。
4. 三环境应用部署互不阻塞；共享 foundation 的迁移串行。
5. visible transcript Secret 文件 provider 只属于 Test；生产无 raw-key fallback，真实外部 HMAC authority 未验证前保持 BLOCKED。
