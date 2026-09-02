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

DDL 真源在 `db/migrations/`（`0000` 至 `0019`，共 20 个 SQL，字典序即执行序）。`0009` 增加 Agent 使用计费、充值订单和不可变钱包流水；`0010` 把扫码充值通道从聚合码重命名为 C扫B 单渠道 `qr`，`0011` 移除 H5 通道并只保留 `qr`；`0012` 至 `0016` 保留已发布的 Agent Builder、MCP OAuth、Test Review、Project Agent Share 与 Project-history 兼容前缀；`0017` 追加 canonical Agent Package Registry，`0018` 追加 Agent Session/usage receipt 快照，`0019` 追加 pending usage recovery。已应用的 `0012` 至 `0019` 文件名与字节都是不可变的 live Test 账本前缀；本 79f 系页面候选携带 `0017`–`0019` 只为使同一 production image 的 migration job 能安全面对 live `0019` schema，不激活也不声称它已实现后续 Registry、receipt 或 recovery 应用功能。冻结的 Goal B 部署证据仍停留在 `0008`，在显式开始后续部署目标前不能把它与当前迁移链混作同一份线上证据。
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

编排在 `infra/docker-compose.yml`。固定启动顺序由 `depends_on` 与健康条件约束：基础设施就绪后运行 `0000`–`0019` 迁移并配置三个固定数据库角色，成功后才启动 API、Worker、Runtime 和 Web。

要点：

- 第一方邮箱 OTP 由 API 通过 Resend 发出；数据库只保存邮箱身份、验证码 HMAC 摘要和不透明会话摘要。
- API、Worker、Runtime 分别使用 `combo_api`、`combo_worker`、`combo_runtime` 最小权限数据库角色。
- Redis 物理拆两实例：`redis_queue`（AOF + noeviction，BullMQ 队列绝不被驱逐）/ `redis_hot`（maxmemory + allkeys-lru，事件 Streams / 锁 / 多副本共享 HTTP 限流，可驱逐、无持久卷）。限流 key 按发布环境隔离，Redis 故障时受限请求失败关闭。
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

本机直跑复制 `.env.local.example`；Compose 使用 `.env.compose.example`。本机完整公开体验的 canonical origin 是 Vite 的 `http://localhost:5173`，`/api`、`/.well-known`、`/codex-plugin`、`/health` 与 `/ready` 都由 Vite 代理到 Authoring `:3000`；直接访问 `:3000` 只是在调 API，不能代表 Project Agent 或 Codex Agent 公开页链路。生产式配置必须提供 `PUBLIC_APP_ORIGINS`、同列表中的规范 HTTPS `EXTERNAL_MCP_PUBLIC_ORIGIN`、固定 `MCP_RUNTIME_INTERNAL_BASE_URL`、三个数据库角色密码、`RESEND_API_KEY` 和 `OTP_HMAC_SECRET`。`scripts/start.sh` 会拒绝空值和已知弱默认值。

Codex 插件不再需要 `COMBO_SESSION_COOKIE`。本次 0.8.7 页面候选的仓库证据状态是 `CODE_CONTRACT` / `NOT_DEPLOYED` / `NOT_UAT`；这些只描述尚未合并部署的候选代码，不得写入运行页面。公开入口 `/codex-plugin` 继续使用 live-truth 模型：只在 Test runtime 提供，从受校验 release metadata 渲染 `TEST_RUNTIME`、当前 `environment`、`sourceSha` 与 `releaseId`，并要求执行安装前与同源 `/version.json` 逐字核对。页面固定显示 `UAT_STATUS=EXTERNAL_EVIDENCE_REQUIRED`，HTTP 页面、健康检查或部署身份均不能替代独立普通用户 UAT，也不得在运行页面硬编码 `NOT_DEPLOYED` 或 `NOT_UAT`。

