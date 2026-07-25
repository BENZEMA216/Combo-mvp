# 发布与运维脚本

本目录保存仓库级验证、部署和运维脚本。发布脚本不得输出、落盘、复制或提交任何环境 Secret 值；部署前只允许核对 Secret 名称与键名。需要凭据的步骤只能在对应的受保护 GitHub Environment 中运行。

`release-manifest.mjs` 创建和校验 canonical、不可覆盖的发布清单。清单把一个完整 main 源码 SHA 唯一映射到 API、Runtime、Web 三个 `repository@sha256` 镜像、迁移头和 Web 静态资源摘要。Worker 与 migration 固定使用 API 镜像。

`web-asset-manifest.mjs` 为 Web 与 Runtime Web 的实际构建文件生成严格、确定性的内容摘要清单。正式 CI 从最终 Web 镜像中提取并复验这份清单，而不是从标签或宿主构建目录推断。

Test 使用 `combo-preview`，Preview 使用 `combo-review`，Production 使用 `combo`。Preview 与 Production 从同一个已经构建并验证的 release artifact 渲染；Production 不重新构建镜像。

Test 的重置命令必须同时接收完整源码 SHA 和 GitHub workflow run ID。它在证明 PostgreSQL、Redis Queue、MinIO 三个固定目录均已清空后重建四个基础工作负载，把实际 Pod UID 和时间写入 `0600` 回执。部署命令只接受同一 SHA、同一 run ID、完成时间不超过十五分钟的回执，并通过同目录原子改名只消费一次。

Test 的迁移任务固定校验 `0006_one_running_turn_per_session.sql`，并在数据重置后的同一 PostgreSQL 中连续扫描两遍迁移目录。任务完成后，调度器立即采集实际 Job、Pod、镜像 ID 和日志摘要；日志必须精确证明 `0000`–`0006` 各应用一次，且两遍均到达 `0006`。迁移 Job 保留两小时，覆盖最长 6900 秒部署与真实浏览器验收窗口。最终证据直接嵌入重置与迁移回执，并严格枚举不含 Secret 的 Test 资源；Test workflow 会复验 SHA、run ID、回执和资源集合，再上传 `combo-test-evidence-<SHA>`。

`combo-dev-control-plane.test.mjs` 的容器镜像探针只有在 `COMBO_RUN_CONTAINER_CONTRACTS=1` 时才会调用 Docker。GitHub Actions 的受控 Test 步骤显式启用该变量；tecent2 上的普通源码检查不会探测或启动 Docker。

`goal-b-frozen-audit.test.mjs` 将固定冻结提交相对共同基线的 256 个路径，与 `docs/goal-b-frozen-preview-audit.md` 逐项比对，并强制旧迁移与旧 Cloud Review 拓扑保持明确废弃。

`goal-b-test-acceptance.mjs` 使用 tecent2 已安装的 Chrome，通过只绑定 `127.0.0.1` 的 Test Web 转发执行真实浏览器验收。它使用 Test 专属 dev-login 在内存浏览器上下文中完成任务幂等创建、合法 Claude JSONL 上传与断点恢复、能力发布、Studio 多轮和元素选择、活动轮刷新恢复、中断产物隔离、当前 UI 隔离副本试用以及返回原任务；命令行只接受完整源码 SHA、loopback Web origin 和一个尚不存在的输出文件。浏览器 HTTP(S) 和 WebSocket 都只能访问该精确 loopback origin。输出以 `0600` 创建，只保留公开发布身份、资源 UUID、检查状态与计数，不保存 Cookie、配对码、分享令牌或响应正文。

该仓库脚本目前是补充验收器，不是 `/opt/combo-dev/acceptance/run` 的源码替代品。`combo-dev-deploy.sh` 仍调用由主机所有者维护的 root-owned 基础验收器；后者还接收 `--s3-origin`，并输出供 `combo-dev-smoke.sh` 和最终 Test evidence 消费的既有检查对象。当前 workflow bundle 不安装本脚本，也不把它的 20 项数组结果合并进 `/var/lib/combo-dev/evidence/<SHA>.json`。因此在完成受信任安装或 wrapper、两种 schema 的显式合并以及 workflow 端复验之前，本脚本的 JSON 只能作为补充诊断结果，不能宣称已经进入官方 `combo-test-evidence-<SHA>`。

在 Test Web 已通过本机 loopback 转发后，从仓库根目录运行：

```sh
test_evidence_dir=$(mktemp -d)
pnpm --filter @cb/scripts acceptance:goal-b -- \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --web-origin http://127.0.0.1:18080 \
  --output "$test_evidence_dir/goal-b-browser.json"
```

仓库变量 `COMBO_PREVIEW_AUTO_PROMOTION_MODE` 必须是 `enabled` 或 `paused`。`enabled` 会把成功的 main release artifact 自动部署到 Preview；`paused` 仍保留 main 构建和 Preview policy 记录，但跳过部署 job，不改变线上 Preview。策略变更只影响之后触发的工作流，不取消已经开始的部署。

`verify-rendered-release.mjs` 在任何集群写入前复验 Kubernetes 服务端 dry-run 的原始对象：资源集合、namespace、镜像、命令、Secret 引用和 ClusterIP 边界必须精确符合环境契约。

`deploy-release.sh` 把 Preview 与 Production 的数据视为可丢弃测试数据，在共享主机锁内执行精确盘点和停写。首次切换先建立空的 PostgreSQL、Redis 和 MinIO，再完成 bucket 初始化与单对象冒烟，然后执行 `0000` 至 `0006` 迁移并启动 API、Worker、Runtime 和 Web，最后通过 loopback 与 Nginx 事务切流并清理旧对象。后续发布复用已验证的 release foundation 与 PVC，只替换 SHA 隔离的应用、迁移和初始化对象。Secret、TLS、namespace 和无关资源始终不在删除范围；脚本只检查 Secret 名称和键名。

`switch-release-traffic.sh` 为 Preview 与 Production 分别维护 Web 和 MinIO 的 loopback forwarder，并在一次事务里切换 Nginx。任一监听、健康检查、Nginx 校验或公网验证失败时，会恢复切换前的 unit 与 Nginx 状态。
