<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-002: Exact canonical archive implementation identity

- Status: accepted
- Owner: Protocol
- Decision date: 2026-08-13

## Decision

JSON 使用 combo-rfc8785-jcs/1；tar 使用受审自有 combo-ustar-pax/1，省略 directory entries，文件 mode 0444、uid/gid/mtime 为 0；压缩使用 Node zlib 链接的 zstd 1.5.7，level=9、checksum/content-size on、dictionary-id off、workers=0。任何实现或参数变化都是新协议身份并须重跑 golden bytes。

## Alternatives considered

- 声称 tar-stream 版本；拒绝，因为实际 builder 没有使用该依赖。
- 只冻结 tar/zstd 格式不冻结实现参数；拒绝，因为不能复现 artifact bytes。

## Evidence

- SnapshotManifest/1 runtime schema and golden fixture
- Track A deterministic custom packer/parser cross-contract test

## Privacy and security impact

精确身份阻止实现漂移、歧义 parser 与假 deterministic；canonicalizer 对 sparse array、undefined、非有限数 fail closed。

## Reversal triggers

- Node 或 zstd 版本不可获得，或 custom parser 安全审查要求替换；必须升级 Snapshot protocol。

## Affected protocol versions

- combo-rfc8785-jcs/1
- combo.snapshot-manifest/1
- combo.agent-version-manifest/1
