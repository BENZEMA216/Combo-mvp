# 创作者中心主链路 · monorepo

Combo「创作者中心主链路」的生产栈骨架：脊柱契约（`@cb/shared`）+ 四层应用（api / web / db / infra）。
本阶段交付的是 **可编译、可启动的骨架**：脚手架 / 配置 / 迁移 / 基础设施 / 共享类型全部真实可用、`tsc` 通过；
业务路由按契约挂好路径 / 方法 / 鉴权链 / 幂等 scope，handler 暂为 `501` 占位（Phase 3 填）。

三条硬规则贯穿全栈：**永不裸转圈**、**绝不裸露错误码**（统一 `ErrorEnvelope`，只给 `userMessage` + `action`）、**已生成内容不丢**。

---

## 前置要求

| 工具   | 版本                                  | 说明                                                      |
| ------ | ------------------------------------- | --------------------------------------------------------- |
| Node   | `>= 24`（仓库锁 `.nvmrc` = 24）       | 用到 `--experimental-strip-types` 直跑迁移 TS             |
| pnpm   | `>= 11`（`packageManager` 锁 11.0.9） | 唯一包管理器，`corepack enable` 即可                      |
| Docker | 仅「compose 起全栈」需要              | **当前开发机无 Docker，全栈启动推迟**；本地子集开发不需要 |

