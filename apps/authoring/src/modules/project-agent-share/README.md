# modules/project-agent-share —— Project Agent 公开分享

这个模块保存兼容的 `combo.project-agent-share/1` Git Project manifest，并通过高熵随机分享链接让任意接收者读取。任何拿到链接的人都能通过公开 HTTP 端点匿名读取 manifest；它不是账户授权或 OAuth token，但属于持有即匿名可读的未列出公开定位链接，应按公开内容处理。V0 分享不会过期、不能撤销，因此 manifest 里不得放秘密。Codex 负责推理、恢复项目和运行 Harness；本模块不抓取仓库、不复制会话、不执行 Runtime。新的当前任务 Agent 分享由相邻 `codex-agent-share/` 模块负责；两个 schema 复用不可变表，但 URL、读取和幂等重放严格分流。

## 文件

- `routes.ts` 声明受信任浏览器来源与会话保护的创建端点，以及不要求登录的公开读取端点。
- `handlers.ts` 校验共享请求，映射幂等冲突和公开未命中，并给公开响应添加禁止缓存、禁止来源泄露和禁止索引头。
- `service.ts` 规范化无值依赖声明，计算稳定正文摘要，生成三十二字节随机公开定位符，并派生只引用分享链接的 Codex 复制文字。
- `repo.ts` 只在创建时插入 manifest，按 owner 和幂等键重放创建，并按随机定位符执行不带 owner 过滤的公开读取。

## 安全边界

V0 只接受规范 `github.com` HTTPS 仓库地址、完整 branch 或 tag ref、精确 commit/tree SHA 与安全标识形式的依赖名。服务端不访问仓库，也不声称已验证远端 ref。创建调用方必须先在本地用 `git ls-remote origin <sourceRef>` 核对精确 commit；接收者必须在运行前审查不可信项目并验证 commit/tree。分享只覆盖该 commit 的 Git tracked files，ignored 与 untracked files 不在其中。Combo 只保存 manifest，不归档 Git 对象；如果公开仓库被删除、转为私有或 GitHub 不再提供该 commit，旧分享将无法恢复。公开 HTTP 读取不要求登录；同名 MCP 读取仍由 OAuth scope 保护，但也不按 owner 过滤。

`copyPrompt` 按 manifest `schemaVersion` 派发冻结 renderer；`combo.project-agent-share/1` 的完整文字有 golden test，未来改文案必须新增 schema 版本并永久保留旧 renderer，保证滚动发布中的幂等重放字节一致。`EXTERNAL_MCP_PUBLIC_ORIGIN` 是每个环境创建分享后的永久 canonical origin，不应在已有分享仍受支持时更换。
