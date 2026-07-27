# 数据库迁移

本目录按文件名字典序保存 PostgreSQL 迁移。已应用的迁移不可修改，新增结构必须通过新的迁移文件演进。

`0000_baseline_schema.sql` 建立当前基线。`0001_expired_upload_reconciliation.sql` 增加上传超时查询索引，`0002_drop_stream_events.sql` 拒绝旧 PostgreSQL 事件表，`0003_turns.sql` 增加自治轮次与轮内消息顺序。`0004_studio_sessions.sql`、`0005_capability_current_ui.sql` 和 `0006_one_running_turn_per_session.sql` 保存 Goal B 已发布的 Studio、current UI 与 Turn fencing 结构。

`0007_first_party_email_auth.sql` 仅允许空用户库切换到第一方邮箱验证码，并创建身份、验证码挑战、不透明会话与低敏审计表。`0008_application_database_roles.sql` 创建无登录的 API、worker 与 runtime 角色，撤销默认权限，并按当前服务职责授予最小表权限。已经执行的迁移不可修改，新结构必须继续追加编号。
