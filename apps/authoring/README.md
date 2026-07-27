# apps/authoring（创作端服务）

本包是创作者业务的唯一写入服务。API 进程提供第一方邮箱验证码认证、任务、上传、提取和能力管理接口；worker 进程消费提取队列并执行租约对账。只有 API 进程持有邮件供应商与验证码 HMAC 密钥，worker 不依赖认证投递配置。

## 目录与文件

- `src/` 保存 API、worker、业务模块、基础设施适配器和测试，并由目录内的 README 继续说明各层职责。
- `package.json` 声明运行依赖、开发依赖以及构建、类型检查、测试和双进程启动命令。
- `tsconfig.json` 定义生产源码的 TypeScript 项目构建配置。
- `tsconfig.vitest.json` 为测试源码提供独立的 TypeScript 诊断配置。
- `vitest.config.ts` 定义 authoring 单元测试与 PostgreSQL 集成测试的发现规则。

`dist/` 和 `tsconfig.tsbuildinfo` 是构建生成物，`node_modules/` 是工作区依赖目录，三者都不是源码事实源。

## 上下游关系

authoring 依赖 `@cb/shared` 的接口契约，使用 PostgreSQL 保存业务与认证事实，使用 redis_queue 承载 BullMQ 队列，使用 redis_hot 承载事件流、锁和认证软限流，并通过对象存储保存上传与能力产物。浏览器只通过同源 Nginx 访问 API；runtime 不导入本包代码，只读取同一数据库中的会话事实。