Project-history 的唯一普通用户 Copy prompt 是不变的单行 `阅读 https://test.43-160-242-46.sslip.io/codex-plugin ，帮我安装或升级 Combo 插件；完成后只创建一个安装续接任务，不要直接开始制作 Agent。`（UTF-8 174 bytes，SHA-256 `05321ad73850806a73167b366f7c2b06f053ca059b476ad22592997cdc45b98f`）；URL 后保留一个 ASCII 空格，避免 Markdown 自动链接吸收中文标点。Plugin 安装在 Codex Host，不是安装到 Project，也不读写 Project 文件；普通用户不打开 Terminal、不输入命令、不提供路径或内部 ID。页面为 fresh install、可安全升级旧版和 exact 0.8.7 当前版保留不同前置安装动作，但三种状态最终都只能消费 Plugin 0.8.7 的 Plugin bundled typed controller recovery-only result，initial setup 不得直接创建 Project-history business，也不得提供、复述或允许复制 business prompt。

已经运行的 initial task 可能仍持有旧 Skill snapshot，新项目也不必预先安装 Combo；因此页面不依赖 Skill 热加载。最终门禁后用 bundled Codex CLI 精确执行 `plugin list --marketplace dangdang-tech-combo --available --json`，只接受 `installed` 中恰好一行官方 `combo@dangdang-tech-combo`，且同一行必须为 official Git source、`installed=true`、`enabled=true`、exact `0.8.7`、`source.source=local` 与非空绝对 `source.path`。只从该行取 `source.path`，以 `realpath(source.path)` 作为 installed root，并验证固定相对路径 `scripts/project-history-bootstrap-controller.mjs` 的 realpath 仍在 root 内、是 regular file 且 mode 精确为 0755；必须以完整 mask `(mode & 0o7777) === 0o755` 验证，setuid/setgid/sticky 任一存在都拒绝。Plugin 0.8.7 的 tracked controller bundle 精确为 4,871 bytes，SHA-256 `0b50ef569b7ceb41816fbba3f7a5ede96323da3ca50ca10709ce660a23c90f05`；该指纹只锁定官方发布产物，不允许从其他路径查找替代文件。解析出的 path 只可 Host 内部使用，不得进入用户 prose、child prompt 或 Combo 参数；禁止扫描 Plugin cache、本地 Skill、记忆、任意路径或开发 checkout，也不依赖 PATH Node、`PLUGIN_ROOT`、`PLUGIN_DATA`、Hook 或浏览器。

trusted outer parser 只能以精确前缀 `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u NODE_V8_COVERAGE -u NODE_COMPILE_CACHE -u NODE_REDIRECT_WARNINGS` 启动固定 bundled CUA Node `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`，移除这五个 Node 注入、coverage、cache 和 warning 变量。inner controller 固定 cwd 为 verified root 的 `scripts`，固定 executable 为同一绝对 `process.execPath`，argv 只能是 `["./project-history-bootstrap-controller.mjs","setup"]`，零 stdin、零 model state、empty environment、固定 5,000 ms timeout 与 `SIGKILL`，恰好执行一次。stdout 上限 8,192 bytes，只接受 exit 0、无 signal、空 stderr、fatal UTF-8、恰好一个非空 strict JSON line 和恰好一个 LF 结尾，不接受 CR 或额外空白。Controller result 的 top-level keys 必须恰好为 `schemaVersion`、`action`、`target`、`childCreateBudget`、`soleFirstPrompt`；值只接受 `schemaVersion=combo.project-history-bootstrap-controller/1`、`action=create-recovery`、唯一 target key `target={type:"projectless"}`、`childCreateBudget=1` 与 2,000 bytes / SHA-256 `33d94d776e9d4eb0cf2238358857c8e4b33427de655be6a52d33e834d460146d` 的固定 `soleFirstPrompt`。任一 locator、mode、exec 或 envelope 不符时只报告 `PROJECT_HISTORY_BOOTSTRAP_CONTROLLER_EXEC_FAILED`，零 child、fallback、scan 和 retry，不暴露 raw output、path、ID 或 stack。有效结果只允许一次 `create_thread({prompt:controllerResult.soleFirstPrompt,target:{type:"projectless"}})`。Plugin 固定 business prompt 只以不可见指纹锁定：1,074 bytes / SHA-256 `7df7bced005edd481e8eaa3169a8cac3dfa278d459942a15ef31bf595fd101fc`；本 README 和页面均不放入该 business 正文。`INITIAL_CONTINUATION_ENFORCEMENT=CODE_INTEGRATED` 只表示 installed controller 对 initial setup 到安装续接这一跳提供代码级强制，不宣称 controller 技术上强制 continuation 到 business。`RECOVERY_BUSINESS_GATE=HOST_TRACE_REQUIRED` 表示 continuation 只能依据自包含 prompt 与真实五 V3/OAuth Host trace 决定是否进入 business；本候选部署与该真实 Host trace 验收均为 `NOT_RUN`。

