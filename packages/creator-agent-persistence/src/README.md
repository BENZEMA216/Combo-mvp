# 源码职责

- `catalog-types.ts`：Catalog 错误、配置、Draft/Version reference、严格确认与本地体验自动冻结授权，以及最小公共 port。
- `sqlite-schema.ts`：fresh-only schema、application ID 与独立 compiled-catalog digest。
- `sqlite-platform.ts`：路径/权限/sidecar 预检、Node 24 SQLite defensive 配置与 reopen 校验。
- `sqlite-catalog.ts`：strict handoff import、完整 freeze review、exact confirmation、显式本地未发布自动冻结、
  幂等 Version freeze 与跨行 lineage validator；两种冻结入口共享同一个原子事务，但授权语义互不冒充。
- `index.ts`：唯一公共出口；不暴露 raw database、SQL、schema helper 或测试 seam。
- `__tests__/`：真实 SQLite fresh/open、exact replay、确认、并发、篡改与 corruption 分类回归。

本目录不得导入 Creator Worker、Host、WebSocket、Cloud、分享路由或隐藏 Codex task 状态。
