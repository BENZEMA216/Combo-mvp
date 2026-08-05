# @cb/shared — 前后端共享契约包

这个包是 authoring、runtime、web 与 runtime-web 共同使用的契约真源。生产代码位于 `src/`，编译结果输出到忽略版本控制的 `dist/`。包内只包含运行时校验、类型、常量、基础设施接口和无副作用工具，不连接数据库或外部服务。

## 文件

- `package.json` 声明包入口、Zod 运行时依赖以及构建、类型检查和测试命令。
- `tsconfig.json` 编译生产源码并生成 ESM、类型声明和 source map。
- `tsconfig.vitest.json` 对测试源码执行不产物的严格类型检查。
- `vitest.config.ts` 配置共享包的单元测试。
- `src/` 保存全部手写源码，目录职责与上下游关系记录在 `src/README.md`。

## 认证契约

邮箱验证码登录的请求、结果、成功包络、当前用户视图、登出结果、显式 HTTPS `__Host-cb_session` 与本地 HTTP `cb_session` 策略和安全站内回跳函数统一定义在 `src/domains/auth.ts`。验证码和会话失败使用 `src/core/errors.ts` 中的安全错误映射，对外错误信封不包含内部错误码。健康契约不把邮件供应商列为就绪依赖，因此已有会话和普通业务请求不依赖新邮件投递。

远程 MCP 的 OAuth 发现、动态客户端注册、PKCE 授权码和令牌响应契约统一定义在 `src/domains/mcp-oauth.ts`。浏览器 Cookie 只负责用户在授权页确认身份；MCP 请求只接受数据库中摘要化保存且绑定资源地址的 Bearer Token。

## 使用与验证

Agent Builder 也从本包读取 `AgentDefinition`、Project、Revision、Test、Project Test 恢复列表与 Release 契约。恢复列表独立覆盖 `starting` claim，查询默认 20 条且硬限制为 50 条；Agent Revision 通过稳定 JSON 编码计算内容摘要，测试和发布必须引用同一份不可变 Runtime Bundle。

业务包通过 `@cb/shared` 根入口导入契约，不引用 `dist/` 内部路径，也不在各应用重复定义相同 schema。`pnpm -F @cb/shared typecheck` 检查生产源码，`pnpm -F @cb/shared typecheck:test` 检查测试源码，`pnpm -F @cb/shared test` 运行单元测试。
