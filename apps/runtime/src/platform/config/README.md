# platform/config 环境配置

`env.ts` 使用 Zod 解析 Runtime 配置。生产缺少数据库、Redis、对象存储、`PUBLIC_APP_ORIGINS`、`SESSION_COOKIE_SECURE` 或完整发布元数据时拒绝启动。公开站点使用最多八项的严格逗号列表，不接受空白、重复项、路径、凭据或隐式规范化。

浏览器认证只读取 PostgreSQL 中的共享不透明会话，不配置远端身份提供商、JWT 用户验签、开发登录或会话签名密钥。发布身份来自 `COMBO_ENVIRONMENT`、`COMBO_SOURCE_SHA`、`COMBO_RELEASE_ID`、`COMBO_BUILT_AT`、`COMBO_RELEASE_MANIFEST_DIGEST` 和 `COMBO_WEB_ASSET_MANIFEST`。

Creator Agent visible transcript 只配置 provider 名、非敏感 namespace、允许的 keyRef prefix、最低 key version policy 与 keyring 文件路径。USER/ASSISTANT durable Message authority另使用 `CREATOR_AGENT_MESSAGE_AUTHORITY_PROVIDER` + mounted keyring，Execution Capability signer/budget authority使用独立 `CREATOR_AGENT_EXECUTION_AUTHORITY_PROVIDER` + mounted private-key file。三类 authority 唯一已实现的 provider 都是 `test-k8s-secret-file`，且 `COMBO_ENVIRONMENT` 必须精确为 `test`；Execution signer私钥不进入共享 Message/Gateway keyring。Preview、Production 或未知环境会在 env 校验时失败关闭。公开 flag 开启时 providers、专用数据库 URL 和全部 policy/file paths 必须同时存在；即使在非 production 的 Node 模式下也不允许解析失败后回落为 feature-off 默认值。

`test-k8s-secret-file` 只读取 Test Kubernetes Secret volume 中的严格 0600 regular file，拒绝 symlink、wrong owner、duplicate JSON key、非 fatal UTF-8、未知字段和不合法 key/curve/budget。Runtime 环境变量不接受 raw HMAC/encryption/signing key、base64 key、secret fallback 或本地默认 key。公开 flag 为 false 时 bootstrap 不构造 provider、readiness 不探测它，也不读取 keyring。

`SESSION_COOKIE_SECURE` 独立于 `NODE_ENV`。Test、Preview 与 Production 发布身份都必须选择 Secure Cookie 和 HTTPS origin；非 production 的本地开发仍可显式选择非 Secure Cookie 和 HTTP origin。Runtime 与 authoring 对这两个配置使用相同语义。

消费计费由 `RUNTIME_BILLING_FREE_USES` 和 `RUNTIME_BILLING_UNIT_PRICE_CENTS` 控制。开发和测试默认分别为三次和一百分，生产必须显式配置；每笔用量会保存当时的额度与单价快照。

可选沙箱默认关闭。开启时，镜像必须使用不可变 SHA-256 摘要，签名私钥必须存在，RuntimeClass 固定为 `gvisor`。配置修订号用于滚动发布期间阻止旧副本替换较新的 Pod。普通容量是四个槽位；第五槽还要求显式记录真实集群验证。

关闭总截止时间由 `RUNTIME_SHUTDOWN_TIMEOUT_MS` 控制。沙箱命令、启动、空闲、绝对生命周期和清扫周期分别由对应的 `SANDBOX_*` 变量控制，绝对生命周期必须大于空闲期限。
