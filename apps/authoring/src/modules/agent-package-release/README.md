# modules/agent-package-release — 受控 Test Agent Package 发布

这个模块提供 Test 环境中唯一固定知识 Agent 的 Package Registry 写入面。路由只在发布身份、候选源码提交、唯一发布者账号和预期 Package digest 同时命中配置 gate 时注册；gate 缺失或候选漂移时两个端点都保持 404，Preview、Production 或 worker 配置 gate 会在启动时失败。

## 文件

- `routes.ts` 声明创建与按 Release ID 读取两个端点，复用第一方 Cookie 登录、精确浏览器来源、JSON 请求体上限和安全错误信封。非 gate 发布者与不属于当前发布者的 Release 都返回 404。
- `service.ts` 严格解析规范 base64，校验 `agent.json`、三个固定文件、Knowledge Bundle 和 exact digest；它按 digest 与固定清单路径顺序提交不可覆盖对象并逐个回读，最后才写 `agent.json`。对象完整后，仓储在同一 PostgreSQL 事务和 advisory lock 内追加 Package marker 与 immutable Release，并以发布者、幂等 UUID 和请求摘要保证 exactly-once。

## 上下游

路由由 `bootstrap/routes.ts` 在受控 gate 生效时挂到 `/api/v1`。模块使用 `@cb/creator-agent-protocol` 校验唯一 Agent Package 与 Release 合同，使用 `platform/infra/object-store.ts` 的有界不可覆盖字节原语，并通过 `combo_api` 数据库角色访问 canonical Registry。

数据库结构来自迁移 `0016_agent_package_registry.sql`，该迁移是部署前置依赖，不由本模块复制或回退创建。模块不读取旧 `agent_releases`，不维护 latest 指针，不接受客户端 owner、对象键、Package digest、Release ID、价格或知识选择器，也不修改 Runtime、支付或 Web。
