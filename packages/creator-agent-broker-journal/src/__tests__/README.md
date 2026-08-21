# Tests

测试使用 R1 的真实 handle-private adapter controller 生成 outcome 与 interrupt receipt；
只 fake Host 行为，不 fake outcome authority。它们证明纯 reducer 语义，不证明 SQLite
原子性、crash recovery、WebSocket 送达、真实 Codex Host 或产品组合根。
