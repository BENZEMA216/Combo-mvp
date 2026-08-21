# 源码职责

- `transport-types.ts`：repository 的 branded owner、connection、send attempt 与错误合同。
- `transport-authority.ts`：process-local capability 的签发、绑定与撤销检查。
- `sqlite-schema.ts`：独立 fresh-only transport schema、application ID 与 catalog digest。
- `sqlite-platform.ts`：私有文件、Node 24 SQLite、安全 PRAGMA 与 schema 验证。
- `sqlite-records.ts`：canonical/validator 与私有 SQLite consistency chain；它不是 MAC/签名，写者可重算。
- `sqlite-repository.ts`：owner fencing、strict sequence、exact replay、logical/wire outbox 与 Cloud ACK。
- `websocket-driver.ts`：真实 `ws` 生命周期、bounded 收发、持久化前置与有界重连/停止。
- `index.ts`：显式公共出口；内部 authority/schema/platform 不作为 package subpath 暴露。

本目录不能导入 Invocation reducer、Host adapter、Gateway 或 Runtime。业务正文只作为严格 canonical
JSON 由 repository 持久化；driver 不解析业务 payload，也不拥有 command pump。
