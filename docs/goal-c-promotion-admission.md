# Goal C 晋级准入与证据契约

Goal C 把一次发布候选定义为一个完整的 `main` 提交、该提交对应的成功 CI
运行及其运行次数，以及该运行生成的唯一
`combo-release-<SHA>-<source-CI-attempt>` artifact。Test、
Preview 和 Production 的发布身份必须引用同一个候选，不能只按 artifact 名称、
分支名或最近一次成功运行来选择输入。

## 不可变输入

发布身份使用 `scripts/promotion-evidence.mjs` 校验。身份包含完整 source SHA、
source CI run ID 和 run attempt、部署 workflow 的 run ID 和 run attempt、GitHub
artifact ID、artifact ZIP digest、release manifest digest、artifact file-set digest、
Web asset manifest digest，以及 API、Runtime 和 Web 的 digest-pinned 镜像。所有
digest 都必须是非零 SHA-256，所有运行和 artifact ID 都必须是正整数。

Preview 在任何远端变更前重新检查以下事实：

- 候选仍然是远端 `main` 的精确 HEAD。
- policy job 输出与 deploy job 的受保护 repository-variable 准入快照都严格等于
  `enabled`。内置 `GITHUB_TOKEN` 不调用其无权访问的 Repository Variables REST
  endpoint。
- source CI 的 ID、run attempt、workflow、事件、分支、SHA 和结论仍然匹配。
- source artifact 的 ID、所属运行和 GitHub digest 仍然匹配。
- 同一 SHA 的 Test workflow run、run attempt 和
  `combo-test-evidence-<SHA>-<Test-attempt>` artifact
  均已成功，且 Test identity、浏览器结果、source release 和部署证据摘要逐项匹配。

Test 的远端 bundle、reset proof、migration proof 和部署证据路径全部使用
`source SHA + workflow run ID + run attempt` 三元组；任何字段或路径 attempt 漂移都会
在进入 Preview 前失败。Test 首次 mutation 前及 bundle 上传后还会复验同一 SHA
只有一个 attempt 1 的 Preview policy run，且 policy 成功、deploy job 为
`skipped`；三个环境的 deploy job 共用 `cd-tecent2` concurrency group，因此新的
Preview rerun 不能与正在执行的 Test mutation 并发。脱敏部署证据的顶层以及
reset、storage、foundation、
migration、Job、Pod、release metadata、resource inventory 和 live plane 的每个
嵌套对象都采用 exact schema，并扫描敏感键、Bearer/Cookie/私钥、裸
`gh[pousr]_`/`github_pat_` token 和 `AKIA`/`ASIA` AWS access key ID。Test artifact
浏览器验收只在 root-owned forwarder lease 的短窗口内运行，窗口前后两个转发器都
必须为 `inactive`，执行期间必须为 `active`。

Production 必须显式接收 Preview run ID、Preview run attempt 和 Preview evidence
artifact ID。它在任何 Production 变更前重新检查远端 `main`、精确 Preview
attempt、精确 evidence artifact，以及远端当前 Preview checkpoint 的逐字节
一致性，并即时重采 Preview 的实际 Pod `imageID`、Ready 状态和迁移 Job 结果。
Preview promotion schema v4 中的 Test run、Test evidence artifact 和四份 Test
证据摘要必须完整且格式严格。Production 下载的 release artifact 必须是 Preview
证据锁定的同一个 artifact ID，其实际 ZIP SHA-256 和 GitHub artifact digest
必须相同。

## 三环境证据结构

Test、Preview 和 Production 共用严格的 promotion identity 字段。环境到 namespace
和部署 workflow 的映射固定如下：

| 环境       | Namespace       | 部署 workflow                     |
| ---------- | --------------- | --------------------------------- |
| Test       | `combo-preview` | `.github/workflows/combo-dev.yml` |
| Preview    | `combo-review`  | `.github/workflows/preview.yml`   |
| Production | `combo`         | `.github/workflows/cd.yml`        |

六区通用结果使用 `combo-six-area-live` schema。它要求 Creation Journey、Studio、
Authoring、Runtime、访问与发布身份、运维与发布六区中的每个固定检查按固定顺序
全部为 `passed`，并嵌入完整 promotion identity。校验器拒绝额外字段、凭据形态的
键和值、错误环境入口、不完整检查和任何身份漂移。该 schema 只接受受控 runner
生成的脱敏结果；workflow 不提供任意 `evidence_json` 输入，也不能通过人工拼接
JSON 获得通过状态。

