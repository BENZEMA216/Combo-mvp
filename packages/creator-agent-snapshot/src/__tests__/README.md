# Snapshot 与 AgentVersion 测试说明

本目录覆盖 `INV-001`、`INV-002`、`INV-003`、`INV-006`、`INV-022` 相关的 E1 证据。

- canonical JSON 测试检查对象顺序、Unicode、数字和非法值。
- Snapshot 测试检查创建顺序、mtime、mode、单 byte 变化、长路径、文件数和大小边界；独立资源边界测试把同一份 digest-bound Manifest fixture 的文件数与展开字节 N-1/N/N+1 送入生产 `parseSnapshotManifest`，并把真实非稀疏 UTF-8 单文件的 10 MiB N-1/N/N+1 送入 `buildSnapshotFromProject`，对两个合法边界完整执行 `verifySnapshotArchive`。压缩对象边界测试把 digest-bound metadata 的 50 MiB N-1/N/N+1 送入四个生产数值 owner，并证明 N+1 在 S3 client 与 presigner 调用前拒绝；它不构造真实 50 MiB tar/zstd archive，`SNP-008` 仍为 `planned`。
- hostile corpus 测试使用真实 symlink、hardlink、sparse file、Secret、NUL、二进制，以及手工构造的 traversal、link 和特殊 tar header。
- encryption 测试包含 NIST AES-256-GCM 已知答案向量、冻结 `CSNPENC1` binary golden、权威 Envelope/AAD 逐字段绑定、canonical base64url/长度边界、随机生产 nonce 和 bit flip 失败。
- AgentVersion 测试检查显示元数据不进入摘要、可变执行语义会改变摘要、冻结的 Alpha IO 之外输入直接拒绝、仓库不可覆盖和 Conversation 固定版本。
- property 测试记录 seed，并对目录顺序、JSON key 顺序、内容 mutation 和 collision 运行重复生成检查。
- `cross-process-golden.mjs` 由独立 Node 进程加载构建后的包，复核 tar/zstd golden digest。macOS 本地和 Linux CI 设计为运行同一向量，任一平台或 zstd 版本漂移都会失败；只有 CI 实际产出 Linux 结果后才形成跨平台证据，本机通过不能代替该结果。
- `object-storage.test.ts` 使用可观测 fake S3 验证两条 exact Signed PUT、完整 header 绑定、100 路 finalize、verify-before-prepare、commit 前不可见、archive final 后 manifest 故障、原 temp 重放、原 temp 丢失后新 DEK/nonce exact replay、commit 存在但 final 缺失与 selected temp 损坏时的 fail-closed/read-repair、不同 cipher generation 并发收敛、损坏 temp 后同 digest 重试、body/size/checksum/metadata hostile mutation、跨 Creator 调用和 key unwrap 后清零。
- `upload.test.ts` 验证 Worker 先完整复核 Snapshot、再使用 create-only authority 生成 DEK，随后形成可直接交给 upload-session 的双密文 contract；同时复核 checksum、独立 nonce、完整解密和 provider key buffer 清零。
- `object-storage.minio.integration.test.ts` 只能由 `scripts/run-minio-e2.mjs` 显式启动：脚本创建固定版本、tmpfs、随机 loopback port 的 disposable MinIO，运行真实 SigV4 双 PUT、缺 SignedHeader 拒绝、32 路 finalize、损坏 temp 重试、archive final 后 manifest failpoint、commit 前不可见、原 temp 重放、原 temp 丢失后的新 DEK/nonce exact replay、commit 已存在但 final 缺失后的 reader fail-closed 与修复、不同 cipher generation 并发收敛与特权篡改检测，然后删除容器和临时 credential 文件。

默认 `test` 不隐式要求 Docker，并排除 `.integration.test.ts`；显式 `test:minio:e2` 产生真实 MinIO adapter 的 E2 组件证据。它仍不测试 PostgreSQL、正式 IAM、真实 RFC3394 wrap/KEK/KMS、Retention、备份或 DR，也不能单独宣称 Gate 1 完整通过。
