# demo — Test 环境体验数据

这个模块提供受控的 Test-only 演示数据入口，用固定的 Combo Miniapp 能力夹具绕过耗时的本机会话上传，让评审者可以继续体验 Agent 调试、UI 修改、定价与发布。它不替代真实上传/提取，也不会在 development、review 或 production 注册。

`POST /api/v1/test/demo-agents/combo-miniapp` 只接受公开站点的可信同源写请求，并要求当前 PostgreSQL 登录会话。重复调用按用户幂等：修复或复用同一条 succeeded task、processed upload 和 capability；完整 `CapabilityDefinition` 写在 `combo-artifacts/capabilities/<capabilityId>/definition.json`，数据库仍只保存轻量索引。

`fixture.ts` 定义固定可运行能力和 owner 稳定 ID，`repo.ts` 用一个数据库事务补齐三表终态，`service.ts` 按真实提取流水线的顺序先写对象存储再提交索引，`handlers.ts` 返回 `{ taskId, capabilityId, reused }` 的统一 Envelope，`routes.ts` 声明同源与鉴权守卫。模块只依赖 `platform/` 端口与 `@cb/shared` 契约。
