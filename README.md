# Combo · 可分享 Agent monorepo

Combo 让用户把已经完成的对话、Project 或工作旅程制作成可分享的 Agent。仓库以不可变、可验证和可加载的 Agent Package 作为唯一交付物，同时承载创作、分享、运行、网页、数据库和部署基础设施。

当前代码已经具备 Project-first 的本地 Agent Package 创作、正式重载和原生 Codex 多轮运行机制，但它仍是工程机制，不是普通用户入口。产品 Golden Path 是在 Codex Desktop 当前任务中用一句自然语言把当前对话变成 Draft，且默认零 Project 读取、零 Hook、零 Terminal；这条路径尚未实现，跨用户发布、接收和 Studio 产品闭环也仍在开发中。已确认的产品基线见 [`PROJECT.md`](PROJECT.md)，可调整的工程拆解与进度见 [`ENGINEERING.md`](ENGINEERING.md)。

三条硬规则贯穿全栈：**永不裸转圈**、**绝不裸露错误码**（统一 `ErrorEnvelope`，只给 `userMessage` + `action`）、**已生成内容不丢**。

---

## 前置要求

| 工具   | 版本                                  | 说明                                          |
| ------ | ------------------------------------- | --------------------------------------------- |
| Node   | `>= 24`（仓库锁 `.nvmrc` = 24）       | 用到 `--experimental-strip-types` 直跑迁移 TS |
| pnpm   | `>= 11`（`packageManager` 锁 11.0.9） | 唯一包管理器，`corepack enable` 即可          |
| Docker | 仅「compose 起全栈」需要              | 本地子集开发与普通源码门禁不需要 Docker       |

