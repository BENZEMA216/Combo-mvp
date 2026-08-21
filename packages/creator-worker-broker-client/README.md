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

fresh store 会把 `maxPendingCommands` 持久化为 schema 绑定，默认值是 256，合法范围是
1..10000；后续 open 必须提供完全一致的值。新的 command 在同一事务内检查 `PENDING` 容量，
满载时以 `COMMAND_CAPACITY_REACHED` 回滚 inbound、cursor 与 ACK，driver 随后释放连接并重连。
exact replay 和已有 command 不重复占用容量。pump 通过 `readPendingCommands(owner, limit)` 按
durable `delivery_sequence` 分批读取，默认 32 条且单批最多 100 条，并在业务落地后调用
`markCommandApplied` 释放容量。

公开子路径：

- `./sqlite-repository`：fresh SQLite repository、owner/connection capability、bounded command admission
  与 exact replay。
- `./websocket-driver`：严格 URL、bounded text frame、串行持久化、重连与有界停止。

本切片仍是 Test-only 重建层。它不包含 OAuth、Secure Enclave、正式 Broker challenge、签名租约、
Invocation/Host pump、Gateway、Cloud PostgreSQL 或部署。R2D 以后用 `factId + payloadFingerprint`
把 R2B outbox 幂等写入本包；R2E 再成为两个 store、driver 与 pump 的唯一组合根。
