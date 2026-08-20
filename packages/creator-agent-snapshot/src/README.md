# Snapshot 与 AgentVersion 源码说明

## 文件职责

- `index.ts` 是唯一公开出口。
- `errors.ts` 定义稳定错误码和不携带文件正文、Secret 或绝对路径的错误对象。
- `policy.ts` 冻结 Alpha 的文件数、单文件、总量、压缩对象、路径和压缩比边界。
- `canonical-json.ts` 委托 `@cb/creator-agent-protocol` 生成 RFC 8785 兼容的 canonical JSON bytes，并把协议错误映射为稳定的本包错误码。
- `path-policy.ts` 负责路径规范化、UTF-8 byte 长度、保留目录、Unicode normalization 与大小写冲突检查。
- `content-policy.ts` 只接受 UTF-8 文本，拒绝 NUL、二进制控制字节、LFS pointer 和高置信度 Secret 模式。
- `tar.ts` 生成并解析固定元数据的 ustar/PAX archive，再用固定参数压缩和限制性解压 zstd。Node sync wrapper 在主 frame 恰好填满默认输出 chunk 时会追加一个固定空 frame；实现只在检测到该 exact 后缀时使用 65,537-byte retry buffer，并且只接受逐字等于原主 frame 前缀的结果，因此 canonical identity 仍是单一主 frame而不是 buffer size。
- `manifest.ts` 直接消费共享协议的 `SnapshotManifestSchema`、128-byte media type和2,536,575-byte reachable canonical maximum，建立 Snapshot Manifest、在 JSON parse 前执行语义byte Gate并重算 canonical digest；4 MiB raw/encrypted defense cap由policy单独保留。
- `staging.ts` 从活 Project 安全复制到一次性 staging，并检测 symlink、hardlink、sparse、特殊文件和复制期间变化。
- `snapshot.ts` 组合 staging、Manifest、tar.zst、摘要和 verifier。
- `encryption.ts` 消费权威 archive/manifest Envelope，实现 `CSNPENC1` 与 `CSNPMAN1` 两种 AES-256-GCM 对象格式、独立随机 nonce、逐字段绑定与认证后明文复核，并声明真实 RFC3394/KEK 适配器需要实现的端口。
- `upload.ts` 是 Creator Worker 的 create-only 连接层：完整复核 `BuiltSnapshot` 后才请求 DEK，生成两个密文对象及唯一权威 `SnapshotUploadCreateRequest`，并在返回前清零调用方和本地的明文 key buffer。
- `agent-version.ts` 计算 Contract 与 AgentVersion 摘要，并实现测试用不可变 Version 与 Conversation pin 仓库；独立 digest corpus把完整递归key order/whitespace归一化、Snapshot/Behavior语义byte以及Codex artifact/schema/model/effort逐项绑定到production builder的component/version digest。
- `repository.ts` 声明测试用对象持久化端口，并提供持有权威 Envelope、拒绝覆盖的内存实现；它不是生产数据库合同。
- `object-storage.ts` 实现 Creator-bound 的 S3-compatible 双对象 adapter：从两个权威 Envelope 派生 temp/final key，生成覆盖完整 headers 的短期 Signed PUT；两个 temp 完成双 AEAD、canonical Manifest/archive 与逐文件验证后，先用不可变 preparation marker 冻结可恢复密文选择，再物化双 final，最后用不可变 commit marker 原子开放读取。它支持原 temp 重放和经新 upload 完整验证后的 prepared cipher exact replay，不提供 list、delete、任意 key、RFC3394 wrap、KEK/KMS 或 PostgreSQL 实现。

## 上下游

Creator Worker 将调用 staging、builder 与 `prepareEncryptedSnapshotUpload` 生成完整发布候选。Authoring API 保存 upload request 后调用对象存储 adapter 签发两条 PUT；Verifier 从两个 temp 对象解密复核，并以 preparation/commit marker 完成可恢复原子发布。Worker 只需要 `SnapshotDataKeyCreatorPort`，Verifier/Recovery 只需要 `SnapshotDataKeyUnwrapperPort`；不得默认给同一进程组合 authority。Authoring 数据层仍需实现两个 Envelope、两个 marker digest、AgentVersion、wrapped DEK 与 Conversation pin 的受保护 PostgreSQL inventory，并在 commit 已核验后才标记 VERIFIED。当前源码可连接 S3-compatible MinIO，但不实现 PostgreSQL、Kubernetes、IAM/Object Lock、RFC3394 wrap、KMS/KEK 或 macOS Keychain。
