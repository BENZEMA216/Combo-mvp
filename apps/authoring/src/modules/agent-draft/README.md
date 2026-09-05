# 私有 Agent Draft 同步

本模块只保存和读取已经编译的 Draft V2 与 exact Package，不负责读取 Codex 对话、提取、推理或公开分享。复用 `@cb/creator-worker/agent-package-compiler` 的确定性编译器，不建立第二套 Agent 定义或推理服务。

## 文件与接口

- `service.ts` 校验上传、核对既有编译结果、保存不可变对象和版本索引，并从实际文件投影 `combo.agent-card-view/1` 卡片。
- `routes.ts` 提供同源登录 Cookie 保护的两个接口；账户归属只来自认证会话，不接受请求指定 owner、Bearer 或 query token。

`POST /api/v1/agent-package-drafts` 接受严格 JSON：

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

`GET /api/v1/agent-package-drafts/:draftId/revisions/:revision` 只返回当前登录者的指定版本；不存在和其他账号的版本均为 404。读取复验已存字节，不重新编译或静默切到最新版。

## 数据和失败边界

每份上传必须和同一 Draft 的编译结果逐字节一致。内容校验在写入前完成。`requestId` 和 owner UUID 先归一化小写，再依次取得 request 锁和 Draft 锁。同一 Draft 的新版本必须基于当前版本，且通过官方修订函数验证：只可改变 content，不能改变制作要求或来源，也不能提交无内容变化的版本。

Draft、Manifest、Package 文件与编译收据放在一个最大 512 KiB 的不可覆盖对象中，保存于既有私有 `combo-artifacts` bucket 的 `private-agent-drafts/<owner>/<draftId>/<snapshotHash>.json`；数据库 `0020` 只追加元数据。对象提交并原样回读成功后，才插入数据库版本。上传失败可能留下不可变孤立对象，但没有数据库索引就不可通过这些接口读取；重试复用同一对象键，不生成公开 Release。对象存储继续使用既有的超时、长度上限和条件写入适配器。部署必须先应用 `0020`；本改动没有执行任何环境部署。

所有响应 `no-store`。写入要求精确可信 Origin，认证在解析正文之前执行，JSON 请求体最多 1 MiB，每 IP 每分钟最多 10 次上传。错误只返回安全信封和 traceId：格式/内容 400、版本或幂等冲突 409、依赖故障或存储损坏 503。应用角色只能 SELECT/INSERT 版本索引，数据库所有者普通 DML 也不能改写或清空历史版本。

## 当前验收边界

持久化验证不是 Desktop 来源证明。所有保存结果都显式返回 `sourceVerification: not_verified`；卡片展示实际 `AGENT.md`、Skills、Manifest 和 provenance，所有修改、试用、分享、安装动作保持关闭。不得把提交的 source claim 当成 Host 签发证明，也不得把 `dataMode: real` 理解成真实推理已完成，它只描述卡片数据来自已保存的真实 Package 字节。

尚未接通：当前任务可见对话的可信 Host 入口、Plugin 远端 OAuth 绑定、远端 HTML resource/render 接线、真实 Codex 试用与结果回执、通用公开 Release。这些工作不能通过冒用受控 Knowledge Publisher 或旧 Project-history 数据表绕过。

## 本地验证

```sh
pnpm -F @cb/authoring... build
pnpm --dir apps/authoring exec vitest run src/__tests__/agent-draft.test.ts
AGENT_DRAFT_PG_TEST=1 pnpm --dir apps/authoring exec vitest run src/__tests__/agent-draft.pg.test.ts
```

PG 测试要求显式 `DATABASE_URL`，只允许本地随机命名的 `combo_draft_test_<6到32位后缀>`，或 `/tmp/combo-draft-pg.<随机后缀>` Unix socket 下的 `combo_draft_test`；GitHub Actions 另允许仓库 CI 的临时 `agora` service。必须先用正式 runner 迁移专用空库到 `0020`。测试会留下合成的 append-only 记录，不能指向长期开发库。PG 与 HTTP/认证为真实实现，对象存储为内存替身；这不是主站上传、进程重启耐久性或真实 Desktop E2E 证明。
