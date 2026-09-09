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
- 公开页的“复制使用指令”按钮只复制服务端生成的固定 Release 接收指令，不探测 Desktop、不导航新任务或
  执行安装。使用者在已选项目的 Codex 或 Claude Code 对话中粘贴后，客户端读取匿名接收说明、独立校验固定安装器，再安装原包
  与项目 Skill 并明确读取原始方法。该入口不要求私有插件仓库权限或 Combo 登录，首版支持 macOS/Linux 和已有 Node.js 24.2；仅
  支持轻量文本方法，不自动配置外部工具。页面持续区分复制、安装和真实运行，不把项目 Skill 描述为对话隔离。

## 文件

- `AgentTransferPage.tsx`：核对配对码、私有上传等待、内容审阅、单独公开确认与结果。
- `AgentTransferState.ts`：账号与精确内容绑定、授权轮询、未知结果锁和幂等发布。
- `AgentReleasePage.tsx`：匿名分享读取、接收指令复制和显式下载。
- `AgentPackageReview.tsx`：两页共用的完整原文复核、方法节选、身份与证据边界。
- `../../components/CopyInstruction.tsx`：原样复制、成功提示及剪贴板失败时的完整手动复制文本。
- `agentPackages.css`：使用站点既有 token 的响应式布局与状态。
- `../../api/agentPackages.ts`：独立 typed HTTP 边界、结果结构/摘要绑定、请求编号保存。
- 对应页面/API 测试与 `../../App.agentPackages.test.tsx`：模拟接口的交互回归；不构成真实环境上传/发布验收。
- shared `sanitizeAuthReturnTo` 仅新增规范小写 UUIDv4 的精确 transfer 路径，拒绝查询、fragment、编码或路径归一化变体。

## 本地合成视觉验收

在仓库根目录执行 `node tests/e2e/agent-pages-mock-server.mjs`，打开 `http://127.0.0.1:5190/__mock`。
这是独立、仅监听 loopback 的合成接口，不加载实际 Vite 配置或 `.env`。所有 API 请求被截获或拒绝，不代理真实后端、不使用账号，也不写数据库。
隔离回归：`node --test tests/e2e/agent-pages-mock-boundary.test.mjs`，先断言最终代理配置为空，再验证 `/api`、未知 API、`/health` 和 `/ready` 均由合成服务拒绝。
状态选择页可复现首页、邮箱登录、确认码过期、私有保存、独立公开确认、丢失发布回执及匿名分享。
页面黄色标识持续区分 Mock API 与真实运行；此验收不构成真实客户端或云端端到端证据。
