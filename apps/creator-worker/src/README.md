# 源码职责

- `pump-contract.ts` 定义三种严格 command payload、pump 生命周期、resolver 和错误合同。
- `worker-serial-pump.ts` 串行执行两库 mutation，在 commit/mark 后发起 Host I/O，但不在 mutation
  队列内等待 Host promise；完成事件会重新入队。
- `index.ts` 是应用包的唯一公共出口。
- `__tests__/` 使用真实两份 SQLite 与真实 R1 handle authority 验证完整接线和崩溃边界。

本目录不创建 SQLite 文件、不建立 WebSocket，也不关闭外部资源；这些职责保留给后续唯一组合根。
pump 每 tick 续租 journal owner；transport owner 保持由 driver 单独续租，组合根还要监控 driver 的
永久 `BLOCKED` 生命周期状态。
