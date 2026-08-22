# 源码职责

- `pump-contract.ts` 定义三种严格 command payload、pump 生命周期、resolver 和错误合同。
- `worker-serial-pump.ts` 串行执行两库 mutation，在 commit/mark 后发起 Host I/O，但不在 mutation
  队列内等待 Host promise；完成事件会重新入队。
- `runtime-contract.ts` 定义唯一组合根的 storage mode、READY/BLOCKED 生命周期、错误与依赖端口。
- `worker-runtime.ts` 创建/打开双库，按依赖顺序启动 Host、owner、driver、pump、owner heartbeat 与
  scheduler，并执行自动 BLOCKED 收敛和反向停止。
- `index.ts` 是应用包的唯一公共出口。
- `__tests__/` 使用真实两份 SQLite、真实本地 WebSocket 与真实 R1 handle authority 验证完整接线和
  崩溃边界。

`worker-runtime.ts` 是唯一允许创建 SQLite、建立 WebSocket 并关闭外部资源的文件；pump 继续只负责
串行执行。Runtime 不提供进程入口、信号处理或生产身份适配器，不能从本目录推断已部署。
