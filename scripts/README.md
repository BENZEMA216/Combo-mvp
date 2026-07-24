# 发布与运维脚本

本目录保存仓库级验证、部署和运维脚本。发布脚本不得输出、落盘、复制或提交任何环境 Secret 值；部署前只允许核对 Secret 名称与键名。需要凭据的步骤只能在对应的受保护 GitHub Environment 中运行。

`release-manifest.mjs` 创建和校验 canonical、不可覆盖的发布清单。清单把一个完整 main 源码 SHA 唯一映射到 API、Runtime、Web 三个 `repository@sha256` 镜像、迁移头和 Web 静态资源摘要。Worker 与 migration 固定使用 API 镜像。

`web-asset-manifest.mjs` 为 Web 与 Runtime Web 的实际构建文件生成严格、确定性的内容摘要清单。正式 CI 从最终 Web 镜像中提取并复验这份清单，而不是从标签或宿主构建目录推断。

Test 使用 `combo-preview`，Preview 使用 `combo-review`，Production 使用 `combo`。Preview 与 Production 从同一个已经构建并验证的 release artifact 渲染；Production 不重新构建镜像。

仓库变量 `COMBO_PREVIEW_AUTO_PROMOTION_MODE` 必须是 `enabled` 或 `paused`。`enabled` 会把成功的 main release artifact 自动部署到 Preview；`paused` 仍保留 main 构建和 Preview policy 记录，但跳过部署 job，不改变线上 Preview。策略变更只影响之后触发的工作流，不取消已经开始的部署。

`verify-rendered-release.mjs` 在任何集群写入前复验 Kubernetes 服务端 dry-run 的原始对象：资源集合、namespace、镜像、命令、Secret 引用和 ClusterIP 边界必须精确符合环境契约。

`deploy-release.sh` 把 Preview 与 Production 的数据视为可丢弃测试数据，在共享主机锁内执行精确盘点和停写。首次切换会删除白名单内的旧数据卷，并按 `fresh PostgreSQL/Redis/MinIO → bucket init 与单对象冒烟 → migration 0000–0006 → API/Worker/Runtime/Web → loopback 与 Nginx 事务切流 → legacy cleanup` 顺序完成发布；后续发布复用已验证的 release foundation 与 PVC，只替换 SHA 隔离的应用、迁移和初始化对象。Secret、TLS、namespace 和无关资源始终不在删除范围；脚本只检查 Secret 名称和键名。

`switch-release-traffic.sh` 为 Preview 与 Production 分别维护 Web 和 MinIO 的 loopback forwarder，并在一次事务里切换 Nginx。任一监听、健康检查、Nginx 校验或公网验证失败时，会恢复切换前的 unit 与 Nginx 状态。
