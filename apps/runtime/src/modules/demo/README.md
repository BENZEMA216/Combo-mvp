# Test 演示模块

这个目录只为 Test 发布身份补齐可完整体验的 Combo Miniapp。Authoring 创建的 Capability 必须同时属于当前登录用户，并带有精确的 `source=test-demo`、`fixture=combo-miniapp` 与 `fixtureVersion=1` marker；只有满足全部条件，Runtime 才复用或创建 active Studio Session。

固定 HTML 是自包含的真实 Miniapp，主操作通过 `combo:run` bridge 调用 Runtime，不在浏览器里伪造 Agent 结果。种子使用确定性 Artifact id 写入 `combo-artifacts`，以空指针 CAS 绑定 `capabilities.ui_artifact_id`，因此重试不会增加副本，也不会覆盖用户之后产生的 UI revision。

路由同时要求可信浏览器来源和正常登录 Cookie，并由 `COMBO_ENVIRONMENT=test` 控制注册。Preview、Production 与 development 不公开该端点；handler 内保留第二道环境检查以防误注册。
