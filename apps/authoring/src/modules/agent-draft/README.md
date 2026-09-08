# 私有 Agent Draft 同步

本模块只保存和读取已经编译的 Draft V2、轻量上下文 Draft 与 exact Package，不负责读取 Codex 对话、提取、推理或公开分享。分别复用 `@cb/creator-worker/agent-package-compiler` 和 `agent-package-context-compiler` 的确定性编译器，不建立第二套 Agent 定义或推理服务。

## 文件与接口

- `service.ts` 校验上传、核对既有编译结果、保存不可变对象和版本索引，并从实际文件投影 `combo.agent-card-view/1` 卡片。
- `routes.ts` 提供同源登录 Cookie 保护的两个接口；账户归属只来自认证会话，不接受请求指定 owner、Bearer 或 query token。

`POST /api/v1/agent-package-drafts` 按严格协议分派。原 V2 JSON 保持不变：

```text
protocol: combo.agent-draft-upload/1
requestId: UUID（同一次上传重试保持不变）
draftText: canonical Draft V2 JSON 原文
candidate:
  manifestText: canonical agent.json 原文
  packageDigest: sha256:...
  compilationReceiptText: 编译收据原文
  files: [{ path, text }]（不含 agent.json）
```

首次保存返回 201；相同 owner/requestId 和相同内容重试返回原结果 200，即使其后已有更新版本。响应 `data` 是 `combo.agent-draft-record/1`，包含私有可见性、Draft 原文、Package 文件、编译收据和 `card`。将来 MCP 的 `structuredContent` 应取 `data.card`，不能把整个 record 交给前端卡片解析器。

轻量上下文使用独立 JSON，不接受 V2 Draft、编译收据、调用方 owner 或来源认证字段：

```text
protocol: combo.agent-context-upload/1
requestId: UUID（同一次上传重试保持不变）
draftText: canonical combo.agent-context-draft/1 JSON 原文
candidate:
  manifestText: canonical agent.json 原文
  packageDigest: sha256:...
  files: [{ path, text }]（不含 agent.json）
```

轻量响应 `data` 是 `combo.agent-context-record/1`，包含 `storage: { draftId, revision: 1 }`、`draft: { protocol, fingerprint, text }`、原样 Package `candidate`、`savedAt`、`card`、`visibility: private` 和 `sourceVerification: not_verified`。存储定位符由服务端按规范 owner 与 requestId 做独立域摘要生成，不写入轻量 Draft 或 Package。一个新 requestId 创建独立私有快照，不冒充轻量 Draft 的修订版本；同一 requestId 的内容漂移返回 409。轻量来源固定未经独立验证且覆盖可能不完整，保存与编译都不表示真实推理成功。

内部调用方从 `service.ts` 导入 `AgentContextUpload`、`AgentContextRecord` 与 `PrivateAgentRecord` 类型。`AgentDraftService.saveContext(owner, body)` 只接受轻量上传，返回 `{ record: AgentContextRecord, created: boolean }`；`save(owner, body)` 为既有 HTTP 路径执行两种严格协议分派。`inspectAgentContextUpload(body)` 在无写入的完整编译核验后返回规范 `requestId`、`name`、`draftFingerprint` 与 `packageDigest`，供独立上传授权逐项对比；它不签发权限。账户归属仍须由调用方的受信会话提供。

需要和其他业务写入原子闭合时，调用方先建立真实 PostgreSQL 事务，再传入 `PgDraftRepository.inTransaction(tx)`。该仓储只使用传入连接，复用原来的 request 锁、Draft 锁和保存逻辑，读取也在同一连接上执行；它不借新连接，也不执行 BEGIN、COMMIT 或 ROLLBACK。调用方必须在相关写入全部成功后提交，否则私有索引一起回滚；事务回滚仍可能保留可供重试复用的不可变孤立对象。普通 `new PgDraftRepository(pool, db)` 的事务行为不变。

