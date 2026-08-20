# @cb/creator-agent-snapshot

这个包实现 Creator-hosted Agent VNext Track A 可在本机和持续集成中验证的核心：它从活 Project 复制出一次性 staging，生成确定性 Manifest 和 `tar.zst`，计算 Snapshot、archive 与加密对象三个摘要，并建立不可变 AgentVersion 与 Conversation 版本固定模型。`@cb/creator-agent-protocol` 是 Manifest、AgentVersion 和 canonical digest 的唯一权威 schema；本包消费该协议，不维护第二份 wire contract。

## 当前能力

- `stageProject` 使用只读、禁止跟随符号链接的文件句柄复制普通文件，并在复制前后复核 inode、大小和时间指纹。打包阶段只读取 staging，不再读取活 Project。
- `buildSnapshotFromProject` 使用 UTF-8 byte order、固定 tar 元数据、RFC 8785 兼容 canonical JSON 和固定 zstd 参数生成可重复字节。
- `encryptSnapshotArchive` 消费权威 `SnapshotArchiveEnvelope` AAD，使用 AES-256-GCM 和每对象独立的 96-bit CSPRNG nonce，生成冻结的 `CSNPENC1 || nonce || ciphertext || tag` 字节布局；生产入口不接受调用方注入 nonce。
- `encryptSnapshotManifest` 使用同一 Snapshot DEK 和独立 CSPRNG nonce，把 canonical Manifest 加密为 `CSNPMAN1 || nonce || ciphertext || tag`；archive/manifest Envelope 必须绑定同一 Creator、Snapshot digest、KEK key id 与 wrapped DEK。
- `prepareEncryptedSnapshotUpload` 是 Creator Worker 的最小连接层：先完整复核已构建 Snapshot，再通过 create-only key port 生成一个 DEK，加密 archive/manifest，最后才构造包含两个完整 Envelope、cipher bytes/digest 与 canonical base64 checksum 的 upload-session request。它不会签发 URL，也没有 unwrap authority。
- `decryptAndVerifySnapshot` 先按 Envelope 复核完整对象长度/digest、magic、nonce/tag、AAD 与 AES-GCM 认证，认证成功后才把明文交给限制性 zstd/tar parser，再执行明文大小、archive digest、压缩比、tar header、路径、文件类型和逐文件摘要复核。
- `buildAgentVersion` 把 Snapshot、Behavior、Runtime、IO、Codex artifact、Schema 与模型策略冻结进 `versionDigest`。内存仓库只提供创建、读取和独立 revoke control，不提供修改执行字段的入口。
- `InMemoryConversationPinRepository` 在 Conversation 创建时固定 AgentVersion，之后任何换版请求都会拒绝。
- `S3ImmutableSnapshotObjectStore` 只在 Worker 已提供两个完整 Envelope 和 canonical base64 checksum 后签发 archive/manifest 两条短期 PUT；SignedHeaders 覆盖 exact length、checksum、`If-None-Match` 和完整 metadata。每个实例固定一个 Creator，公开 API 不接受任意 object key，也不提供 list/delete。
- `finalizeUpload` 先从两个 temp key 读取完整密文，完成 whole-object digest、双 AEAD、canonical Manifest/archive、逐文件和三 digest 复核，成功后才以 `If-None-Match: *` 冻结私有 preparation marker、物化两个正式 key，完整读回后再条件创建唯一 commit marker。Reader 在 commit 前看不到 partial final。原 temp 丢失时，新 DEK/nonce upload 必须先独立完成全部明文身份验证，Verifier 才能用 preparation 中冻结的 DEK/nonce/AAD exact replay 同一密文并补齐，不依赖 delete。wrapped DEK 和 KEK key id 只存在于 Data-flow Allowlist 明确授权的私有 marker body，不复制进 MinIO user metadata、URL、日志或普通 reader 路径。

## 冻结策略

- 文件数上限是 2,000，单文件上限是 10 MiB，内容总量上限是 200 MiB，压缩对象上限是 50 MiB，相对路径上限是 512 UTF-8 bytes。
- 异常压缩比上限固定为 100:1。达到上限可以通过，超过上限拒绝。
- 路径统一为 NFC，再使用 Unicode 小写映射做大小写冲突键。两个不同源路径得到同一规范化路径或大小写键时均拒绝。
- 普通文件归档 mode 固定为 `0444`，uid、gid 和 mtime 固定为零。空目录和目录 entry 不进入 archive，因此没有可观察的 directory mode。归档格式冻结为 `combo-ustar-pax/1`，长路径使用确定性的 POSIX PAX `path` 记录。压缩器固定使用 Node `node:zlib` 内置的 zstd `1.5.7`、level 9、checksum 与 content-size frame；版本不匹配时 fail closed。canonical archive只允许一个主 frame：若 Node sync wrapper 因默认输出 chunk 精确对齐而追加固定13-byte空frame，生产代码只在 retry bytes逐字等于原主frame前缀时归一化，否则fail closed；65,537-byte retry buffer是非语义wrapper workaround，不写入Manifest身份。
- `.git`、`node_modules`、`.env*`、`.ssh`、`.codex`、常见系统缓存、LFS pointer、symlink、hardlink、sparse file 和特殊文件全部拒绝。
- Secret 检测只使用列出的高置信度凭据形状。Alpha 没有忽略或白名单开关：误报时发布失败，Creator 必须从 Project 中移除或替换该内容后重新生成 Snapshot；扫描错误不会回显匹配正文或绝对路径。

## 证据边界

