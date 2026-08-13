# Snapshot 与 AgentVersion 源码说明

## 文件职责

- `index.ts` 是唯一公开出口。
- `errors.ts` 定义稳定错误码和不携带文件正文、Secret 或绝对路径的错误对象。
- `policy.ts` 冻结 Alpha 的文件数、单文件、总量、压缩对象、路径和压缩比边界。
- `canonical-json.ts` 委托 `@cb/creator-agent-protocol` 生成 RFC 8785 兼容的 canonical JSON bytes，并把协议错误映射为稳定的本包错误码。
- `path-policy.ts` 负责路径规范化、UTF-8 byte 长度、保留目录、Unicode normalization 与大小写冲突检查。
- `content-policy.ts` 只接受 UTF-8 文本，拒绝 NUL、二进制控制字节、LFS pointer 和高置信度 Secret 模式。
- `tar.ts` 生成并解析固定元数据的 ustar/PAX archive，再用固定参数压缩和限制性解压 zstd。
- `manifest.ts` 直接消费共享协议的 `SnapshotManifestSchema` 与 digest helper，建立 Snapshot Manifest 并重算 canonical digest。
- `staging.ts` 从活 Project 安全复制到一次性 staging，并检测 symlink、hardlink、sparse、特殊文件和复制期间变化。
- `snapshot.ts` 组合 staging、Manifest、tar.zst、摘要和 verifier。
- `encryption.ts` 实现 AES-256-GCM 对象格式，并声明真实 KEK 适配器需要实现的端口。
- `agent-version.ts` 计算 Contract 与 AgentVersion 摘要，并实现测试用不可变 Version 与 Conversation pin 仓库。
- `repository.ts` 声明云对象持久化端口，并提供拒绝覆盖的内存实现。
- `object-storage.ts` 实现 Creator-bound 的 S3-compatible 密文 archive adapter：派生 upload/final key、条件不可变写入、并发重放裁决、严格 metadata/size/checksum/body 校验，以及从受保护 metadata 解包密钥后的完整 Snapshot 复核。它不提供 list、delete、任意 key 或 KEK 实现。

## 上下游

Creator Worker 将调用 staging 与 builder 生成发布候选。Authoring Verifier 通过对象存储 adapter 读取密文，再调用 decrypt 和 verifier 复核对象。Authoring 数据层仍需实现 Snapshot、AgentVersion、wrapped DEK reference 与 Conversation pin 的 PostgreSQL 适配器。当前源码可连接 S3-compatible MinIO，但不实现 PostgreSQL、Kubernetes、IAM、KMS/KEK 或 macOS Keychain。
