# 发布与运维脚本

本目录保存仓库级验证、部署和运维脚本。发布脚本不得输出、落盘、复制或提交任何环境 Secret 值；部署前只允许核对 Secret 名称与键名。需要凭据的步骤只能在对应的受保护 GitHub Environment 中运行。

`release-manifest.mjs` 创建和校验 canonical、不可覆盖的发布清单。清单把一个完整 main 源码 SHA 唯一映射到 API、Runtime、Web 三个 `repository@sha256` 镜像、迁移头和 Web 静态资源摘要。Worker 与 migration 固定使用 API 镜像。

`web-asset-manifest.mjs` 为 Web 与 Runtime Web 的实际构建文件生成严格、确定性的内容摘要清单。正式 CI 从最终 Web 镜像中提取并复验这份清单，而不是从标签或宿主构建目录推断。

Test 使用 `combo-preview`，Preview 使用 `combo-review`，Production 使用 `combo`。Preview 与 Production 从同一个已经构建并验证的 release artifact 渲染；Production 不重新构建镜像。

浏览器认证 origin 由发布渲染固定：Test 只允许 `http://127.0.0.1:18080`，Preview 只允许 `https://review.43-160-242-46.sslip.io`，Production 同时允许验收入口 `https://agora.43-160-242-46.sslip.io`、正式入口 `https://buildwithcombo.com` 和别名 `https://www.buildwithcombo.com`。

Test 的重置命令必须同时接收完整源码 SHA、GitHub workflow run ID 和 run attempt。它在证明 PostgreSQL、Redis Queue、MinIO 三个固定目录均已清空后重建四个基础工作负载，把三元身份、实际 Pod UID 和时间写入 attempt-scoped 的 `0600` 回执。部署命令只接受同一 SHA、同一 run ID、同一 run attempt、完成时间不超过十五分钟的回执，并通过同目录原子改名只消费一次。

Test 的迁移任务固定校验 `0008_application_database_roles.sql`，并在数据重置后的同一 PostgreSQL 中连续扫描两遍迁移目录。任务完成后，调度器立即采集实际 Job、Pod、镜像 ID 和日志摘要；日志必须精确证明 `0000`–`0008` 各应用一次，且两遍均到达 `0008`。迁移 Job 保留两小时，覆盖最长 6900 秒部署与真实浏览器验收窗口。最终证据直接嵌入重置与迁移回执，并严格枚举不含 Secret 的 Test 资源；Test workflow 会复验 SHA、run ID、run attempt、嵌套对象 exact schema、回执和资源集合，同时拒绝裸 GitHub/AWS 凭据形态，再上传 attempt-scoped 的 `combo-test-evidence-<SHA>-<Test-attempt>`。

`combo-dev-logs.sh` 在真实验收完成后读取八个唯一就绪日志源，要求 API、Runtime 和 Worker 都留下当前窗口活动，并扫描合成标记及固定凭据模式。依赖恢复导致容器重启时，它只接受至多一次可审计重启，并同时检查该 Pod 的 current 与 previous 日志；日志流尚未追平时会短时重试。失败时只能输出固定 reason code，不能回显日志正文、请求内容或合成标记。

Test 的 root-owned dispatcher 和 `combo-dev-smoke.sh` 只判定迁移、运行态、存储、网络、健康、日志与发布身份等基础设施事实，不再调用旧的 `/opt/combo-dev/acceptance/run` 或声明产品验收通过。部署基线允许空数据 Worker 暂无 pipeline，邮箱 OTP、双身份隔离和六区产品流程只由不可变 main CI artifact 中的浏览器 runner 判定；浏览器完成后再执行要求 Worker 活动的八来源日志泄漏审计。dispatcher 会写入两小时有界的待验收标记；端口、浏览器、日志、evidence、artifact 上传或完成确认失败时，受保护 workflow 使用独立最小 fencer 关闭 Test 写入面，不清数据、不生成新的 reset proof，硬取消时由持久 guard 在期限后收敛。

`combo-dev-control-plane.test.mjs` 的容器镜像探针只有在 `COMBO_RUN_CONTAINER_CONTRACTS=1` 时才会调用 Docker。GitHub Actions 的受控 Test 步骤显式启用该变量；tecent2 上的普通源码检查不会探测或启动 Docker。

`goal-b-frozen-audit.test.mjs` 将固定冻结提交相对共同基线的 256 个路径，与 `docs/goal-b-frozen-preview-audit.md` 逐项比对，并强制旧迁移与旧 Cloud Review 拓扑保持明确废弃。

