# platform/config 环境配置

`env.ts` 使用 Zod 解析 Runtime 配置。生产缺少数据库、Redis、对象存储、`PUBLIC_APP_ORIGINS`、`SESSION_COOKIE_SECURE` 或完整发布元数据时拒绝启动。公开站点使用最多八项的严格逗号列表，不接受空白、重复项、路径、凭据或隐式规范化。

浏览器认证只读取 PostgreSQL 中的共享不透明会话，不配置远端身份提供商、JWT 用户验签、开发登录或会话签名密钥。发布身份来自 `COMBO_ENVIRONMENT`、`COMBO_SOURCE_SHA`、`COMBO_RELEASE_ID`、`COMBO_BUILT_AT`、`COMBO_RELEASE_MANIFEST_DIGEST` 和 `COMBO_WEB_ASSET_MANIFEST`。

Creator Agent visible transcript 只配置非敏感的 KMS namespace、允许的 keyRef prefix 与最低 key version policy。Runtime 环境变量不接受 raw HMAC key、secret fallback 或本地默认 key；公开 flag 开启但未注入真实 KMS HMAC port 时 create 必须 fail closed。

`SESSION_COOKIE_SECURE` 独立于 `NODE_ENV`。Test、Preview 与 Production 发布身份都必须选择 Secure Cookie 和 HTTPS origin；非 production 的本地开发仍可显式选择非 Secure Cookie 和 HTTP origin。Runtime 与 authoring 对这两个配置使用相同语义。

消费计费由 `RUNTIME_BILLING_FREE_USES` 和 `RUNTIME_BILLING_UNIT_PRICE_CENTS` 控制。开发和测试默认分别为三次和一百分，生产必须显式配置；每笔用量会保存当时的额度与单价快照。

可选沙箱默认关闭。开启时，镜像必须使用不可变 SHA-256 摘要，签名私钥必须存在，RuntimeClass 固定为 `gvisor`。配置修订号用于滚动发布期间阻止旧副本替换较新的 Pod。普通容量是四个槽位；第五槽还要求显式记录真实集群验证。

关闭总截止时间由 `RUNTIME_SHUTDOWN_TIMEOUT_MS` 控制。沙箱命令、启动、空闲、绝对生命周期和清扫周期分别由对应的 `SANDBOX_*` 变量控制，绝对生命周期必须大于空闲期限。
