# 测试职责

- `sqlite-repository.test.ts` 使用 Node 24 的真实 `node:sqlite` 验证 fresh/reopen、owner fencing、
  exact replay/conflict、持久化 command 容量绑定、bounded durable order、满载零提交、
  persist-before-ACK、重连重封装与 Cloud ACK 终结。
- `websocket-driver.integration.test.ts` 使用真实 `ws` loopback server 验证 lease COMMIT 后 READY、
  bounded text frame、command 满载不发 ACK 且释放后重试、断线重连、write 与 Cloud ACK 的区分，
  以及 stop 不假成功。

这些测试不证明公网 OAuth/TLS 身份、Gateway/Cloud 接入、Invocation pump、跨库原子性或生产部署。