`goal-b-test-acceptance.mjs` 是 Test、Preview 和 Production 共用的受控真实浏览器 runner。它使用 tecent2 已安装的 Chrome，在 Test 固定 loopback、Preview 固定 Review 入口或 Production 正式域名上完成任务幂等创建、合法 Claude JSONL 上传与断点恢复、能力勾选和 UI 发布、Studio 多轮与元素选择、Runtime SSE 断线重连和终态 replay、中断 Turn 的服务端失败产物隔离、当前 UI 隔离副本试用以及返回原任务。Studio 验收按服务端接受的精确 Turn ID 等待；若 Turn 已进入失败、中断或“完成但无 Artifact”状态，会立即记录固定白名单诊断码，不保存原始错误或继续空等。Preview 还验证 Web 与 Runtime badge 的完整发布身份和真实剪贴板内容，并通过页面 bootstrap 恢复 gate 内会话及拒绝恶意 returnTo。三个环境都使用 run-scoped Resend 测试别名完成两组独立邮箱 OTP 登录和 owner 隔离。

Test workflow 从 attempt-scoped 的不可变 `combo-release-<SHA>-<source-CI-attempt>` artifact 安装 runner、`resend-sent-email.mjs` 和 `playwright-core.tgz`，把成功结果与 Test promotion identity 一并放入 `combo-test-evidence-<SHA>-<Test-attempt>`；Preview 和 Production 复用同一 artifact 中的文件。CI、Test、Preview 和 Production 的成功证据 artifact 名都包含实际 producer attempt，rerun 不会覆盖或混入前一次 attempt。失败结果经过独立的 exact-schema 校验后只上传到 run/attempt 唯一的 `combo-test-failure-evidence-<SHA>-<run>-<attempt>`，它不包含 `source-release.json`，不能作为 Preview 准入。`ACCEPTANCE_RESEND_API_KEY` 必须是对应 GitHub Environment 中可读取 sent-email API 的受保护 Secret；Production 在任何环境变更前用 artifact 内同一 helper 验证该权限。浏览器网络只允许对应应用 origin，Resend 读取由 Node helper 完成。输出以 `0600` 创建，只保留公开发布身份、资源 UUID、检查状态与计数，不保存邮箱、OTP、Cookie、配对码、分享令牌、凭据或响应正文。

在 Test Web 已通过本机 loopback 转发后，从仓库根目录运行：

```sh
test_evidence_dir=$(mktemp -d)
pnpm --filter @cb/scripts acceptance:goal-b -- \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --web-origin http://127.0.0.1:18080 \
  --output "$test_evidence_dir/goal-b-browser.json"
```

仓库变量 `COMBO_PREVIEW_AUTO_PROMOTION_MODE` 必须是 `enabled` 或 `paused`。`enabled` 会把成功的 main release artifact 自动部署到 Preview；`paused` 仍保留 main 构建和 Preview policy 记录，但跳过部署 job，不改变线上 Preview。策略变更只影响之后触发的工作流，不取消已经开始的部署。

晋级工作流通过受保护的 `vars` 准入快照和 Preview policy 输出读取该模式，不使用
内置 `GITHUB_TOKEN` 无权访问的 Repository Variables REST endpoint。Test 在实际
mutation 前和上传 bundle 后都会复验当前候选只有一个 attempt 1 的 paused policy
结果（policy 成功、Preview deploy skipped）；共享 `cd-tecent2` concurrency group
保证新的 Preview rerun 必须等正在执行的 Test deploy 退出后才能变更环境。

`verify-rendered-release.mjs` 在任何集群写入前复验 Kubernetes 服务端 dry-run 的原始对象：资源集合、namespace、镜像、命令、Secret 引用和 ClusterIP 边界必须精确符合环境契约。

`deploy-release.sh` 把 Preview 与 Production 的数据视为可丢弃测试数据，在共享主机锁内执行精确盘点和停写。首次切换先建立空的 PostgreSQL、Redis 和 MinIO，再完成 bucket 初始化与单对象冒烟，然后执行 `0000` 至 `0008` 迁移并启动 API、Worker、Runtime 和 Web。Preview 在公网检查后完成单次提交。Production 必须先使用 `--defer-cleanup` 激活候选并保留上一份 release，再由受保护的邮箱 OTP 六区验收产生 attestation，最后使用 `--finalize` 只读复验候选、清理旧对象并封存回滚点。复用既有基础时，进入 `finalizing` 前的验收失败、工作流失败或取消使用 `--rollback`；进入 `finalizing` 后只能以同一份 attestation 幂等续跑 `--finalize`。明确执行 `established-clean-slate-v1` 后，旧应用与新空数据基础不再构成有效回滚组合，因此从基础重建开始只能幂等续跑同一候选或前滚到更新的 main 候选。Secret、TLS、namespace 和无关资源始终不在删除范围。

