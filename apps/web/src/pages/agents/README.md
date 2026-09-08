# Agent 上传确认与公开分享

## 边界

- `/agent-transfers/:transferId` 在原有 Cookie 登录守卫内；配对只授权精确摘要的私有上传，不授权公开发布。
- 私有页面、查询缓存和确认状态绑定当前 `/me` 账号与 transfer ID。账号切换立即重新挂载并读取新账号权限；旧查询卸载后回收，旧 mutation 延迟返回不得回填内容或成功卡。
- 上传完成后展示实际 AGENT.md、Skill、附属文件和 manifest 原文。独立勾选公开确认后才发送 publication；任何 GET、刷新、页面重载都不会自动批准或发布。
- `/agents/:releaseId` 使用公开布局，不挂载 AuthProvider、不探测 `/me`；公开读取不携带 Cookie。展示仅代表 API 已验证并返回这个固定版本，不代表浏览器重算摘要、安装或试运行。
- 所有原文以 React 文本展示，不渲染 HTML、不执行 Markdown 或包脚本。来源未核验、覆盖可能不完整和尚未试运行持续可见。
- 发布请求编号在发送前写入 sessionStorage，绑定 transfer ID、draft fingerprint、package digest。只保存不透明编号和摘要，不保存上传 secret、配对码、包内容或会话。存储不可用时不发送。未知结果先刷新；同一标签页重载和显式重试复用原编号。
- 发布响应必须是本次请求两个摘要对应的 published receipt；返回另一份 Draft 或 Package 时按结果未知拒绝，不把旧内容与新发布记录拼成成功卡。
- 匿名、跨账号、撤销和损坏响应保持安全错误，不展示服务端原始错误。下载与复制只由显式点击触发，不读取其他任务或 Project。

## 文件

- `AgentTransferPage.tsx`：核对配对码、私有上传等待、内容审阅、单独公开确认与结果。
- `AgentReleasePage.tsx`：匿名分享读取与两页共用的只读内容展示。
- `agentPackages.css`：使用站点既有 token 的响应式布局与状态。
- `../../api/agentPackages.ts`：独立 typed HTTP 边界、结果结构/摘要绑定、请求编号保存。
- 对应页面/API 测试与 `../../App.agentPackages.test.tsx`：模拟接口的交互回归；不构成真实环境上传/发布验收。
- shared `sanitizeAuthReturnTo` 仅新增规范小写 UUIDv4 的精确 transfer 路径，拒绝查询、fragment、编码或路径归一化变体。
