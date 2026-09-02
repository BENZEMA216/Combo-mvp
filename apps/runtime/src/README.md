# Runtime 服务源码总览

这个目录保存 Capability 试用和 Studio 编辑后端。服务负责 PostgreSQL 不透明会话读取、Capability 加载、受控 Test 的 Agent Package 解析、普通与 Studio Session、免费额度与钱包计费、Turn、Pi Agent、Redis SSE、Artifact、知识用量 receipt 和可选沙箱工具。

## 文件与目录

- `index.ts` 加载 `processes/api.js`，作为包的默认启动入口。
- `bootstrap/` 组装环境变量、基础设施、TurnRunner、Fastify 插件、健康检查和业务路由。
- `processes/` 保存进程入口，目前只有 API 进程。
- `modules/` 保存 capability、session、artifact、billing、agent 和 knowledge-agent 六个业务模块。
- `platform/` 保存配置、数据库、Redis、对象存储、不透明会话读取、模型选择、沙箱后端、HTTP 公共设施和观测接线。
- `__tests__/` 保存单元测试、忠实假件和显式启用的 PostgreSQL、Redis 集成测试。

## 消息提交路径

浏览器写请求先通过严格 `PUBLIC_APP_ORIGINS` 白名单守卫，再按 `SESSION_COOKIE_SECURE` 读取对应的不透明会话 Cookie。鉴权中间件校验格式、计算摘要并联查 `auth_sessions` 与 `users`，随后把用户身份挂到请求上。

Session 处理器重新校验 owner 并加载 Capability。legacy Capability v1 继续运行 CapabilityDefinition；受控 Test 的 Capability v2 会先按 Registry 和 Package digest 解析固定知识资源，并在 Session 创建时冻结 Release、Package 和资源摘要。知识 Test gate v1 只接受预置精确答案，gate v2 允许陌生问题但只接受得到本轮引用 excerpt 保守词法支持的候选。发消息请求必须携带 `usageId`。TurnRunner 在事务中锁定 active Session，先判断 owner 免计费、免费额度或钱包余额，再原子插入计费预留、`running` Turn 和轮内用户消息；余额不足时不会创建 Turn，数据库唯一索引保证同一 Session 只有一个运行轮次。

legacy 异步执行会读取已完成历史，挂载可信的 `upsert_artifact`，并在功能开启时追加四个远程沙箱工具。受控知识执行只挂载检索和候选提交工具，模型文本与 transcript 不进入 Message、Redis 或 SSE；平台验证后的回答、结算或释放和不可变 receipt 在同一事务内提交。两类执行都只在 PostgreSQL 终态完成后写入可修复且按 Turn 幂等的 Redis 终态事件。Studio 只有在 Turn 成功时才晋升当前 UI。