安装续接及其后的业务任务均禁止 Terminal、子智能体、浏览器、本地文件、Skill、记忆、缓存、路径和 legacy fallback；内部 ID 不得进入用户消息、Combo 参数或可见说明，但 Host 工具内部绑定和结果处理可使用自身返回标识。续接任务在读取任何 Project 前必须确认五个 V3 工具全部可用，任一缺失只报告 `PROJECT_HISTORY_AGENT_MCP=NOT_AVAILABLE` 并停止，零 business、零第二个续接。

唯一 create 只返回 `clientThreadId` 时分类为 `QUEUED`，零 wait/read/navigate/recreate；只在同一次返回恰有 `threadId` 与 `hostId` 且不含 `clientThreadId` 时分类为 `READY`。mixed `{clientThreadId,threadId,hostId}` 必须 `FAILED`，零 wait/navigate/recreate。READY 在 create 阶段不得预发 navigate budget；恰好一次 `wait_threads` snapshot 成功后才可最多 navigate 一次。create 或 open 失败分别只报告固定 marker，不重试、不重建，也不把 ID 写进用户 prose。页面仍保留 legacy current-task Creator 的兼容折叠区，但它不属于 Project-history 短入口；Plugin 0.7.0 既有四工具与旧 Project Agent share 继续可读。

Project-history 计数语义固定：最多按稳定顺序选择并读完 20 个 eligible Codex 任务，`discoveredThreadCount=readThreadCount`；其余同 Project matching/non-Codex 任务计入上限 10,000 的 `omittedThreadCount`。Host 因 pinned 任务可返回超过 50 条，不得将总数强制为 50 或少报。

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
├── apps/authoring/    # @cb/authoring  创作 API 与任务 Worker
├── apps/runtime/      # @cb/runtime  会话、Turn、Artifact 与 Runtime SSE
├── apps/web/          # @cb/web  创作端 React/Vite 应用
├── apps/runtime-web/  # @cb/runtime-web  试用与 Studio React/Vite 应用
├── db/                # @cb/db   PostgreSQL 迁移 + 幂等 runner
├── infra/             # @cb/infra 编排、发布拓扑、k8s 清单、Nginx 与基础设施配置
├── scripts/           # @cb/scripts 发布渲染 / 部署 / 验收 / 集成脚本
└── .github/workflows/ # PR checks（pr-ci.yml）、Release build（ci.yml）与部署（deploy.yml）
```

更细的各包职责与设计决策，见文首「文档真源」指向的飞书文档。

---

## 验证

源码门禁统一执行 `pnpm lint`、`pnpm format:check`、`pnpm typecheck`、`pnpm typecheck:test`、`pnpm build` 和 `pnpm test`。数据库集成检查使用一个可丢弃的 PostgreSQL，验证同一候选 production image 从空库执行 `0000` 至 `0019`、面对已到 `0019` 的 live-compatible 账本再次幂等执行、应用角色权限和异常账本拒绝。

Test、Preview 与 Production 的环境证据来自 tecent2 K3s 的 `combo-test`、`combo-preview` 与 `combo-prod` namespace。受保护的 `main` 控制器可以部署自动产生的 `main` 候选，也可以部署手工选择的任意同仓库分支候选；每次部署都核对四个业务面的镜像摘要、迁移头、运行时发布身份、Web 资源摘要并验证环境域名返回对应 SHA。源码目录中的普通测试不启动 Docker 或 Docker Compose。

Agent 固定按次计费与乐收赢充值的源码验收、未完成现场证据和后续 Test 人工步骤见 [`docs/leshouying-test-acceptance.md`](docs/leshouying-test-acceptance.md)。
