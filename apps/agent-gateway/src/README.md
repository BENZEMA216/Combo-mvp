# Agent Gateway 源码

`gateway.ts` 管理真实 WebSocket 生命周期，并把所有权威读写委托给 `AgentGatewayAuthorityPort`。`index.ts` 只导出公共类型和实现。`gateway.test.ts` 使用真实回环 socket 和确定性 Authority fake 验证网络行为；该 fake 只证明传输边界，不证明 PostgreSQL、Redis、TLS Ingress 或远程 Worker 已经部署。