> **文档真源（对人和 AI agent 都是硬规则）**
>
> 本项目的 PRD 与技术方案，唯一权威真源是飞书知识库「[产研方案集合](https://enbmphajlu.feishu.cn/wiki/AyvDw5SkZiinkDkjxe6cLcZInNe)」，按链路分组：
>
> - [生产链路（上传与发布）](https://enbmphajlu.feishu.cn/wiki/Sn3xwHpw8inq99kTRNQcmPMjnAe)：能力上传 PRD（2 步精简版）、服务端方案、服务端代码梳理
> - [试用与消费链路](https://enbmphajlu.feishu.cn/wiki/NL8WwPYwmih55UknIdtcCqB5nGg)：试用链路 PRD、试用/消费服务端方案
> - [横切方案](https://enbmphajlu.feishu.cn/wiki/Di6awjArji4oXKkAxetc4Y1enLc)：能力包契约、登录与账号体系、后端仓库结构规范
> - [运维与环境](https://enbmphajlu.feishu.cn/wiki/QHEQwaEd9iki3vkSITlcXfcMn6f)、[归档](https://enbmphajlu.feishu.cn/wiki/Jd00wpfavi2ToPkGUD7cTTg3n1c)（归档内为已被取代的旧方案，勿作依据）
>
> 仓库原 `docs/` 目录（详细技术方案、contracts 契约、验收矩阵等）内容已过期，于 2026-07-04 整体删除（需要时可从 git 历史找回）。
> **需求口径、验收标准、设计决策一律以上述飞书文档为准；不要参考仓库历史文档、被删除的 `docs/`、或代码里的旧阶段注释（如「501 占位」）。** 接口的运行时契约以 `packages/shared` 源码为准。

---

## 安装

```bash
pnpm install
```

工作区包含 `packages/shared`、`apps/authoring`、`apps/runtime`、`apps/runtime-web`、`apps/sandboxd`、`apps/web`、`db`、`infra` 与 `scripts`。

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

无 DB / Redis / MinIO / Logto 时进程**不崩溃**，按设计降级：

- `GET /health` 返回 `200 {"status":"ok"}`（liveness，不查依赖）。
- `GET /ready` 返回 `503`，结构化列出六依赖（db/redis_queue/redis_hot/minio/logto 标 `down`、llm 标 `degraded`），并给出 `ready:false`。
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

DDL 真源在 `db/migrations/`（`0000` 至 `0006`，共 7 个 SQL，字典序即执行序）。
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

编排在 `infra/docker-compose.yml`，17 个服务和 6 个命名卷。固定启动顺序由 `depends_on` 与健康条件约束：

PostgreSQL 就绪后依次运行 Logto 建库与变更任务，再启动 Logto。业务迁移完成后才会启动 API、Worker、Runtime 和 Web。

要点：

- Logto OSS 不自跑迁移：先 CLI `db seed` 建表（一次性容器），再 `db alteration deploy`（单实例一次性 job），跑完才起 logto 运行态。
- 业务库 `combo` 与身份库 `logto` 同 PG 实例、不同 database，各自独立迁移，互不干扰。
- Redis 物理拆两实例：`redis_queue`（AOF + noeviction，BullMQ 队列绝不被驱逐）/ `redis_hot`（maxmemory + allkeys-lru，事件 Streams / 锁 / 限流，可驱逐、无持久卷）。
- 健康检查：postgres / redis×2 / minio 用原生探针；logto 断言 OIDC discovery（`{issuer}/.well-known/openid-configuration` 的 `issuer` / `jwks_uri`）；api 用 `/health`（liveness）；observability 栈提供 Grafana + Loki + Tempo + OpenTelemetry Collector。

```bash
cp .env.compose.example .env    # 全栈起栈用：填全部密钥（不得留空/不得用弱默认）
pnpm -F @cb/infra compose:config  # docker compose config（静态校验编排）
bash scripts/start.sh           # 严格固定序起全栈（每步 --wait，失败即止；起栈前先跑弱密钥守卫）
bash scripts/smoke.sh           # 端到端冒烟（/health /ready 结构 / ErrorEnvelope / Logto discovery）
pnpm -F @cb/infra compose:down  # 拆栈
```

观测入口：Grafana `http://localhost:3003/d/combo-trace-debug/trace-debug`，输入 UI 反馈码（`traceId`）即可查关联日志。

#### 两套 env 示例（按运行语境二选一，issuer 各自自洽）

| 运行语境                   | 复制哪个               | Logto issuer（canonical）    | 密钥要求                                                                             |
| -------------------------- | ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| **本机直跑**（无 Docker）  | `.env.local.example`   | `http://localhost:3001/oidc` | dev 占位可用（combo/minioadmin）；`LOGTO_AUDIENCE` 可空（不强校 aud）                |
| **全栈 compose**（生产栈） | `.env.compose.example` | `http://logto:3001/oidc`     | **密钥必填、禁弱默认**；`start.sh` 起栈前守卫拒绝空值与 combo/minioadmin/postgres 等 |

- **为何拆两套**：单一 `.env` 的 Logto URL 若用 `localhost`，在 compose 网络里会让 API 容器内 `/ready` 和 JWKS 打到自己（容器内 `localhost` ≠ `logto` 容器）。故 compose 用服务名 `logto:3001`，本机直跑用 `localhost:3001`，两套各自 `LOGTO_ENDPOINT == {LOGTO_ISSUER 去 /oidc}`、自洽不分裂。
- **为何示例密钥留空**：示例里若带可用密钥（combo/minioadmin），会满足 compose 的 `${VAR:?}` = 绕过「生产无默认密钥」。故 `.env.compose.example` 所有密钥项留空，且 `scripts/start.sh` 加弱默认守卫（空或已知弱默认值即拒绝起栈），与 `apps/authoring/src/platform/config/env.ts` 生产守卫双保险。

环境变量真源是上述两个 `.env.*.example`，分两类消费者：`[app]`（Node 进程的环境 schema 校验）与 `[compose]`（compose 变量替换）。

---

## CI（持续集成）

CI workflow 位于仓库根 `.github/workflows/ci.yml`。本 monorepo **即仓库根**，故 GitHub Actions 直接识别并运行（无需再复制/软链或加 `working-directory` 前缀）。

三个 job：

- `gate` —— install / lint（含分层依赖规则）/ typecheck / build / test / OpenAPI 生成自查 / compose 配置自查（结构校验，不 up）。无外部依赖，必过才允许合并。
- `integration` —— 起 PG / Redis 双实例 / MinIO 临时 service 容器，跑 db 迁移集成 + redis 双实例分工断言（O-05 / O-07）。
- `image` —— 分别构建 API、Runtime 与 Web 镜像，并校验 Dockerfile 与仓库根 build context 自洽。

所有步骤直接以仓库根（= monorepo 根）为工作目录；`cache-dependency-path: pnpm-lock.yaml`、`docker build -f infra/Dockerfile.* .`（context `.` = 仓库根）等路径均相对仓库根。

---

## 目录结构

```
.                      # 仓库根 = 本 monorepo（@cb/root）
├── packages/shared/   # @cb/shared 脊柱：DTO / zod / ErrorEnvelope / SSE 协议 / 常量 / 端口 / OpenAPI 真源
├── apps/authoring/    # @cb/authoring  创作 API 与任务 Worker
├── apps/runtime/      # @cb/runtime  会话、Turn、Artifact 与 Runtime SSE
├── apps/web/          # @cb/web  创作端 React/Vite 应用
├── apps/runtime-web/  # @cb/runtime-web  试用与 Studio React/Vite 应用
├── db/                # @cb/db   PostgreSQL 迁移 + 幂等 runner
├── infra/             # @cb/infra 编排、发布拓扑、Nginx 与基础设施配置
├── scripts/           # @cb/scripts start / migrate / smoke / openapi-dump / 集成脚本
└── .github/workflows/ # CI（ci.yml）。本 monorepo 即仓库根，GitHub Actions 直接识别并运行
```

更细的各包职责与设计决策，见文首「文档真源」指向的飞书文档。

---

## 验证

源码门禁统一执行 `pnpm lint`、`pnpm format:check`、`pnpm typecheck`、`pnpm typecheck:test`、`pnpm build` 和 `pnpm test`。数据库集成检查使用一个可丢弃的 PostgreSQL，验证从空库执行 `0000` 至 `0006`、再次幂等执行和异常账本拒绝。

Test 的环境级证据只来自 tecent2 K3s 的 `combo-preview`。受保护工作流核对四个业务面的镜像摘要、迁移头、运行时发布身份、Web 资源摘要、缺失哈希资源响应和旧拓扑缺失；源码目录中的普通测试不启动 Docker 或 Docker Compose。
