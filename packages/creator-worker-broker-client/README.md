# @cb/creator-worker-broker-client

本包是 Creator Worker 的 R2C transport 层。它用一个独立、fresh-only 的 SQLite 文件保存
Broker 连接游标、入站命令、逻辑出站消息与每次 WebSocket wire attempt，并提供真实 `ws`
driver。Invocation Journal 使用另一个 SQLite 文件；两库不得共用路径，也不伪装成跨库原子事务。

逻辑消息的稳定身份是 `sourceId + sourceFingerprint + deliveryMessageId`。重连可以更换
connection、sequence 与 canonical wire bytes，但不能更换逻辑身份。`socket.send()` 的成功回调
只把 wire attempt 标为 `WRITTEN`；只有持久化且逐字段匹配的 `CLOUD_COMMITTED` ACK 才能把
逻辑消息标为完成。入站 command 必须先与 cursor 和 deterministic `PERSISTED` ACK 在同一事务
提交，driver 才允许发送 ACK。离线入库的 logical body 会按最坏 authority envelope 预留 frame
空间，避免未来 lease 激活时产生无法封装的持久毒丸。

公开子路径：

- `./sqlite-repository`：fresh SQLite repository、owner/connection capability 与 exact replay。
- `./websocket-driver`：严格 URL、bounded text frame、串行持久化、重连与有界停止。

本切片仍是 Test-only 重建层。它不包含 OAuth、Secure Enclave、正式 Broker challenge、签名租约、
Invocation/Host pump、Gateway、Cloud PostgreSQL 或部署。R2D 以后用 `factId + payloadFingerprint`
把 R2B outbox 幂等写入本包；R2E 再成为两个 store、driver 与 pump 的唯一组合根。