Test、Preview 和 Production 都从同一 release artifact 取出
`acceptance/live-browser-acceptance.mjs` 与一同校验的 `playwright-core.tgz`，
在 tecent2 已安装的 Chrome 中运行。Test 通过固定 loopback Web forward，Preview
使用固定公网 Review 入口，Production 使用 `https://buildwithcombo.com`。Test
workflow 会把受校验的浏览器结果和 promotion identity 一并纳入
`combo-test-evidence-<SHA>-<Test-attempt>`，Preview 不接受没有这份 Test
admission 的候选。CI、Test、Preview 和 Production 的 artifact 名均包含实际生成它的
run attempt；重跑只生成新的不可变 artifact，不覆盖上一 attempt。

浏览器 runner 的固定检查真实覆盖能力勾选与 UI 发布、Runtime SSE 建流、事件 id、
主动断开、携带 `Last-Event-ID` 的重连和终态 Redis replay。中断 Turn 必须收到
同一 Turn 的 `RUN_ERROR`，随后服务端详情中不得出现该 Turn 的 artifact，current UI
也不得前进。Preview 还会在 Web 与 Runtime 两个 bundle 中展开身份 badge，核对完整
SHA、releaseId 和 Web asset digest，并通过真实 Clipboard API 检查脱敏验收上下文。
访问闸检查会保留 gate Cookie、移除应用会话 Cookie，经页面上的“恢复预览会话”
按钮进入 bootstrap 并返回原路径；协议相对和多重编码外链必须落到同源兜底。

Preview 访问 token 只能来自受保护的 `cloud-review` Environment Secret
`CLOUD_REVIEW_ACCESS_TOKEN`，通过标准输入短暂传给远端进程。Test、Preview 与
Production 分别从对应 GitHub Environment 的 `ACCEPTANCE_RESEND_API_KEY` 读取独立
验收权限，并为每次 workflow attempt 生成两个唯一的 `delivered+…@resend.dev`
收件地址。runner 按精确收件人、主题、发件身份和挑战时间从 Resend sent-email API
在内存中提取验证码，完成两次首次注册、Session 持久化、退出撤销和 owner 隔离。
Resend key、验证码和邮件正文不进入参数、文件、日志、artifact 或 evidence。

Production 准入必须验证 Preview 的完整浏览器结果以及 Preview 证据中的 Test
admission 链。Production 先以 `--defer-cleanup` 激活候选并保留回滚对象，受保护
浏览器验收通过并生成 workflow-owned attestation 后才可 `--finalize`。进入
`finalizing` 前的失败回滚；最终化会先把同一清理计划摘要写入发布侧和主机侧
`finalizing` 检查点，再开始删除旧对象。进入该状态后只允许使用同一 attestation
幂等续跑清理与封存。

## 资源负向清单

`collect-release-inventory.sh` 只读取资源元数据，不读取 Secret。Preview 和
Production 的清单覆盖 Deployment、StatefulSet、Job、Service、Ingress、PVC、PV、
CronJob、DaemonSet、NetworkPolicy、Role、RoleBinding、关联 ClusterRoleBinding、
ServiceAccount 和 ConfigMap。校验要求资源集合精确等于当前四业务面和三项状态
存储，并明确拒绝：

- consumer、sweeper、outbox、`rt_chat_*`、`rt_studio_*` 和 cloud-review 旧对象。
- 任意 NodePort。
- 额外的 Ingress、CronJob、DaemonSet、NetworkPolicy 或 RBAC 对象。
- 缺失或多出的 PVC、PV、Service、Job、Deployment、StatefulSet、ServiceAccount
  或 ConfigMap。

清单显式记录 `excludedKinds: ["Secret"]`，这表示验收只确认 Secret 不被读取，
并不表示 Secret 可以删除或导出。

## 证据保留和失败行为

Preview promotion artifact 包含 schema v4 promotion 记录、Preview identity、
远端部署与清理证据、当前 checkpoint、资源清单、实际运行态和真实浏览器结果。
promotion 记录同时绑定 Test run、Test evidence artifact 以及 Test identity、
浏览器、source release 和部署证据摘要。Production evidence 使用 schema v4，
保留整条 Test admission 链，并包含 Production identity、激活与流量封存证据、
远端部署与清理证据、资源清单、Preview 即时重采运行态、Production 运行态和受保护
浏览器 attestation。

任一 run attempt、artifact ID、artifact digest、manifest、file-set、镜像、
checkpoint、浏览器检查、资源清单或正式流量检查不一致时，workflow 必须失败。
失败不会回退到另一运行、另一 artifact 或移动中的 SHA，也不会把缺少的环境验收
记作通过。
