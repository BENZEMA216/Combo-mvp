# Goal C 晋级准入与证据契约

Goal C 把一次可晋级发布候选定义为一个完整的 `main` 提交、该提交对应的成功
`Main CD` 运行及其 run attempt，以及该运行生成的唯一
`combo-release-<SHA>-<source-CI-attempt>` artifact。Preview 和 Production 的发布身份
必须引用同一个候选，不能只按 artifact 名称、分支名或最近一次成功运行来选择输入。
PR Test 生成的分支 release 和 Test 证据是独立验证输入，不构成晋级候选。

## 控制面与环境拓扑

`PR CI` 由 `pull_request` 触发，只在 GitHub runner 上执行格式、lint、类型、快速应用
单测和关键 workflow 契约测试；它跳过 container contracts 与耗时的发布状态机模拟，不
调用 Docker、不构建或发布镜像，也不产生 release artifact。需要真实环境验证时，具有
仓库写入权限的成员从 `main` 上受信任的
`workflow_dispatch` 控制器选择一个同仓库且仍开放的 PR，并同时提交该 PR 当时
head 的完整 SHA。PR Test 会核对 PR 开放状态、仓库归属、启动时分支 tip、提交可达性和固定
SHA，再调用已冻结控制器定义的可复用 `Main CD` 构建不可变 artifact，最后使用同一控制器固定的
部署和验收程序部署到 `combo-preview`。PR 的 base 和祖先关系不参与 Test 授权，构建期间 `main` 或 PR
分支前进也不会改变已冻结快照。候选分支的 workflow、控制
脚本和验收脚本不会在受保护 Environment 中执行。

GitHub `combo-dev` Environment 的分支策略仍然只允许 `main`。该策略约束的是可以读取
SSH 与 Resend Secret 的控制器版本，不是候选源码所在分支，因此与“任意同仓库分支
可以部署 Test”并不冲突。PR Test 使用隔离证据，只证明所选 PR 在 Test 环境的结果，
不能进入 Preview 或 Production。

`main` push 触发 `Main CD` 完整质量门、镜像构建和唯一 release artifact。成功的
`Main CD` 会直接触发 Preview；Preview 只接收该 `main` SHA 的同一 artifact，且不等待
或读取任何 Test run 或 Test evidence。`COMBO_PREVIEW_AUTO_PROMOTION_MODE=enabled` 时
自动部署，`paused` 时记录策略并跳过部署。Production 没有自动入口，只能在 GitHub
`production` Environment 完成人工审批后，消费精确成功的 Preview evidence，并重新
下载 Preview 锁定的同一个 Main CD release artifact，不重新构建镜像。

## 不可变输入

发布身份使用 `scripts/promotion-evidence.mjs` 校验。身份包含完整 source SHA、
source Main CD run ID 和 run attempt、部署 workflow 的 run ID 和 run attempt、GitHub
artifact ID、artifact ZIP digest、release manifest digest、artifact file-set digest、
Web asset manifest digest，以及 API、Runtime 和 Web 的 digest-pinned 镜像。所有
digest 都必须是非零 SHA-256，所有运行和 artifact ID 都必须是正整数。

Preview 在任何远端变更前重新检查以下事实：

- 候选仍然是远端 `main` 的精确 HEAD。
- policy job 输出与 deploy job 的受保护 repository-variable 准入快照都严格等于
  `enabled`。内置 `GITHUB_TOKEN` 不调用其无权访问的 Repository Variables REST
  endpoint。
- source Main CD 的名称、ID、run attempt、workflow 路径、事件、分支、SHA 和结论仍然
  匹配。
- source artifact 的 ID、所属运行和 GitHub digest 仍然匹配。

PR Test 的远端 bundle、reset proof、migration proof 和部署证据路径全部使用
`source SHA + workflow run ID + run attempt` 三元组；任何字段或路径 attempt 漂移都会
失败。成功证据使用 attempt-scoped 的 `combo-branch-test-evidence-*`，但 Preview 不查询、
下载或接受它。三个环境的 deploy job 共用 `cd-tecent2` concurrency group，仅用于避免
同一主机上的环境 mutation 并发，不建立 Test 到 Preview 的准入关系。脱敏部署证据的
顶层以及
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
Preview promotion schema v5 明确不含 Test run、Test evidence artifact 或 Test 证据
摘要。Production 会反查证据锁定的成功 Main CD run；下载的 release artifact 必须是
Preview 锁定的同一个 artifact ID，其实际 ZIP SHA-256、GitHub artifact digest、release
manifest、file-set 和镜像 digest 必须相同。

## 三环境证据结构

