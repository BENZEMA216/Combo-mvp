# 数据库迁移

本目录按文件名字典序保存 PostgreSQL 迁移。已应用的迁移不可修改，新增结构必须通过新的迁移文件演进。

`0000_baseline_schema.sql` 建立当前基线。`0001_expired_upload_reconciliation.sql` 增加上传超时查询索引，`0002_drop_stream_events.sql` 拒绝旧 PostgreSQL 事件表，`0003_turns.sql` 增加自治轮次与轮内消息顺序。`0004_studio_sessions.sql`、`0005_capability_current_ui.sql` 和 `0006_one_running_turn_per_session.sql` 保存 Goal B 已发布的 Studio、current UI 与 Turn fencing 结构。

`0007_first_party_email_auth.sql` 仅允许空用户库切换到第一方邮箱验证码，并创建身份、验证码挑战、不透明会话与低敏审计表。`0008_application_database_roles.sql` 创建无登录的 API、worker 与 runtime 角色，撤销默认权限，并按当前服务职责授予最小表权限。`0009_billing.sql` 创建全局钱包、按用户与 Agent 隔离的免费额度、使用扣费、充值支付状态和不可变资金流水，以延迟约束守护账户、预留、业务终态与流水等式，并分别授予 API 与 Runtime 所需的最小权限。`0010_recharge_qr_channel.sql` 把扫码充值通道从聚合码 `aggregate_qr` 重命名为 C扫B 单渠道 `qr`（`/v3/prepay`），并迁移历史订单。`0011_recharge_qr_only.sql` 移除 H5「手机收银台」渠道，把历史 `h5` 订单迁到 `qr` 并把支付方式约束收窄为只允许 `qr`。`0012_agent_builder_v1.sql` 创建 owner-scoped Agent Project、不可变 Revision、固定 Revision 的 Runtime Test、不可变 Release 及相关幂等与 Head 一致性约束。`0013_external_mcp_oauth.sql` 创建动态客户端、短期授权请求、一次性 PKCE 授权码以及只保存摘要的访问令牌和轮换刷新令牌；同 family refresh 通过 advisory lock 串行。动态 client 由 SECURITY DEFINER 注册函数按 canonical digest 去重，在数据库锁内维持 4096 硬上限，并只在满额时淘汰超过十分钟且完全无引用的最旧 client；有界清理函数还负责删除超过三十天且无引用的 client。Authoring 只有实际读写列与两个受控函数权限，Runtime 只能只读 access-token 摘要。已经执行的迁移不可修改，新结构必须继续追加编号。
