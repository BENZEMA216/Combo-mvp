# Snapshot 与 AgentVersion 测试说明

本目录覆盖 `INV-001`、`INV-002`、`INV-003`、`INV-006`、`INV-022` 相关的 E1 证据。

- canonical JSON 测试检查对象顺序、Unicode、数字和非法值。
- Snapshot 测试检查创建顺序、mtime、mode、单 byte 变化、长路径、文件数和大小边界。
- hostile corpus 测试使用真实 symlink、hardlink、sparse file、Secret、NUL、二进制，以及手工构造的 traversal、link 和特殊 tar header。
- encryption 测试包含 NIST AES-256-GCM 已知答案向量、AAD 绑定和 bit flip 失败。
- AgentVersion 测试检查显示元数据不进入摘要、可变执行语义会改变摘要、冻结的 Alpha IO 之外输入直接拒绝、仓库不可覆盖和 Conversation 固定版本。
- property 测试记录 seed，并对目录顺序、JSON key 顺序、内容 mutation 和 collision 运行重复生成检查。
- `cross-process-golden.mjs` 由独立 Node 进程加载构建后的包，复核 tar/zstd golden digest。macOS 本地和 Linux CI 设计为运行同一向量，任一平台或 zstd 版本漂移都会失败；只有 CI 实际产出 Linux 结果后才形成跨平台证据，本机通过不能代替该结果。

这些测试不访问真实 MinIO、PostgreSQL 或 KEK，不产生 E2 证据；外部适配器合入后必须另建组件集成测试。
