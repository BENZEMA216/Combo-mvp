# modules/external-mcp —— Codex 远程 Agent Builder

这个模块在 Authoring API 内提供无状态 Streamable HTTP MCP 和独立的 OAuth 2.1 授权面。浏览器授权页只用现有邮箱验证码 Session 确认用户；Codex 只获得绑定精确 MCP resource 的短期 Bearer Token，数据库只保存令牌摘要。

## 文件

- `routes.ts` 注册 RFC 9728 资源发现、RFC 8414 授权服务器发现、动态客户端注册、授权页、令牌、MCP 和公开安装引导路由，并限制正文和调用频率。
- `handlers.ts` 渲染不加载第三方脚本的授权与安装 HTML，处理 OAuth 响应，校验 MCP transport 请求，并分发 JSON-RPC 工具。
- `service.ts` 生成高熵一次性凭据，执行 PKCE S256、scope 和 resource 校验，只接受 Codex 当前使用的 `127.0.0.1` loopback callback 并只放宽端口。IPv6 literal 无法作为 CSP Level 3 的精确 `form-action` source，因此当前明确拒绝，不能通过放宽到任意 `http:` 回调规避。动态注册对规范元数据计算 SHA-256 digest；临时监听端口与 URI 集合顺序不进入 identity。
- `repo.ts` 保存动态客户端、摘要化授权请求、一次性授权码和摘要化令牌；刷新令牌按 family advisory lock 串行，发生重放时撤销整个令牌家族。API 不能直接插入或删除 client，只能调用迁移定义的受控注册与有界清理函数。
- `runtime-client.ts` 只经固定集群内 Runtime origin 转发当前请求的 Bearer Header，按共享 schema 校验 Studio UI、Agent Test 技术状态、质量状态和发布资格，并把 Runtime 错误收敛成安全失败。解析兼容旧 Runtime 缺少质量字段的响应，并将其视为未复核且不可发布。
- `agent-builder-app.ts` 提供 MCP Apps 标准的内联 Agent Builder 卡片资源，先完成
  `ui/initialize` / `ui/notifications/initialized` 生命周期，再接收工具数据。卡片只展示模型
  已经核验的阶段数据，按钮优先通过标准 `ui/message` 把用户选择送回当前对话，并在宿主
  未声明该能力时 feature-detect OpenAI 兼容消息桥；卡片本身不创建、复核或发布业务对象。
- `tools.ts` 暴露显式 Project ID 的无状态 Agent Builder 工具和只读展示工具，复用现有 Agent Project service 和共享 schema，不保存进程内 TargetState。`record_agent_test_review` 只能在当前 Codex 任务中得到用户对三类案例的明确质量确认后调用，服务端会把当前 OAuth 用户冻结为 reviewer。Test 与 Release 结果同时返回可点击的 Runtime 资源链接。

## 协议边界

MCP 资源是规范 origin 下的 `/api/external-mcp/mcp`，与 Project Agent 公开页面共用同一个 `EXTERNAL_MCP_PUBLIC_ORIGIN`。本地开发该 origin 是 Vite `:5173`，由 Vite 把 `/api`、`/.well-known` 和 `/codex-plugin` 代理到 Authoring `:3000`；直连 `:3000` 不能代表完整公开页面。未认证 GET 与 POST 返回带路径版 protected-resource metadata 的 Bearer challenge；根路径和路径版 metadata 返回相同资源文档。授权、换码和刷新都必须携带同一个精确 resource，客户端必须使用 S256 PKCE。

授权确认页的内容安全策略只允许表单提交到自身和本次请求已经校验过的精确 loopback origin，使 303 回调可以返回 Codex，同时不开放其他主机或端口。成功页使用 `strict-origin` 保留同源 POST 的 Origin 校验；错误页继续使用 `no-referrer`。

远程工具面保留前 23 项 legacy 工具的精确顺序与行为，再稳定 append 5 项 Project-history 工具，完整 catalog 固定为 28 项。`render_agent_builder` 的 generic stages 继续接收 caller-authored 标准卡，legacy `project_restore` 只保留 V0；reserved `codex_agent_restore` 则严格只收 `{stage,shareUrl,manifestSha256}`。Creator Bootstrap 仍在同一 saved Project 中提炼、读取 Git/guidance 并展示完整 `project_share` 卡，但确认 action 必须由固定模板只绑定 commitSha/treeSha：name 仍显示，name/description/instructions/guidance 及 marker/Host tag 等自由文本不得进入 user-role message，卡或摘要变化必须 STOP。Creator 的 packaged guidance 先恰好调用一次 `list-manifest-inputs`，再把返回的每个唯一 readable objectId 恰好读取一次；无 readable 时才可零次且最多读取八个，hint、omitted 与 duplicate-object 条目不读取。Creator marker 采用 whole-message exact `text.trim()`；`final_answer` 可用，null/absent 仅在同一唯一 completed/error-null turn、ordered proof 齐全且 marker 最后时作为 legacy fallback，commentary 拒绝。创建成功后仍立即回读同一 URL。