`reset-release-foundation.sh` 只接受 `established-clean-slate-v1` 策略，用于在受保护晋级明确授权后重建已有 Preview 或 Production 的可丢弃 PostgreSQL、Redis 和 MinIO 基础数据。它保留当前 Web Deployment 与 Service，先按 UID 和 resourceVersion 停止所有 API、Runtime、Worker 和发布 Job，再用 UID 前置条件删除固定基础资源及三份 `data-release-*` PVC。脚本把不可变删除计划和阶段检查点持久化，能够从 `planned`、`storage-removed` 或 `foundation-ready` 继续执行；成功证据同时证明旧 PV UID 与专属路径消失、新 PVC/PV 身份不同以及 Web 身份未变。如果 Preview 的一次重建已经完成但候选尚未部署，新的显式重建只能在三份存储身份、十个基础对象 UID 和完整活动 Web 路由都与直接前序证据一致时形成线性接续；Production 不接受这种接续，仍使用受保护的 reset roll-forward。脚本不读取 Secret，输出只包含公开发布身份、资源 UID 和专属存储身份。

`foundation-reset-journal.mjs` 只读审计 Preview 与 Production 的基础重建日志。它复验确定性请求身份、v1/v2 精确 schema、计划与快照摘要、三份存储和十个基础对象的连续性，并拒绝分叉、循环、孤立或未消费的重建链。Preview 只允许把唯一未消费完成节点作为直接前序形成线性接续；Production 拒绝 v2 接续。只有字节一致的当前 reset evidence、受摘要集合封存的激活/最终证据或精确 pending 状态能够消费日志。该审计器不连接 Kubernetes，也不读取 Secret。

`reset-roll-forward-journal.mjs` 只读取发布证据目录，统一审计 Production 基础重建后的前滚日志。它要求计划、检查点、旧 pending 归档、交接封条和完成证据使用同一确定性请求身份，并拒绝陌生文件名、符号链接、孤立文件、外部未完成日志及未被发布证据消费的完成日志。前序发布已经先完成最终提交时，日志只能以绑定同一请求和计划摘要的 `predecessor-already-finalized` 取消证明结束，该终态不能充当前滚证据。取消过程若在归档或取消证明写入后、检查点提交前中断，只允许同一请求的 prepare 操作继续，consumer 和其他候选都会被阻断。完成日志只能由带摘要集合的同一份激活证据或最终发布证据消费，最终发布证据优先于可能残留的激活目录；pending 本身不构成消费。该审计器不连接 Kubernetes，也不读取 Secret。

Production 激活把主机切流证据直接原子写入发布证据根目录下的 `<releaseId>.traffic.pending.json`。`armed` 检查点仍存在但实时路由已经指向候选时，续跑会把这视为切流与本地状态提交之间的中断。如果持久流量证据已经存在，续跑会复验并复用它；只有 `armed` 状态允许再次执行幂等切流来补齐缺失证据。随后脚本才把检查点推进到 `post-cut`。Production 延迟清理退出前会把流量证据纳入带摘要集合的激活目录，再删除临时流量证据。`post-cut` 状态缺少证据、实时路由含糊或发布身份不一致时都会停止。

Production 最终化先把待删除对象的 kind、名称、UID 和已捕获存储写入激活目录中的 `cleanup-plan.json`。脚本校验这份持久清理计划后，把它的摘要写入 `finalizing` 检查点，之后才开始删除旧对象。续跑只会重新校验并物化同一份计划；已经删除的目标按缺失状态继续收敛，不能通过新的实时盘点扩大删除集合。清理完成后的证据和流量封存证据也保存在激活目录中，后续最终化会复用这些不可逆步骤的结果。

Production 流量回滚把恢复后的主机状态分成三个持久提交。它先把 root 所有的流量检查点标记为 `rolled-back`，再把流量 `current.json` 写成前一份 release，最后写入与检查点摘要绑定的回滚证据；首次接管前没有前一份 release 时会删除 `current.json`。如果进程在这三个提交之间中断，`deploy-release.sh --rollback` 会先证明前一份 release 的实时路由、版本和 S3 仍然可用，再接受 `activated` 或 `rolled-back` 检查点。`activated` 恢复还必须存在摘要集合完整的激活目录，而且其中的流量证据必须绑定该检查点摘要。已有 `current.json` 只能精确表示候选或前一份 release，其他内容会在任何持久写入前被拒绝。恢复随后按检查点、当前流量状态和回滚证据的顺序收敛，候选资源只会在回滚证据可复验后删除。

