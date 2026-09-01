# 浏览器端到端测试

本目录使用 Playwright 验收受控本地真实浏览器链路。

`resend-auth.spec.ts` 从自定义登录页申请邮件验证码，通过仅在开发测试栈启用的 Resend 模拟服务读取验证码，随后为当前用户和另一用户建立两条未发布能力测试数据，并确认 runtime 只把当前用户的条目标为本人所有。用例还检查 Cookie 不可被页面脚本读取，并在注销后确认两个服务与新的进度流请求都拒绝旧会话。测试数据只写入本次隔离 Compose 项目的临时 PostgreSQL。

`playwright.test-truth.config.ts` 只供机器证据 producer 使用：唯一 shell 入口验证并传入 exact candidate SHA 和仓库外私有 JSON 输出位置，配置固定单 worker、零 retry、零 snapshot 更新和 Chromium CLI 默认值。用例内部还会断言逐用例 effective `browserName`。这条链路使用 Resend mock、HTTP 与非 Secure 的开发 Cookie，并通过 API 和 PostgreSQL 建立另一用户数据；因此只证明受控本地认证边界，不证明真实邮件、TLS / `__Host-` Cookie、部署环境、完整跨用户 UI、Agent 旅程或 Codex Desktop。

默认私有目录随脚本退出销毁。外层 runner 传入 `COMBO_BROWSER_TRUTH_PRIVATE_DIR` 以接收证据时，必须用退出陷阱在规范化、sentinel 扫描完成后删除整个目录；原始 Playwright JSON、sentinel、stdout、stderr、容器日志和 Cookie 不得上传为 CI artifact。
