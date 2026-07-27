# 基础设施目录

本目录维护本地 Compose、生产覆盖层、Kubernetes 清单、容器镜像和同源 Nginx 入口。

- `docker-compose.yml` 定义生产口径的 PostgreSQL、双 Redis、MinIO、观测组件、数据库迁移和业务服务。迁移容器用独立 PostgreSQL 连接字段接收数据库所有者凭据，不把原始密码拼进 URI；authoring API、worker 与 runtime 使用三份 URL 安全的独立应用角色凭据。authoring API 从环境变量读取 Resend、邮箱发件人、公开站点来源和验证码摘要密钥；runtime 只读取共享 PostgreSQL 会话，并与 authoring 共用精确公开站点来源。
- `docker-compose.dev-test.yml` 只用于本地测试，并增加 Resend HTTP 替身。它不会被生产覆盖层或生产清单引用。
- `docker-compose.prod.yml` 为部署环境改用已经发布的业务镜像，并收紧宿主端口。
- `Dockerfile.api`、`Dockerfile.runtime` 和 `Dockerfile.web` 构建三个生产镜像。authoring 镜像同时包含迁移入口所需的应用角色配置脚本。`Dockerfile.resend-mock` 只构建测试替身。
- `resend-mock/` 保存无第三方依赖、无访问日志的测试邮件服务及其单元测试。
- `nginx.conf` 把 React、authoring API 和 runtime API 放在同一个站点下，使两端共享主机限定的 HttpOnly 会话 Cookie。生产 Cookie 使用 `__Host-` 前缀、Secure、根路径且没有 Domain；本地 HTTP 测试使用无前缀名称。访问日志只保留请求方法、响应状态和耗时；请求期错误日志写入空设备，避免上游故障把客户端地址、Cookie、原始 URL 或查询字符串写入容器日志。
- `k8s/` 保存生产 Kubernetes 清单。只有 authoring API Pod 接收 Resend 与验证码密钥。
- `minio/`、`redis/` 和 `observability/` 保存各基础设施组件的静态配置。