> **文档权威关系（对人和 AI agent 都是硬规则）**
>
> - [`PROJECT.md`](PROJECT.md) 是用户已经确认的唯一产品基线，定义产品目标、目标用户体验和唯一产物模型。
> - [`ENGINEERING.md`](ENGINEERING.md) 是从产品基线推导的工程工作稿，在真实开发中持续验证和调整，不能覆盖产品基线。
> - 飞书知识库「[产研方案集合](https://enbmphajlu.feishu.cn/wiki/AyvDw5SkZiinkDkjxe6cLcZInNe)」记录既有阶段的详细 PRD 与技术方案，按链路分组：
> - [生产链路（上传与发布）](https://enbmphajlu.feishu.cn/wiki/Sn3xwHpw8inq99kTRNQcmPMjnAe)：能力上传 PRD（2 步精简版）、服务端方案、服务端代码梳理
> - [试用与消费链路](https://enbmphajlu.feishu.cn/wiki/NL8WwPYwmih55UknIdtcCqB5nGg)：试用链路 PRD、试用/消费服务端方案
> - [横切方案](https://enbmphajlu.feishu.cn/wiki/Di6awjArji4oXKkAxetc4Y1enLc)：能力包契约、登录与账号体系、后端仓库结构规范
> - [运维与环境](https://enbmphajlu.feishu.cn/wiki/QHEQwaEd9iki3vkSITlcXfcMn6f)、[归档](https://enbmphajlu.feishu.cn/wiki/Jd00wpfavi2ToPkGUD7cTTg3n1c)（归档内为已被取代的旧方案，勿作依据）
>
> 具体文档与产品基线冲突时必须停止并说明，不能自行选择旧口径继续开发。HTTP 与应用共享契约以 `packages/shared` 源码为准，Agent Package 与 Creator Host 协议以 `packages/creator-agent-protocol` 源码为准，数据库结构以 `db/migrations/` 为准，部署拓扑以 [`docs/deployment-topology.md`](docs/deployment-topology.md) 为准。

---

## 安装

```bash
pnpm install
```

工作区包含 `packages/shared`、Creator Agent 相关协议与持久化包、`apps/creator-worker`、`apps/authoring`、`apps/runtime`、`apps/runtime-web`、`apps/sandboxd`、`apps/web`、`db`、`infra` 与 `scripts`。

---

## 本地开发

### 一次性全栈校验（无需 Docker）

```bash
pnpm install          # 装依赖
pnpm -r run build     # 按项目引用依赖序构建 shared 与各应用
pnpm -r run typecheck # 全包 tsc -b
pnpm lint             # eslint .（含分层 import 规则）
pnpm -r run test      # 运行全部工作区测试
pnpm format:check     # prettier 全量校验
```

### 单独跑某个包

```bash
pnpm -F @cb/shared build        # 构建脊柱（apps 依赖其 dist + .d.ts，先构建它）
pnpm -F @cb/shared openapi:gen  # 生成 OpenAPI 3.1（写 dist/openapi.json）
pnpm -F @cb/authoring build     # 构建创作 API 与 Worker
pnpm -F @cb/runtime build       # 构建 Runtime API
pnpm -F @cb/web dev             # Vite 开发服务器（前端）
pnpm -F @cb/runtime-web dev     # Vite 试用与 Studio 前端
pnpm -F @cb/web build           # tsc -b && vite build
```

### 本地直跑 Authoring API（无 DB 也能起到健康检查可达）

`@cb/shared` 与 `@cb/authoring` 构建后：

```bash
node apps/authoring/dist/processes/api.js
# 默认监听 :3000（可用 PORT/HOST 覆盖）
```

无 DB / Redis / MinIO 时进程**不崩溃**，按设计降级：

- `GET /health` 返回 `200 {"status":"ok"}`（liveness，不查依赖）。
- `GET /ready` 返回 `503`，结构化列出基础依赖并给出 `ready:false`；邮件供应商故障只阻塞新验证码，不使已有会话失效。
- 受保护端点（如 `GET /api/v1/me`）返回 `401` ErrorEnvelope（`UNAUTHENTICATED` / `escalate`，绝不裸露 code）。
- 未知路由返回 `404` 信封。
- 每个响应带 `x-trace-id` 头 + 结构化 pino 日志

> 起全栈后 `/ready` 会随依赖就绪转 `ok`；编排 / LB 据 `/ready` 判定是否接流量。

---

## Authoring 两进程说明

API 与 Worker 共用 Authoring 镜像，按 `PROCESS` 环境变量在 `infra/entrypoint.sh` 分叉：

| 进程     | 入口                                      | 职责                                    |
| -------- | ----------------------------------------- | --------------------------------------- |
| `api`    | `apps/authoring/dist/processes/api.js`    | Fastify HTTP、认证、任务接口与 SSE      |
| `worker` | `apps/authoring/dist/processes/worker.js` | BullMQ Task pipeline 与失联任务租约恢复 |

本地直跑单个进程：

```bash
PROCESS=worker node apps/authoring/dist/processes/worker.js
```

---

## 数据库迁移

DDL 真源在 `db/migrations/`（`0000` 至 `0011`，共 12 个 SQL，字典序即执行序）。`0009` 增加 Agent 使用计费、充值订单和不可变钱包流水；`0010` 把扫码充值通道从聚合码重命名为 C扫B 单渠道 `qr`；`0011` 移除 H5 收银台渠道并把历史订单迁移到 `qr`。冻结的 Goal B 部署证据仍停留在 `0008`，在显式开始后续部署目标前不能把两者混作同一份线上证据。
Runner 自带记账表 `schema_migrations`，**幂等可重入**：已应用文件跳过、逐文件单事务、失败即止。

```bash
# 需要一个可达的 PostgreSQL（默认连接串见下）
pnpm -F @cb/db migrate         # 应用全部未应用迁移
pnpm -F @cb/db migrate:status  # 列清单（无连接也能列）
```

默认 `DATABASE_URL=postgres://combo:combo@localhost:5432/combo`，可用环境变量覆盖。

- 唯一 `CREATE EXTENSION` 是 `pgcrypto`（stock PG 自带），故任意 PG 实例可跑。
- 当前迁移链包含 Task pipeline、Capability、Session、Turn、Message 与 Artifact 的运行时真源。
- Runner 会拒绝编号缺口、未知账本项、旧迁移链和非空 schema 配空账本；Test 从空库完整执行后再运行第二遍幂等检查。

---

## Compose 起全栈（需 Docker）

> 以下 Compose 命令只用于独立开发环境，不作为 Test、Preview 或 Production 的验收证据。tecent2 源码检查不运行这些命令。

编排在 `infra/docker-compose.yml`。固定启动顺序由 `depends_on` 与健康条件约束：基础设施就绪后运行 `0000` 至 `0011` 迁移并配置三个固定数据库角色，成功后才启动 API、Worker、Runtime 和 Web。

要点：

- 第一方邮箱 OTP 由 API 通过 Resend 发出；数据库只保存邮箱身份、验证码 HMAC 摘要和不透明会话摘要。
- API、Worker、Runtime 分别使用 `combo_api`、`combo_worker`、`combo_runtime` 最小权限数据库角色。
- Redis 物理拆两实例：`redis_queue`（AOF + noeviction，BullMQ 队列绝不被驱逐）/ `redis_hot`（maxmemory + allkeys-lru，事件 Streams / 锁 / 限流，可驱逐、无持久卷）。
- 健康检查：postgres / redis×2 / minio 用原生探针；api 用 `/health`（liveness）；observability 栈提供 Grafana + Loki + Tempo + OpenTelemetry Collector。

```bash
cp .env.compose.example .env    # 全栈起栈用：填全部密钥（不得留空/不得用弱默认）
pnpm -F @cb/infra compose:config  # docker compose config（静态校验编排）
bash scripts/start.sh           # 严格固定序起全栈（每步 --wait，失败即止；起栈前先跑弱密钥守卫）
bash scripts/smoke.sh           # 端到端冒烟（/health /ready / 第一方邮箱认证边界）
pnpm -F @cb/infra compose:down  # 拆栈
```

观测入口：Grafana `http://localhost:3003/d/combo-trace-debug/trace-debug`，输入 UI 反馈码（`traceId`）即可查关联日志。

#### 环境配置

本机直跑复制 `.env.local.example`；Compose 使用 `.env.compose.example`。生产式配置必须提供 `PUBLIC_APP_ORIGINS`、三个数据库角色密码、`RESEND_API_KEY` 和 `OTP_HMAC_SECRET`。`scripts/start.sh` 会拒绝空值和已知弱默认值。

环境变量真源是上述两个 `.env.*.example`，分两类消费者：`[app]`（Node 进程的环境 schema 校验）与 `[compose]`（compose 变量替换）。

---

## CI 与 CD

> 部署拓扑、命名空间、基础资源归属与发布规范见 [`docs/deployment-topology.md`](docs/deployment-topology.md)，它是仓库内部署系统的权威说明。

三个 workflow 对应「检查 / 构建 / 部署」三个阶段：

- `.github/workflows/pr-ci.yml`（PR checks）：合并前质量门禁，只由 `pull_request` 触发。完成依赖安装、shared 构建、format、lint、typecheck、无容器快速测试和 ShellCheck；不构建或发布镜像，也不读取部署 Secret。
- `.github/workflows/ci.yml`（Release build）：`main` 更新后执行完整 build、集成测试、容器契约与镜像构建，并发布绑定精确提交 SHA 的不可变 `combo-build-<SHA>-<attempt>` 构建清单。它也是分支构建的可复用入口（`workflow_call`）。
- `.github/workflows/deploy.yml`（Deploy）：统一部署三个环境，按晋级链执行。

Test、Preview、Production 三个环境运行在同一台 tecent2 主机的 k3s 上，命名空间分别为 `combo-test`、`combo-preview`、`combo-prod`：

- **test**：任意同仓库分支可部署（分支验证沙箱）。具有仓库写入权限的成员通过 `workflow_dispatch` 选择分支及其精确 tip SHA，回调 main 定义的 `ci.yml` 为该分支构建不可变 artifact 并部署到 Test。
- **preview**：只接受 main 修订。`Release build` 成功后自动部署同一 main 提交；也可手工 dispatch（仅接受可达 main 的修订）。
- **production**：只有该修订已运行在 preview（preview 验证通过）且人工显式确认（`confirm_production`）后才可部署。
- 三个环境的应用 rollout 各持一把并发锁互不阻塞；Preview/Production 共享 foundation（`combo-foundation`），对共享基建的迁移由主机侧 per-foundation 锁串行。Test 每次只更新应用，基础实例常驻、数据保留。

---

## 目录结构

```
.                      # 仓库根 = 本 monorepo（@cb/root）
├── packages/shared/   # @cb/shared 脊柱：DTO / zod / ErrorEnvelope / SSE 协议 / 常量 / 端口 / OpenAPI 真源
├── packages/creator-*/       # Creator Agent 协议、持久化、Broker Journal 与 Worker 客户端
├── apps/authoring/    # @cb/authoring  创作 API 与任务 Worker
├── apps/creator-worker/ # Agent Package 创作、正式加载与原生 Codex 会话
├── apps/runtime/      # @cb/runtime  会话、Turn、Artifact 与 Runtime SSE
├── apps/web/          # @cb/web  创作端 React/Vite 应用
├── apps/runtime-web/  # @cb/runtime-web  试用与 Studio React/Vite 应用
├── apps/sandboxd/     # @cb/sandboxd  运行沙箱协议与进程边界
├── db/                # @cb/db   PostgreSQL 迁移 + 幂等 runner
├── infra/             # @cb/infra 编排、发布拓扑、k8s 清单、Nginx 与基础设施配置
├── scripts/           # @cb/scripts 发布渲染 / 部署 / 验收 / 集成脚本
└── .github/workflows/ # PR checks（pr-ci.yml）、Release build（ci.yml）与部署（deploy.yml）
```

更细的产品目标与工程拆解见 `PROJECT.md` 和 `ENGINEERING.md`；各包当前职责见对应目录中的 `README.md`。

---

## 验证

源码门禁统一执行 `pnpm lint`、`pnpm format:check`、`pnpm typecheck`、`pnpm typecheck:test`、`pnpm build` 和 `pnpm test`。数据库集成检查使用一个可丢弃的 PostgreSQL，验证从空库执行 `0000` 至 `0011`、再次幂等执行、应用角色权限和异常账本拒绝。

Test、Preview 与 Production 的环境证据来自 tecent2 K3s 的 `combo-test`、`combo-preview` 与 `combo-prod` namespace。受保护的 `main` 控制器可以部署自动产生的 `main` 候选，也可以部署手工选择的任意同仓库分支候选；每次部署都核对四个业务面的镜像摘要、迁移头、运行时发布身份、Web 资源摘要并验证环境域名返回对应 SHA。源码目录中的普通测试不启动 Docker 或 Docker Compose。

Agent 固定按次计费与乐收赢充值的源码验收、未完成现场证据和后续 Test 人工步骤见 [`docs/leshouying-test-acceptance.md`](docs/leshouying-test-acceptance.md)。
