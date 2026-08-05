# modules/agent-project —— Agent Revision 运行与测试

这个模块把 Authoring 编译出的不可变 Agent Revision 接到现有 Session、Turn、Message、SSE 和 Artifact Runtime。创作者 Test 固定 Revision；正式会话创建时只解析一次 Project 当前 Release，随后 Session 永远使用自己的 Revision 与 Release 指针。

## 文件

- `routes.ts` 声明启动 Revision Test、读取单个 Test、列出 Project 最近 Test 和从当前 Release 创建正式 Session 四个端点。
- `handlers.ts` 加载并验证 Runtime Bundle，按 Test id 幂等创建或复用 Revision-pinned Session，复制冻结 UI，启动真实 Turn，并返回可轮询 Test。Test 启动要求稳定 idempotency key；相同正文可重放，不同正文冲突。Turn、首条 Message 与 Test 激活在同一个数据库事务提交，事务失败时模型不会开始执行。`GET /runtime/agent-projects/:projectId/tests` 只接受 owner 的 active Project，默认返回最近 20 条且最多 50 条。
- `repo.ts` 保存冻结的输出契约、请求摘要、启动租约与 Test 记录。`starting` claim 在任何 Session/Turn 副作用前创建；进程崩溃留下的 claim 过期后可原子接管，而旧租约不能激活 Turn。Project 恢复列表按 `created_at DESC, id DESC` 返回 `starting`、`running` 与终态，并保留 request key 供新 MCP 任务精确关联；单 Test GET 继续负责根据 PostgreSQL Turn 终态做单向收口。文本输出必须非空；structured 输出必须是合法 JSON 且通过该 Revision 冻结的同步 JSON Schema，否则以 `AGENT_OUTPUT_INVALID` 失败。

## 上下游

不可变 Bundle 由 `modules/agent/revision-loader.ts` 从对象存储读取并校验摘要。会话和轮次继续使用既有 session 与 agent 模块；UI 通过 artifact 模块从 Revision 固定对象键复制，不读取 Capability 的可变当前 UI。Test Session 不进入普通会话列表。Authoring Release 只接受本模块已经收口为 passed 的同 Revision Test。
