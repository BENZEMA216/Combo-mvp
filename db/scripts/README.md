# 数据库脚本

本目录保存直接操作数据库结构的 Node.js 命令行入口。

- `migrate.ts` 按文件名字典序读取 `db/migrations`，为每个未记账的迁移开启独立事务，并在成功后写入 `schema_migrations`。本地调用可以提供 `DATABASE_URL`，Compose 与 Kubernetes 使用 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD` 和 `PGDATABASE` 独立字段，所有者密码不会被拼进 URI。全部迁移完成后，它调用应用角色配置函数；`--status` 只展示迁移清单与记账状态。
- `migrate-v2.ts` 只用于 `combo-v2` 验证数据库。它复用正式迁移的 `0000` 至 `0011`，随后读取 `db/v2-migrations` 的独立尾部，并保持现有 V2 `schema_migrations` 文件名兼容。执行任何 DDL 前必须拿到五份角色密码；取得数据库迁移锁后先快照 cluster-global 角色，含 NOLOGIN 的文件在同一 transaction 内恢复对应 LOGIN 后才允许记账提交。
- `provision-app-roles.ts` 在 `0008` 已收口授权后，通过绑定参数为 API、worker 与 runtime 设置三份独立密码并启用登录。它只读取三个密码环境变量，不输出密码或拼入迁移文件。
- `provision-v2-app-roles.ts` 提供 V2 五密码预检、migration transaction 内的分段角色恢复，以及全量账本后的五角色复验；五份密码必须同时提供。迁移前已存在的 canonical API/worker/runtime 三角色只恢复 LOGIN、保留原密码；V2 自有 authz/billing 角色绑定 V2 Secret，避免覆盖正式身份同时保证 V2 凭据可用。
