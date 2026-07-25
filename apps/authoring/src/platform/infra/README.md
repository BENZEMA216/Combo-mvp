# platform/infra — 基础设施客户端

这个目录放所有外部依赖的客户端与端口实现：PostgreSQL、双 Redis、BullMQ 队列、MinIO 对象存储、Logto 登录服务、分布式锁、dev 种子会话，以及大模型网关（细节在子目录 `llm/`）。统一风格是惰性创建（不在启动期强连，无 Docker 也能跑编译和单测）、探针短超时、错误收口为分类结果而不裸抛。

## 文件

- `index.ts` 是容器组装入口：buildInfra 把连接池、双 Redis、队列端口、对象存储端口、LLM 网关聚成 InfraContext 注入 Fastify 的 app.infra，并转出各文件的全部导出。
- `db.ts` 管 PostgreSQL 连接池单例（pg），定义单测可注入的最小查询接口 Queryable，提供 SELECT 1 探针、优雅关闭，以及各业务仓储共用的行映射助手 toIso（timestamptz 转 ISO 字符串）。
- `db-tx.ts` 是最小事务抽象：withTransaction 从池里领一条连接执行 BEGIN/COMMIT/ROLLBACK，保证回调内多表写入原子提交；asTxPool 把 pg.Pool 适配成可 mock 的事务池。
- `redis.ts` 管两个 Redis 单例：redis_queue 给 BullMQ 专用，redis_hot 给进度流和锁；含 PING 探针和关闭。
- `queue.ts` 用 BullMQ 实现队列端口：只有 task-pipeline 一条队列，jobId 就是 taskId 所以等待期间重复入队自动去重，不开框架级自动重试（重试是业务语义）；Queue 和 Worker 都安装不接收错误对象的安全监听器，避免 BullMQ 的依赖或内部错误把连接材料写入默认错误输出，恢复结果仍由业务状态和探针判断。
- `object-store.ts` 用 AWS S3 SDK 实现对象存储端口（MinIO 兼容）：读写删列举加预签名 URL；预签名用单独的「浏览器可达」端点客户端；readStreamToString/Bytes 统一处理响应体的多种流形态。
- `lock.ts` 基于 redis_hot 实现分布式锁端口：SET NX 抢锁，Lua 脚本保证只有持锁者能续期和释放。
- `logto.ts` 是 Logto 验签核心：从 OIDC 发现文档取 JWKS 验 JWT，区分 access_token 与 id_token 两种受众，把失败分成「token 无效」和「上游不可达」两类，另提供就绪探针。
- `logto-oidc.ts` 是授权码登录流辅助：构建授权 URL（PKCE）、用授权码换 token、构建登出 URL、回跳路径白名单、随机串工具。
- `dev-session.ts` 是仅 dev/test 的种子会话：双守卫判定（非生产且开关开且密钥非空）、HS256 自签与验签、默认测试用户。
- `llm-gateway.ts` 是 LLM 网关的兼容层入口，真实现在 `llm/` 子目录，本文件只转出 createLlmGateway 和 probeLlm。

## 上下游

被谁使用：`bootstrap/app.ts` 调 buildInfra 注入容器，业务 handler 经 req.server.infra 取用；`processes/worker.ts` 直接调 getPool、getHotRedis、createBullQueuePort、createS3ObjectStore、createLlmGateway；`platform/http/health.ts` 调各探针；`platform/middleware/auth.ts` 调 logto.ts 与 dev-session.ts；`modules/account/` 调 logto.ts、logto-oidc.ts、dev-session.ts；`modules/task/` 用 db、db-tx、queue 的类型与常量。

依赖什么：`platform/config/env.ts` 提供配置。外部资源：PostgreSQL、redis_queue 与 redis_hot 两个 Redis 实例、MinIO/S3、Logto 服务，以及经 `llm/` 触达的大模型上游。