Production 在删除旧对象前先把同一个清理计划摘要写入发布侧和 root 所有的主机侧 `finalizing` 检查点，并在流量锁内复验正式 Nginx、转发单元、监听器和候选身份。主机检查点进入 `finalizing` 后不再允许回滚。清理证据已经持久化且主机检查点已经是 `sealed` 时，续跑会要求预清理流量证据、封存摘要与同一份清理证据完全一致，然后复用持久清理证据和流量封存证据，继续写完发布证据与当前发布状态。发布证据目录已经提交但 `current.json` 或待处理检查点尚未收敛时，同一 release 的最终化续跑也会补完这些提交。

Test、Preview 和 Production 的 GitHub Environment 各自只需要一个 `ACCEPTANCE_RESEND_API_KEY`。Runner 生成两个不同的 `delivered+...@resend.dev` 地址，读取精确邮件的 OTP，并且绝不把 API key、邮箱或验证码写入日志和证据。管理员用下面两个短命令分别配置三个 GitHub Environment 和三个 Kubernetes 环境；每个命令只隐藏提示一次 Resend key，Kubernetes 的 OTP HMAC 和三份数据库角色密码会为每个环境独立生成且不回显：

```sh
./scripts/configure-first-party-auth-secrets.sh github all
./scripts/configure-first-party-auth-secrets.sh kubernetes all
```

`github all` 会先用 artifact 同款 sent-email reader 验证 full-access key 的读取权限，验证失败时不会写任何 Environment。`kubernetes all` 会先完成三个目标 Secret 的权限和元数据预检，再使用 UID/resourceVersion 条件 Patch 原位更新；不会删除 Secret 或改变 UID。单环境模式仍可用于精确轮换，运行脚本不带参数可查看用法。

`collect-live-runtime-evidence.sh` 从目标 namespace 的实际 Deployment、Pod、迁移 Job 和迁移 Pod 采集 Ready 状态、容器 `imageID`、退出码及精确 `0000` 至 `0008` 账本。Preview 晋级证据会保存该结果；Production 变更前还会即时重采 Preview并重新验证。

`verify-release-schema.mjs` 在 Preview 或 Production 的 `release-postgres-0` 内开启只读事务，从 PostgreSQL 系统目录核对 `0000` 至 `0008` 的完整表和列、Turn 关联约束、部分索引、邮箱认证表、UUID v7 函数及三个应用角色的最小权限。它不读取业务行或输出数据库凭据，只原子写入权限为 `0600` 的脱敏结构证明及摘要；任何旧表、结构漂移或越权授权都会使验证失败。

`release-nginx-route.mjs` 按固定 server_name、proxy_pass 数量和端口集合解析 Nginx，不执行全文件模糊替换。Production canary 配置与 `buildwithcombo.com` 的 `happy.conf` 分别做摘要 CAS；正式域名只允许四个 Web upstream 在 `30080` 和 `18082` 之间整体切换，证书指令保持原字节。

`switch-release-traffic.sh` 为 Preview 与 Production 分别维护 Web 和 MinIO 的 loopback forwarder，并在专用锁内切换 Nginx。Production 只有在 `buildwithcombo.com` 的 TLS、版本、SPA 路由、API、S3、HTML 缓存、hashed asset 缓存和缺失 asset 404 全部通过后才返回成功。切流前的两份 Nginx 配置、无凭据 Web 环境文件和两个 systemd unit 会以 root 所有的 `0600` 文件保存在 `/var/lib/combo-release/traffic-checkpoints`；检查点不包含 Secret 或 TLS 文件内容。主机事务先把检查点从 `armed` 提交为 `activated`，再原子更新流量 `current.json`，最后原子提交调用方指定的流量证据文件。

`rollback-release-traffic.sh` 只接受精确 release manifest，并同时校验活动配置摘要、持久检查点和旧 Service 是否仍存在。首次正式域名接管前的 `happy.conf` 本来指向不可用的旧端口，因此首次回滚恢复该配置摘要后，通过 `agora.43-160-242-46.sslip.io` 验证旧 release；后续正式路由已经健康时则通过 `buildwithcombo.com` 验证旧 SHA。`seal-release-traffic.sh --phase prepare` 在清理前把检查点标为 `finalizing` 并绑定清理计划，`--phase seal` 在清理证据通过后把它标为 `sealed`；两个状态都不能再执行流量回滚。
