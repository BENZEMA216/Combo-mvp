# apps/authoring（创作端服务）

本包是创作者业务和余额充值的写入服务。API 进程提供第一方邮箱验证码认证、任务、上传、提取、能力管理、钱包读取与乐收赢充值接口；worker 进程消费提取队列并执行租约对账。只有 API 进程持有邮件供应商、验证码 HMAC 和支付机构密钥，worker 不依赖认证投递或支付配置。

## 目录与文件

- `src/` 保存 API、worker、业务模块、基础设施适配器和测试，并由目录内的 README 继续说明各层职责。
- `package.json` 声明运行依赖、开发依赖以及构建、类型检查、测试和双进程启动命令。
- `tsconfig.json` 定义生产源码的 TypeScript 项目构建配置。
- `tsconfig.vitest.json` 为测试源码提供独立的 TypeScript 诊断配置。
- `vitest.config.ts` 定义 authoring 单元测试与 PostgreSQL 集成测试的发现规则。

`dist/` 和 `tsconfig.tsbuildinfo` 是构建生成物，`node_modules/` 是工作区依赖目录，三者都不是源码事实源。

## 上下游关系

authoring 依赖 `@cb/shared` 的接口契约，使用 PostgreSQL 保存业务、认证、充值订单与资金事实，使用 redis_queue 承载 BullMQ 队列，使用 redis_hot 承载事件流、锁和认证软限流，并通过对象存储保存上传与能力产物。浏览器只通过同源 Nginx 访问 API；runtime 不导入本包代码，而是通过同一数据库使用会话、免费额度和钱包事实。乐收赢只由 API 进程通过固定测试或正式基址访问。