Receiver continuation 完成 readiness 后只调用 strict `codex_agent_restore`。execute 分支通过公开 `readCodexAgentShare` 复用 canonical URL、schema/createdAt/canonical digest 失败关闭校验，并由服务端构造一个完整 manifest item + M 个完整 starter item/action；短 text content 不泄漏 manifest，standard card 放在 structuredContent。Agent Builder fact input/output/runtime 上限统一为 20,000，覆盖 32 commands + 32 plugins + 32 env names + codexVersion 的合法最大 requirements；instructions/starter 自身仍由各自 8k/1k contract 限制。generic V0 card 行为和 legacy 23-tool prefix 不变。invalid URL、not found、digest mismatch、存储 tamper 或 caller 多传 card 字段均失败且不返回 action。

用户按一基 N 确认后，tool 23 必须收到并回显 `starterOrdinal` 与 `starterPrompt`；服务端重读分享并只接受 `manifest.agent.starterPrompts[N-1]===starterPrompt`，再生成带 ordinal 的权威 `COMBO_CODEX_AGENT_RUN/1`。终端 raw route 在任何 Git/Agent 行为前恰好复核 shareUrl、digest、ordinal、prompt 和 runEnvelope bytes。READY/STARTED 三路 Host marker 均要求 whole-message `text.trim()` exact；phase `final_answer` 可接受，phase null/absent 仅在同一唯一 completed/error-null turn、ordered lifecycle 完整且 marker 为最后 behavior 时作 legacy fallback，phase commentary 与含其他文本的 final 均拒绝。

Agent Builder 展示工具只把已经核验的数据渲染为 MCP App，不保存选择；`facts[].value` 的输入、输出与运行时上限统一为二万字符，可完整展示最长八千字符的 Creator instructions 和 Codex Agent 合法最大 requirements。MCP 不保存 TargetState；所有 Project、Revision、Test 与发布操作都显式携带资源 ID。质量复核按案例分别保存执行终态和质量结论，整体质量状态只由服务端派生；最终发布确认不会修改复核。发布 Revision 只从技术通过、质量可发布且仍匹配当前 Head 的 Test 服务端推导。

Studio UI 与 Agent Test 仍由 Runtime 执行。Authoring 只把当前 access-token 通过固定的集群内 HTTP 路由转发；Runtime 只能只读 `oauth_access_tokens` 摘要表并再次校验 resource、有效期、账号和所需 scope，不能读取客户端、授权请求、授权码或 refresh token。浏览器 Cookie 从不进入该链路。

授权 GET/POST 与 DCR 每 IP 每分钟最多 30 次，Token 每分钟 60 次，MCP GET/POST 每分钟 300 次。所有生产副本通过同一 `redis_hot` 共享计数、按发布环境隔离 key，Redis 故障时失败关闭。DCR、授权 GET/POST、Token 和 MCP GET/POST 共用一个进程内低频调度窗，任一活跃流量都可每分钟触发一次数据库有界清理；每类状态每次最多删除 100 条。未过期但已使用的 refresh token 保留到过期，以继续检测 replay。

DCR 使用忽略 loopback 临时端口的 canonical registration digest 去重；Codex 重启或端口变化会复用同一 `client_id`，同时响应本次 URI。数据库 advisory lock 把复用、容量恢复、计数和插入串行，client 总量硬限制为 4096。满额时只淘汰超过十分钟、最近未使用且对授权请求、授权码、access token、refresh token 均无引用的最旧 client；没有安全候选则失败关闭。普通维护只清理超过三十天且无任何引用的 client。

`/codex-plugin` 当前只在 Test 环境提供固定 `codex/combo-plugin-v2-ui` 的 Combo Plugin 0.8.4 安装命令。状态机先同时读取 Marketplace 与 Plugin；同名异源、Plugin 存在但 Marketplace 缺失或无效版本立即停止。官方 Marketplace 已存在而 Plugin 缺失/过旧时先 upgrade Marketplace、刷新 metadata；无论 Marketplace 初始是否存在，只要当前已确认 official source 且 Plugin 仍缺失，就恰好 add Plugin 一次。fresh install 固定按 add Marketplace、重读并确认 source、add Plugin、最终检查执行。新 Project-history 28-tool 流程门要求 Plugin 有效 semver `>=0.8.4` 且已安装启用，`mcp get combo` 的 name、enabled、disabled_reason、transport.type 和 Test URL 全部精确匹配；当前 Test 候选 UAT 另要求 exact 0.8.4。Creator 只有初始工具/metadata不全时才在 final metadata 后恰好执行一次 Codex-managed OAuth；失败或取消时零任务创建。初始全满足的 stay-current 分支不主动登录，只有工具明确返回 authorization 错误时才恰好登录一次并只重试原调用。不要求用户手动 shell、二次粘贴或重启。Legacy 兼容不变：0.7.0 的既有四工具与旧 Project Agent 读取工具仍可接收已有 share；只有新五工具与完整 28-tool 普通用户流程要求 0.8.4。V1 create 只允许 Test；Preview/Production 仍可公开 read，但不会铸造硬编码 Test 的新链接。
