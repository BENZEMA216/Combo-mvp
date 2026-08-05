# authoring 服务源码总览

这是 Combo 创作侧后端服务。创作者先用邮箱六位验证码建立或登录账号，再创建上传任务；本机助手上传 Claude 或 Codex 对话历史，后台流水线解析、脱敏并归纳能力项。创作者或 Codex 随后把能力项和 Miniapp 冻结成 Agent Revision，真实测试通过后创建不可变 Release。HTTP 路由前缀是 `/api/v1`。

## 四层布局

- `processes/` 放 API 与 worker 两个进程入口。
- `bootstrap/` 组装 Fastify、基础设施、健康检查和业务路由。
- `modules/` 按 account、task、capability、agent-project、billing 和 external-mcp 六个业务领域组织代码。account 是第一方浏览器认证唯一写入方，external-mcp 用 OAuth 把同一用户安全映射给 Codex，agent-project 冻结可测试和发布的 Agent，billing 是外部充值与内部钱包入账的唯一写入方。
- `platform/` 提供配置、HTTP 边界、PostgreSQL、Redis、队列、对象存储、Resend、本地会话校验、链路追踪和事件流等公共设施。

依赖保持单向。processes 使用 bootstrap 与 modules，bootstrap 使用 modules 与 platform，modules 使用 platform，platform 不依赖业务模块。共享类型、错误信封、Cookie 常量和校验契约来自 `@cb/shared`。

## 文件

- `index.ts` 默认加载 API 进程入口。
- `tsconfig.json` 为编辑器覆盖源码与测试文件的类型项目，实际生产构建仍使用包根目录的配置。

## 登录与创作主链路

1. React 向 `POST /api/v1/auth/email/challenges` 请求邮箱验证码，再向 verification 端点提交六位码。
2. account 模块在 PostgreSQL 中一次消费验证码，首次登录时创建用户和邮箱身份，并签发只保存摘要的七天会话。
3. 浏览器只持有一枚 HttpOnly Cookie。HTTPS 发布入口显式配置根路径、Secure 且主机限定的 `__Host-cb_session`，本地 HTTP 开发入口显式配置根路径 `cb_session`，选择不依赖 `NODE_ENV`。authoring 的受保护路由只按当前安全策略对应的 Cookie 查询本地会话，不接受 Bearer 或 refresh 凭据。
4. 创作者创建任务后，本机助手凭配对码上传分片。worker 消费任务，读取原文、解析、脱敏、调用大模型并写入能力项。
5. 浏览器通过任务事件流读取进度，终态仍以 PostgreSQL 中的任务状态为准。
6. Codex 或 Studio 创建 Agent Project，提交带 Head CAS 的 Revision；编译器冻结 Capability、Miniapp 和 Runtime Bundle，Runtime Test 通过后才能发布同一 Revision。
7. Codex 插件通过根级 OAuth 发现和 PKCE 登录获得短期 Bearer Token；远程 MCP 的十六个工具始终要求显式资源 ID，不读取或暴露浏览器 Cookie。

## 充值主链路

1. 已登录用户手动填写充值金额并用 `rechargeIntentId` 创建内部充值订单。
2. billing 模块调用固定环境的乐收赢扫码支付（C扫B `/v3/prepay`）接口，只把经过验签和安全校验的支付动作返回浏览器。
3. 浏览器支付结果不改变余额；乐收赢通知或原订单主动查单确认成功后，数据库事务同时完成订单成功、钱包增加和不可变资金流水追加。
4. 网络结果不确定时订单进入 `unknown`。用户轮询内部订单会在短租约保护下查询原支付流水，不会生成新的支付流水。
