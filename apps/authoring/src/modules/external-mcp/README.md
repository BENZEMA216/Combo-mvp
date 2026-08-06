# modules/external-mcp —— Codex 远程 Agent Builder

这个模块在 Authoring API 内提供无状态 Streamable HTTP MCP 和独立的 OAuth 2.1 授权面。浏览器授权页只用现有邮箱验证码 Session 确认用户；Codex 只获得绑定精确 MCP resource 的短期 Bearer Token，数据库只保存令牌摘要。

## 文件

- `routes.ts` 注册 RFC 9728 资源发现、RFC 8414 授权服务器发现、动态客户端注册、授权页、令牌、MCP 和公开安装引导路由，并限制正文和调用频率。
- `handlers.ts` 渲染不加载第三方脚本的授权与安装 HTML，处理 OAuth 响应，校验 MCP transport 请求，并分发 JSON-RPC 工具。
- `service.ts` 生成高熵一次性凭据，执行 PKCE S256、scope 和 resource 校验，只接受 Codex 当前使用的 `127.0.0.1` loopback callback 并只放宽端口。IPv6 literal 无法作为 CSP Level 3 的精确 `form-action` source，因此当前明确拒绝，不能通过放宽到任意 `http:` 回调规避。动态注册对规范元数据计算 SHA-256 digest；临时监听端口与 URI 集合顺序不进入 identity。
- `repo.ts` 保存动态客户端、摘要化授权请求、一次性授权码和摘要化令牌；刷新令牌按 family advisory lock 串行，发生重放时撤销整个令牌家族。API 不能直接插入或删除 client，只能调用迁移定义的受控注册与有界清理函数。
- `runtime-client.ts` 只经固定集群内 Runtime origin 转发当前请求的 Bearer Header，按共享 schema 校验 Studio UI 与 Agent Test 响应，并把 Runtime 错误收敛成安全失败。
- `tools.ts` 暴露显式 Project ID 的无状态 Agent Builder 工具，复用现有 Agent Project service 和共享 schema，不保存进程内 TargetState。

## 协议边界

MCP 资源是规范 origin 下的 `/api/external-mcp/mcp`。未认证 GET 与 POST 返回带路径版 protected-resource metadata 的 Bearer challenge；根路径和路径版 metadata 返回相同资源文档。授权、换码和刷新都必须携带同一个精确 resource，客户端必须使用 S256 PKCE。

授权确认页的内容安全策略只允许表单提交到自身和本次请求已经校验过的精确 loopback origin，使 303 回调可以返回 Codex，同时不开放其他主机或端口。成功页使用 `strict-origin` 保留同源 POST 的 Origin 校验；错误页继续使用 `no-referrer`。

当前远程工具面固定为十六项：提取任务创建/读取、Capability 列表/定义读取、Project 列表/创建/目标快照/读取、Miniapp UI 保存/读取、Revision 提交/读取、Test 运行/列表/读取和 Release 发布。MCP 不保存 TargetState；所有 Project、Revision、Test 与发布操作都显式携带资源 ID，发布 Revision 只从已通过的 Test 服务端推导。

Studio UI 与 Agent Test 仍由 Runtime 执行。Authoring 只把当前 access-token 通过固定的集群内 HTTP 路由转发；Runtime 只能只读 `oauth_access_tokens` 摘要表并再次校验 resource、有效期、账号和所需 scope，不能读取客户端、授权请求、授权码或 refresh token。浏览器 Cookie 从不进入该链路。

授权 GET/POST 与 DCR 每 IP 每分钟最多 30 次，Token 每分钟 60 次，MCP GET/POST 每分钟 300 次。所有生产副本通过同一 `redis_hot` 共享计数、按发布环境隔离 key，Redis 故障时失败关闭。DCR、授权 GET/POST、Token 和 MCP GET/POST 共用一个进程内低频调度窗，任一活跃流量都可每分钟触发一次数据库有界清理；每类状态每次最多删除 100 条。未过期但已使用的 refresh token 保留到过期，以继续检测 replay。

DCR 使用忽略 loopback 临时端口的 canonical registration digest 去重；Codex 重启或端口变化会复用同一 `client_id`，同时响应本次 URI。数据库 advisory lock 把复用、容量恢复、计数和插入串行，client 总量硬限制为 4096。满额时只淘汰超过十分钟、最近未使用且对授权请求、授权码、access token、refresh token 均无引用的最旧 client；没有安全候选则失败关闭。普通维护只清理超过三十天且无任何引用的 client。

`/codex-plugin` 当前只在 Test 环境提供固定 `codex/mcp-oauth-v1` 安装命令。Preview 不提供跨环境命令；Production 必须等独立插件 release 把静态 `.mcp.json` 切到 Production 并合并 `main` 后再显式开放稳定安装命令。
