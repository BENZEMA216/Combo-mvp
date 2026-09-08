# modules/agent-package-release — 受控 Test Agent Package 发布

## 浏览器授权的轻量 Agent 上传与公开链接

`transfer-routes.ts` 另行提供 10 个 Test-only 端点；仅 `COMBO_ENVIRONMENT=test` 注册，Preview/Production 不开放。
这不替代下面的旧固定知识 Agent 发布 gate。链接 origin 只来自已验证的 `PUBLIC_APP_ORIGINS` 首项，不读取 Host 头。

- `transfer-contract.ts` 定义严格元数据、精确双摘要确认和白名单回执。Desktop 先在本地生成短期上传 secret，
  服务端只收 SHA-256；secret 不进入 URL、浏览器、回执、日志或公开 Package。数据库固定 10 分钟有效期。
- `transfer-service.ts` 区分 metadata intent、Cookie 账户批准、Bearer 私有上传与只读恢复。只有批准过的精确
  request ID、名称、Draft fingerprint 和 Package digest 才能写入。状态行锁和私有 Draft 仓储复用同一连接/事务，
  不嵌套 checkout；重复请求回读原结果。事务使用局部语句/锁超时；HTTP 对象操作有合计 30 秒与请求中断信号。
- `publication-service.ts` 要求独立 Cookie + exact Origin + `confirmPublic:true`。短期上传 secret 不能发布。
  它回读账户已保存的精确 Draft/Package，先写不可覆盖公共文件，再按账户与原始请求 ID 追加 claim/Release 并推进 phase，
  后三项同事务；失败可留下无公开 Release 的不可变对象，但不能留下部分公开结果。多个账户可以独立发布相同 digest，
  历史 Package owner 不被改写。已上传内容可在 token 过期后由同一 Cookie 账户继续查看和明确发布。
- `publication-objects.ts` 限制 manifest、文件数量、路径和总字节，对每份文件校验 exact digest；资源先于清单写入且全部回读。
  公共 GET 仅返回未撤销的 `public_link` Release 与完整核验后的 Package，下载是裸 Package JSON；不含私有 Draft、
  creator request、账户邮箱、上传 secret 或原对话。公开请求不解析会话，不安装、不试跑，来源固定 `not_verified`。
- `receiver-handoff.ts` 从已核验且未撤销的公开 Release 生成 Codex 接收说明与可复制指令。它只读取 Worker 显式
  `agent-package-receiver` 出口对应的已构建资产，计算摘要并按内容哈希地址提供 JavaScript 下载，绝不在 API 中
  导入或执行安装器。资产缺失、摘要地址过时或 Release 不可用时失败关闭。接收说明不保存 Project 路径、用户
  凭据或运行结果；项目选择、下载后独立验码、安装和当前任务应用都由使用者自己的 Codex 执行。

匿名 `GET /agent-package-publications/:releaseId/codex-installation` 返回固定版本安装器的地址、摘要、调用参数和
安全步骤；`GET /agent-package-receivers/v1/:artifactFile` 只返回与当前资产摘要完全匹配的 `.mjs` 字节。两者不
解析 Cookie、不写数据库、不安装任何内容，仍受 Test-only、无查询参数、速率和 `no-store` 边界约束。接收器只
支持轻量文本方法；文本存储不代表所需工具已满足。安装、离线完整性、同任务应用及真实推理必须分别验收。

所有新接口返回安全错误与 `no-store`。Desktop 请求拒绝 Cookie、Origin、Fetch Metadata 的 Site、Dest、User
和查询参数凭据；Mode 只允许缺失或 Node 原生 fetch 固定附加的 `cors`，它不提供认证，也不豁免其他浏览器信号。
浏览器写入在解析正文前检查 Cookie 与精确来源。元数据/确认体 4 KiB，上传体 1 MiB，均有独立速率限制。GET 不推进状态。
当前轻量 Test 客户端和页面只使用配置中的同一个规范公开 origin，不支持把第二个登录 allowlist origin 当作分享入口。
错误或超时不得换 request ID 自动发布；应先 GET 原意图确认事实，再由用户明确重试相同请求。
数据库依赖主线 `0020` 私有快照与 `0021` claims、revocations、transfer 状态机；不在请求中建表或修改旧数据。
这些是实现与测试边界，不等同真实对象存储、部署、浏览器 UAT 或使用者实际加载验收已通过。

## 固定知识 Agent 的历史受控入口

这个模块提供 Test 环境中唯一固定知识 Agent 的 Package Registry 写入面。路由只在发布身份、候选源码提交、唯一发布者账号和预期 Package digest 同时命中配置 gate 时注册；gate 缺失或候选漂移时两个端点都保持 404，Preview、Production 或 worker 配置 gate 会在启动时失败。

## 文件

- `routes.ts` 声明创建与按 Release ID 读取两个端点，复用第一方 Cookie 登录、精确浏览器来源、JSON 请求体上限和安全错误信封。非 gate 发布者与不属于当前发布者的 Release 都返回 404。
- `service.ts` 严格解析规范 base64，校验 `agent.json`、三个固定文件、Knowledge Bundle 和 exact digest；它按 digest 与固定清单路径顺序提交不可覆盖对象并逐个回读，最后才写 `agent.json`。对象完整后，仓储在同一 PostgreSQL 事务和 advisory lock 内追加 Package marker 与 immutable Release，并以发布者、幂等 UUID 和请求摘要保证 exactly-once。

## 上下游

路由由 `bootstrap/routes.ts` 在受控 gate 生效时挂到 `/api/v1`。模块使用 `@cb/creator-agent-protocol` 校验唯一 Agent Package 与 Release 合同，使用 `platform/infra/object-store.ts` 的有界不可覆盖字节原语，并通过 `combo_api` 数据库角色访问 canonical Registry。

历史受控入口数据库结构来自迁移 `0017_agent_package_registry.sql`，该迁移是部署前置依赖，不由本模块复制或回退创建。该入口不读取旧 `agent_releases`，不维护 latest 指针，不接受客户端 owner、对象键、Package digest、Release ID、价格或知识选择器，也不修改 Runtime 或支付。