本包提供 E1 级确定性、属性、恶意输入、真实 AES-GCM 向量和冻结 binary framing 证据。本机测试会在独立 Node 进程复核冻结的 tar/zstd golden，并现场生成 digest-bound 1 MiB accepted/ratio-bomb 向量；后者只构成本机 deterministic 与 fake S3 发布前拒绝证据，不是 exact 100:1 或 E2。`SNP-008` 的独立 compact fixture会现场生成真实非稀疏 Project与52,428,799/800/801-byte单frame canonical archives：前两条完整走 builder→verifier，N+1先证明archive合法canonical；builder在压缩后拒绝，`verifySnapshotArchive`则在任何manifest/zstd/tar parser前拒绝。该本机 PASS 仍不是 Linux SHA-bound G1 evidence，跨平台状态保持 `NOT_RUN`。AgentVersion 构建测试还复用 Protocol 的七个闭世界 Context Tools 变体，证明本地 `buildAgentVersion` 只接受固定顺序的 `read_context/list_context/search_context`，并把拒绝转换为不回显输入的稳定错误；这不证明真实 Guest 工具、root-fd confinement 或 Linux Codex。另一个资源边界测试复用四个既有 AgentVersion cases，执行 N-1/N/N+1 共 12 个生产 builder 结果；它证明当前实现的目标值、摘要稳定性、深冻结和超限错误，但 `developerInstructions=32` 仍需独立 policy ADR，不能由测试自行冻结产品政策。Snapshot Manifest raw-ingress 测试复用 Protocol 的 12-owner corpus，为生产 `parseSnapshotManifest` 执行 76 个 baseline/hostile结果；它只证明稳定错误、无输入回显和 input bytes不变，不替代真实 path、archive verifier、T0 Linux 或 `SNP-010`。支持的 Linux builder 仍必须在 CI 运行同一 gate，在 Linux 结果产生前跨平台证据状态是 `NOT_RUN`。`SnapshotObjectRepository` 是仅供旧领域单元测试的内存仓库；`SnapshotDataKeyCreatorPort` 与 `SnapshotDataKeyUnwrapperPort` 分别冻结 Worker 与 verifier 的最小密钥 authority，`SnapshotKeyEnvelopePort` 只是有意组合两者的便利类型；`S3ImmutableSnapshotObjectStore` 是真实 S3-compatible 双密文对象、Signed PUT 与 verifier 适配器。

AgentVersion digest corpus另把三种独立raw JSON materialization与六个语义mutation绑定到固定component/version digests，因此仓库内`AVR-001/003/004/006`已具production builder证据。`AVR-002`仍缺statistics的production owner，`AVR-005`仍因v1 IOContract只有一个合法literal语义而无法满足“合法变体改变digest”，`AVR-007..009`仍缺真实PG/Authoring create/read/idempotency事务；这些缺口不会由内存仓库或本机E1测试冒充。

Manifest byte Gate 将4 MiB encrypted/read-all defense cap与2,536,575-byte reachable canonical semantic maximum分离。专用测试用2,000个合法唯一有序的512-byte路径、128-byte media type和受200 MiB总量约束的最优size位数recipe证明全局上界，并把真实 N-1/N/N+1送入production parser；N+1在 raw JSON parser 调用前稳定拒绝且不回显canary。这只关闭 Manifest byte owner，不代替其余 SCH-004 ledger、正式T0 Linux或Snapshot云端Gate。

`pnpm -F @cb/creator-agent-snapshot test:minio:e2` 会用固定版本的 MinIO 镜像、临时 root credential、随机 loopback 端口和 tmpfs bucket 运行真实组件集成测试，覆盖两条真实 SigV4 PUT、完整 SignedHeaders、缺 header 拒绝、32 路正式化竞争、损坏 temp 后同 digest 重试、archive final 后 manifest 故障的 pre-commit 不可见性、原 temp 重放、新 DEK/nonce 与原 temp 丢失后的 exact replay、commit 已恢复但 final 缺失时 reader fail-closed 并由新 upload 修复、不同 cipher generation 并发收敛、读取后完整解密复核和特权越权篡改检测。只有该 disposable 测试显式打开 `allowInsecureLoopbackPresignedUrls`；默认和公开地址仍强制 HTTPS。它证明的是 adapter 与 MinIO 的 E2 对象语义；测试进程持有管理员 credential，未配置生产 IAM/Object Lock，因此不证明服务身份最小权限、marker 抵抗特权协同改写或管理员不可覆盖。

当前 verifier 会在进程内持有两个认证后的明文和最多 200 MiB 的解包正文。真实 RFC3394 wrap、KEK/KMS 适配器（包括只接受受审 keyId，并保证 unresolved preparation 的旧 KEK 在完成/回收前仍可 unwrap）、技术方案要求的独占 tmpfs、272 MiB 组合 quota、进程或 Pod 崩溃清零、PostgreSQL 双 Envelope/marker inventory 与不可变约束、MinIO IAM/Object Lock、旧 writer/reader quiesce 或迁移、Retention/Reclaimer 和异机 DR 仍是 `BLOCKED/NOT_IMPLEMENTED`，不能由该 E2 冒充完整 Gate 1。

当前 Node staging 使用 `lstat/realpath/open(O_NOFOLLOW)/fstat` 的多点身份复核，并包含根目录换 inode、换 symlink 和读中 mutation 的注入测试；Node 标准库没有暴露 `openat(2)` 目录句柄遍历。生产 Gate 1 仍需 native helper 或等价的 root-fd confinement 证明，现有 E1 不冒充该 OS 级 E2 证据。

## 文件关系

源码职责见 `src/README.md`，测试夹具与覆盖范围见 `src/__tests__/README.md`。这个包不依赖 authoring、runtime 或 Creator Worker，后续服务通过包入口消费其纯函数和端口接口。
