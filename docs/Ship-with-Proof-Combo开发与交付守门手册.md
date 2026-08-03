# Ship with Proof：Combo 开发与交付守门手册

> 飞书备份：[Ship with Proof：Combo 开发与交付守门手册](https://zcndjgnt0026.feishu.cn/docx/WQg3d7MaKomhH6xBymVcD1p0nLc)

这套规范用于确保 Combo 的产品真源、代码版本、运行环境和验收证据始终对应同一个事实。它解决的不是单个 UI Bug，而是开发过程中最容易被忽略的“事实分叉”：设计在一个分支、服务运行在另一个目录、Mock 被当成真实功能、CI 成功被误认为线上已经更新。

## 一页执行清单

### 开发前

- 确认唯一生效的 Product Flow Contract。
- 写清本次目标、范围外内容和完成标准。
- 核对仓库、分支、HEAD、origin/main、dirty 状态和 worktree。
- 一个任务只使用一个固定分支和一个固定 worktree。

### 启动环境前

- 检查端口旧进程的 PID、命令和 cwd。
- 确认 Web、API、Runtime 的 SHA 与兼容关系。
- 明确数据模式和登录模式是 Real、Mock 还是 Mixed。
- 检查磁盘和关键依赖健康状态。

### 提供体验地址前

- 页面或 `/version.json` 能展示环境与 SHA。
- 从公开入口真实点击到本次目标结果。
- 验证刷新、返回、重新登录和异步恢复。
- 附上体验交付卡片，明确 Mock 与未完成部分。

### 合并与发布前

- Commit、Push、PR、CI、Merge、Deploy 分别提供证据。
- Cloud Review 和 Production 核对实际返回的 SHA。
- 没有真实走通的部分不能写成“完整链路已通过”。

## 核心原则

> 产品真源 → 代码版本 → 运行环境 → 验收证据

四者必须绑定。URL 只是入口，不是版本证据；计划和设计稿只是意图，不是执行证据；通过构建只说明代码可以构建，不说明用户流程可以完成。

## 产品真源

仓库必须只有一个标记为 `Active` 的 Product Flow Contract。旧文档必须标记为 `Superseded` 或 `Archived`，并写明被哪一个版本替代。

判断冲突时采用以下优先级：用户当前明确指令、Active 产品流程、实时代码与服务证据、本次测试证据、历史设计与旧文档。影响页面、状态或跳转的冲突必须先解决，不能自行选择一个版本继续开发。

## Combo 当前默认主链路

```text
Landing
→ 选择两种同等权重的 Context 准备方式
  ├─ 复制任务给 Coding Agent
  └─ 提交公开主页链接或内容
→ 上传或同步 Context
→ 绑定邮箱并认领匿名草稿
→ 生成 Agent
→ 反复调整内容、效果和 UI
→ 使用真实任务试用
→ 满意，进入定价
→ 选择计费方式
→ 命名链接或子域名
→ 发布确认
→ 发布结果与公开页
```

两种 Context 方式必须汇入同一种 Agent Draft 和同一套调试、定价与发布状态。调试必须形成“修改—保存版本—预览—真实试用—继续修改或进入定价”的循环。刷新、离开或重新登录后，用户要能回到同一个 Draft、Agent、版本和阶段。

## 分支与 Worktree

一个任务对应一个 `codex/*` 分支和一个固定 worktree。分支从实时确认的远端 SHA 创建。已经启动服务的 worktree 禁止切换分支；切换代码版本后必须停止旧进程、重新构建并启动。

用户已有的 dirty checkout 是用户资产。不得用 `reset --hard`、`clean -fd` 或覆盖文件的方式消除。大型流程迁移必须先列出来源文件、目标文件、路由、状态和测试清单。

## 环境与版本身份

统一使用四个名称：Local Review、PR Preview、Cloud Review、Production。每个环境至少提供仓库、分支、Web/API/Runtime SHA、dirty、数据模式、登录模式和启动时间。推荐提供 `/__meta/build` 或 `/version.json`，并在非生产页面显示小型 Build 胶囊。

同一个本地端口不得在不重启的情况下代表不同分支。端口复用前必须检查旧进程 cwd；若不属于目标 worktree，先停止旧进程。

## Mock 与真实服务

测试分成三层：静态视觉评审、Mock 完整流程、Cloud Review 真实链路。三者不能互相代替。

Mock 必须显式标识，使用真实 API schema 和可重复 fixtures，并支持刷新和重新进入。Mock 登录、Mock 发布不能被描述成真实功能通过。Mixed 模式必须逐项列出哪些服务真实、哪些是 Mock。

## 页面、状态和跳转

每个页面都要记录用户目标、URL、核心实体、前置条件、入口、唯一主动作、成功去向、刷新恢复、异步恢复、错误恢复、权限状态、数据模式和验收证据。

路由存在不等于流程存在。每个 CTA 都必须产生真实状态迁移、真实路由跳转或显式的 Mock 行为。不能出现死按钮、只能靠浏览器历史返回的死路，也不能要求用户手改 URL 才能完成主流程。

## 完整可体验的标准

只有当用户能从 Landing 出发，不手改 URL 地完成 Context、认领草稿、生成 Agent、多轮调整、真实试用、定价、命名、发布和公开结果，并能在刷新、离开和重新登录后继续，才可以写“完整链路可以体验”。

如果只验证了 Landing、登录、Agent 列表或部分 Runtime，必须写“局部页面可体验”。

## 前端产品表达

页面要使用用户目标语言，不让用户理解 Runtime、Artifact、内部 Revision 或 Review 基础设施。按钮应写成“修改页面”“试用 Agent”“满意，去定价”“查看试用结果”等明确目标。

生成过程要说明当前阶段、已经保留的内容、是否可以离开、如何回来继续。不要用一个没有真实信息的全屏 Loading 代替整个页面。已形成的 Agent 放在“我的 Agent”，进行中的 Draft 和异步任务放在“创作进度”，侧边栏提供当前创作的“继续”入口。

## 错误处理与可观测性

三条硬规则是：永不裸转圈、绝不裸露内部错误码、已生成内容不丢。

错误页面必须说明发生了什么、数据是否保留、用户下一步做什么、应该重试还是重新登录，并提供 traceId。Web、API、Runtime 日志应同时包含环境、build SHA、traceId 以及 User、Session、Draft、Job 等关联标识。

401、502、连接过期和任务失败若无法通过 traceId 查到原因，则不能通过真实链路验收。

## CI/CD 与事实用语

标准过程是：开发、本地验证、Commit、Push、PR、CI、Merge、Cloud Review 部署、部署后 E2E、Production 发布。

“已开发”需要 worktree 和修改文件；“已验证”需要命令、结果和 SHA；“已提交”需要 commit SHA；“已推送”需要远端分支 SHA；“CI 通过”需要同一 SHA 的 checks；“已合入”需要 main SHA；“已部署”需要 URL、部署 ID 和服务返回 SHA；“Production 已发布”还需要正式地址和冒烟结果。

Commit 不能说成 Push，Push 不能说成 Merge，CI build 不能说成 Deploy，Cloud Review 不能说成 Production。本地成功也不能替代可共享环境。

## 五条红线

1. 不知道目录、分支和 SHA，不提供体验地址。
2. 没有从入口真实走到结果，不称“完整链路”。
3. 没有验证远端 main 和部署 SHA，不称“已经合码并发布”。
4. Mock 和真实环境边界不清，不开展产品验收。
5. 产品真源存在冲突，不继续堆页面。

## 配套 Skill

仓库内的 `.agents/skills/ship-with-proof/` 提供完整的 Agent Skill、产品流程模板、页面状态矩阵、体验交付卡片、发布证据模板，以及只读的启动前检查和交付报告脚本。