Test、Preview 和 Production 各自使用严格的 promotion identity 字段；Test 身份独立，
只有 Preview 与 Production 形成晋级证据链。环境到 namespace 和部署 workflow 的映射
固定如下：

| 环境       | Namespace       | Web 入口                                | 部署 workflow                     |
| ---------- | --------------- | --------------------------------------- | --------------------------------- |
| Test       | `combo-preview` | `https://test.43-160-242-46.sslip.io`   | `.github/workflows/combo-dev.yml` |
| Preview    | `combo-review`  | `https://review.43-160-242-46.sslip.io` | `.github/workflows/preview.yml`   |
| Production | `combo`         | `https://buildwithcombo.com`            | `.github/workflows/cd.yml`        |

六区通用结果使用 `combo-six-area-live` schema。它要求 Creation Journey、Studio、
Authoring、Runtime、访问与发布身份、运维与发布六区中的每个固定检查按固定顺序
全部为 `passed`，并嵌入完整 promotion identity。校验器拒绝额外字段、凭据形态的
键和值、错误环境入口、不完整检查和任何身份漂移。该 schema 只接受受控 runner
生成的脱敏结果；workflow 不提供任意 `evidence_json` 输入，也不能通过人工拼接
JSON 获得通过状态。

三个环境都从各自被固定 SHA 和 digest 锁定的 release artifact 取出
`acceptance/live-browser-acceptance.mjs` 与一同校验的 `playwright-core.tgz`，在 tecent2
已安装的 Chrome 中运行。PR Test 使用其 PR head artifact 和固定公网 HTTPS Test
入口；Preview 与 Production 复用同一个 Main CD artifact，分别使用固定公网 Review
入口和 `https://buildwithcombo.com`。PR Test 会把受校验的浏览器结果和 promotion
identity 纳入 `combo-branch-test-evidence-<SHA>-<Test-attempt>`，该 artifact 不参与
Preview 准入。Main CD、PR Test、Preview 和 Production 的 artifact 名均包含实际
producer attempt；重跑只生成新的不可变 artifact，不覆盖上一 attempt。

浏览器 runner 的固定检查真实覆盖能力勾选与 UI 发布、Runtime SSE 建流、事件 id、
主动断开、携带 `Last-Event-ID` 的重连和终态 Redis replay。中断 Turn 必须收到
同一 Turn 的 `RUN_ERROR`，随后服务端详情中不得出现该 Turn 的 artifact，current UI
也不得前进。Preview 还会在 Web 与 Runtime 两个 bundle 中展开身份 badge，核对完整
SHA、releaseId 和 Web asset digest，并通过真实 Clipboard API 检查脱敏验收上下文。
Preview 不再叠加共享访问码：页面、静态资源和发布元数据可直接访问，API 未登录时
仍返回原生 401。历史 `/__review/enter` 与 `/__review/bootstrap` 入口只负责把合法的
同源 `returnTo` 带到产品邮箱登录页；协议相对和多重编码外链必须落到同源兜底。

Test、Preview 与 Production 分别从对应 GitHub Environment 的
`ACCEPTANCE_RESEND_API_KEY` 读取独立
验收权限，并为每次 workflow attempt 生成两个唯一的 `delivered+…@resend.dev`
收件地址。runner 按精确收件人、主题、发件身份和挑战时间从 Resend sent-email API
在内存中提取验证码，完成两次首次注册、Session 持久化、退出撤销和 owner 隔离。
Resend key、验证码和邮件正文不进入参数、文件、日志、artifact 或 evidence。

Production 准入必须验证 Preview 的完整浏览器结果、schema v5 promotion evidence 和
其中绑定的 Main CD artifact digest 链。Production 先以 `--defer-cleanup` 激活候选并
保留回滚对象，受保护
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

Preview promotion artifact 包含 schema v5 promotion 记录、Preview identity、远端部署与
清理证据、当前 checkpoint、资源清单、实际运行态和真实浏览器结果。promotion 记录绑定
Main CD run/attempt、release artifact ID/name/digest、manifest、file-set 和镜像 digest，
且 exact schema 中不存在任何 Test 字段。Production evidence 同样使用 schema v5，
保留同一 Main CD 与 Preview digest 链，并包含 Production identity、激活与流量封存
证据、远端部署与清理证据、资源清单、Preview 即时重采运行态、Production 运行态和
受保护浏览器 attestation。PR Test 证据单独保留，不能被转换为上述任一晋级证据。

任一 run attempt、artifact ID、artifact digest、manifest、file-set、镜像、
checkpoint、浏览器检查、资源清单或正式流量检查不一致时，workflow 必须失败。
失败不会回退到另一运行、另一 artifact 或移动中的 SHA，也不会把缺少的环境验收
记作通过。
