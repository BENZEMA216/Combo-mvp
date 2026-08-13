# @cb/creator-agent-snapshot

这个包实现 Creator-hosted Agent VNext Track A 可在本机和持续集成中验证的核心：它从活 Project 复制出一次性 staging，生成确定性 Manifest 和 `tar.zst`，计算 Snapshot、archive 与加密对象三个摘要，并建立不可变 AgentVersion 与 Conversation 版本固定模型。`@cb/creator-agent-protocol` 是 Manifest、AgentVersion 和 canonical digest 的唯一权威 schema；本包消费该协议，不维护第二份 wire contract。

## 当前能力

- `stageProject` 使用只读、禁止跟随符号链接的文件句柄复制普通文件，并在复制前后复核 inode、大小和时间指纹。打包阶段只读取 staging，不再读取活 Project。
- `buildSnapshotFromProject` 使用 UTF-8 byte order、固定 tar 元数据、RFC 8785 兼容 canonical JSON 和固定 zstd 参数生成可重复字节。
- `decryptAndVerifySnapshot` 先完成 cipher digest 与 AES-GCM tag/AAD 认证，认证成功后才把明文交给限制性 zstd/tar parser，再执行大小、压缩比、tar header、路径、文件类型和逐文件摘要复核。
- `encryptSnapshotArchive` 使用 AES-256-GCM 生成认证加密对象，并分别保留 Snapshot、archive 与 cipher digest。
- `buildAgentVersion` 把 Snapshot、Behavior、Runtime、IO、Codex artifact、Schema 与模型策略冻结进 `versionDigest`。内存仓库只提供创建、读取和独立 revoke control，不提供修改执行字段的入口。
- `InMemoryConversationPinRepository` 在 Conversation 创建时固定 AgentVersion，之后任何换版请求都会拒绝。
- `S3ImmutableSnapshotObjectStore` 把密文 archive 写入由 Creator UUID 与 Snapshot digest 派生的私有 key；上传和正式化都使用 `If-None-Match: *`，重放时只接受 size、三组 digest、完整 metadata 和密文字节全部一致的既有对象。每个实例固定一个 Creator，公开 API 不接受任意 object key，也不提供 list/delete。
- 对象读取会限制长度并复核 `Content-Length`、实际密文字节摘要、完整 metadata 集，以及服务返回时的 S3 SHA-256 checksum；`readAndVerify` 再调用受保护 metadata 提供的 key envelope port，完成 AEAD、archive、Manifest 与逐文件复核。wrapped DEK 和 key reference 不复制进 MinIO user metadata。

## 冻结策略

- 文件数上限是 2,000，单文件上限是 10 MiB，内容总量上限是 200 MiB，压缩对象上限是 50 MiB，相对路径上限是 512 UTF-8 bytes。
- 异常压缩比上限固定为 100:1。达到上限可以通过，超过上限拒绝。
- 路径统一为 NFC，再使用 Unicode 小写映射做大小写冲突键。两个不同源路径得到同一规范化路径或大小写键时均拒绝。
- 普通文件归档 mode 固定为 `0444`，uid、gid 和 mtime 固定为零。空目录和目录 entry 不进入 archive，因此没有可观察的 directory mode。归档格式冻结为 `combo-ustar-pax/1`，长路径使用确定性的 POSIX PAX `path` 记录。压缩器固定使用 Node `node:zlib` 内置的 zstd `1.5.7`、level 9、checksum 与 content-size frame；版本不匹配时 fail closed。
- `.git`、`node_modules`、`.env*`、`.ssh`、`.codex`、常见系统缓存、LFS pointer、symlink、hardlink、sparse file 和特殊文件全部拒绝。
- Secret 检测只使用列出的高置信度凭据形状。Alpha 没有忽略或白名单开关：误报时发布失败，Creator 必须从 Project 中移除或替换该内容后重新生成 Snapshot；扫描错误不会回显匹配正文或绝对路径。

## 证据边界

本包提供 E1 级确定性、属性、恶意输入和真实 AES-GCM 向量证据。本机测试会在独立 Node 进程复核冻结的 tar/zstd golden；支持的 Linux builder 仍必须在 CI 运行同一 gate，在 Linux 结果产生前跨平台证据状态是 `NOT_RUN`。`SnapshotObjectRepository` 与 `SnapshotKeyEnvelopePort` 仍分别定义内存领域对象与密钥封装端口；`S3ImmutableSnapshotObjectStore` 是真实 S3-compatible 密文 archive 适配器。

`pnpm -F @cb/creator-agent-snapshot test:minio:e2` 会用固定版本的 MinIO 镜像、临时 root credential、随机 loopback 端口和 tmpfs bucket 运行真实组件集成测试，覆盖条件写入重放、32 路正式化竞争、跨 Creator key 隔离、冲突写入、读取后完整解密复核和特权越权篡改检测。它证明的是 adapter 与 MinIO 的 E2 对象语义；测试进程持有管理员 credential，未配置生产 IAM/Object Lock，因此不证明服务身份最小权限或管理员不可覆盖。

当前 verifier 会在进程内持有认证后的 archive 和最多 200 MiB 的解包正文。生产 Verifier 仍需实现技术方案要求的独占 tmpfs、272 MiB 组合 quota、进程或 Pod 崩溃清零、正式 manifest 加密对象、真实 wrapped-DEK/KEK、PostgreSQL 不可变约束、MinIO IAM/Object Lock、Retention/Reclaimer 和 DR；这些项目仍是 `BLOCKED/NOT_IMPLEMENTED`，不能由该 E2 冒充完整 Gate 1。

当前 Node staging 使用 `lstat/realpath/open(O_NOFOLLOW)/fstat` 的多点身份复核，并包含根目录换 inode、换 symlink 和读中 mutation 的注入测试；Node 标准库没有暴露 `openat(2)` 目录句柄遍历。生产 Gate 1 仍需 native helper 或等价的 root-fd confinement 证明，现有 E1 不冒充该 OS 级 E2 证据。

## 文件关系

源码职责见 `src/README.md`，测试夹具与覆盖范围见 `src/__tests__/README.md`。这个包不依赖 authoring、runtime 或 Creator Worker，后续服务通过包入口消费其纯函数和端口接口。