`GET /api/v1/agent-package-drafts/:draftId/revisions/:revision` 和 `AgentDraftService.read(owner, draftId, revision)` 只返回当前登录者的指定版本；不存在和其他账号的版本均为 404。读取按已保存的私有封装协议返回 V2 或轻量 record，复验原始字节、Draft fingerprint、存储元数据和 Manifest 中每个文件，不重新编译或静默切到最新版。

## 数据和失败边界

每份上传必须和同一 Draft 的编译结果逐字节一致。内容校验在写入前完成。`requestId` 和 owner UUID 先归一化小写，再依次取得 request 锁和 Draft 锁。原 V2 Draft 的新版本必须基于当前版本，且通过官方修订函数验证：只可改变 content，不能改变制作要求或来源，也不能提交无内容变化的版本。轻量和 V2 请求共享账户内幂等边界，但不能互相转换或把已保存的轻量 Draft 续写成 V2 来源声明。

Draft、Manifest、Package 文件与 V2 编译收据放在一个最大 512 KiB 的不可覆盖对象中，保存于既有私有 `combo-artifacts` bucket 的 `private-agent-drafts/<owner>/<draftId>/<snapshotHash>.json`；轻量封装不包含编译收据。数据库 `0020` 只追加元数据，两种封装共用既有 `PgDraftRepository`，不新增迁移。对象提交并原样回读成功后，才插入数据库版本。上传失败可能留下不可变孤立对象，但没有数据库索引就不可通过这些接口读取；重试复用同一对象键，不生成公开 Release。对象存储继续使用既有的超时、长度上限和条件写入适配器。部署必须先应用 `0020`；本改动没有执行任何环境部署。

所有响应 `no-store`。写入要求精确可信 Origin，认证在解析正文之前执行，JSON 请求体最多 1 MiB，每 IP 每分钟最多 10 次上传。错误只返回安全信封和 traceId：格式/内容 400、版本或幂等冲突 409、依赖故障或存储损坏 503。应用角色只能 SELECT/INSERT 版本索引，数据库所有者普通 DML 也不能改写或清空历史版本。

## 当前验收边界

持久化验证不是 Desktop 来源证明。所有保存结果都显式返回 `sourceVerification: not_verified`；卡片展示实际 `AGENT.md`、Skills、Manifest 和 provenance，所有修改、试用、分享、安装动作保持关闭。轻量首版不以前置 Desktop 证明阻塞私有保存，但仍须独立验证发布授权；上传权限不等于公开发布权限。不得把提交的 source claim 当成 Host 签发证明，也不得把 `dataMode: real` 理解成真实推理已完成，它只描述卡片数据来自已保存的真实 Package 字节。

尚未接通：当前任务可见对话的可信 Host 入口、Plugin 远端 OAuth 绑定、远端 HTML resource/render 接线、真实 Codex 试用与结果回执、通用公开 Release。这些工作不能通过冒用受控 Knowledge Publisher 或旧 Project-history 数据表绕过。

## 本地验证

```sh
pnpm -F @cb/authoring... build
pnpm --dir apps/authoring exec vitest run src/__tests__/agent-draft.test.ts
AGENT_DRAFT_PG_TEST=1 pnpm --dir apps/authoring exec vitest run src/__tests__/agent-draft.pg.test.ts
```

PG 测试要求显式 `DATABASE_URL`，只允许本地随机命名的 `combo_draft_test_<6到32位后缀>`，或 `/tmp/combo-draft-pg.<随机后缀>` Unix socket 下的 `combo_draft_test`；GitHub Actions 另允许仓库 CI 的临时 `agora` service。必须先构建 Authoring 及其依赖，再用正式 runner 迁移专用空库到 `0020`。测试会留下合成的 append-only 记录，不能指向长期开发库。PG、HTTP/认证与新 Node 进程中的服务回读为真实实现；新进程只收到合成对象字节，对象存储仍是假件。这不是主站上传、真实 S3 耐久性或真实 Desktop E2E 证明。
