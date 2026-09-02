-- 0014 · V2 终端用户登录标识从手机号切换为邮箱（C 端统一走邮件验证码登录）。
-- 迁移纪律不变：只追加 ALTER，不改 0012/0013 既有内容；存量 phone 身份行、phone 渠道
-- 挑战与 dev_phone_otp 会话全部保持合法，新写入使用 email / email_otp。

-- 身份类型放宽：phone 与 wechat_openid 存量合法，email 为新增登录标识。
ALTER TABLE v2_identities DROP CONSTRAINT ck_v2_identity_type;
ALTER TABLE v2_identities ADD CONSTRAINT ck_v2_identity_type
  CHECK (type IN ('phone', 'wechat_openid', 'email'));

-- identifier 放宽为通用非空/长度约束：规范邮箱最长 254 字符，原 5..128 容纳不下；
-- 控制字符禁令保留。具体格式校验收口在 authz 应用层（数据库不做邮箱语法判定）。
ALTER TABLE v2_identities DROP CONSTRAINT ck_v2_identity_identifier;
ALTER TABLE v2_identities ADD CONSTRAINT ck_v2_identity_identifier CHECK (
  char_length(identifier) BETWEEN 1 AND 254
  AND identifier !~ '[[:cntrl:]]'
);

-- 手机号格式约束随登录方式切换取消：phone 行不再新增（登录只走邮箱），
-- 保留它只会把历史格式假设固化进库约束。
ALTER TABLE v2_identities DROP CONSTRAINT ck_v2_identity_phone;

-- 挑战渠道允许 email；phone 仅为存量行保留。
ALTER TABLE v2_auth_challenges DROP CONSTRAINT ck_v2_challenge_channel;
ALTER TABLE v2_auth_challenges ADD CONSTRAINT ck_v2_challenge_channel
  CHECK (channel IN ('phone', 'email'));

-- 会话认证方式允许 email_otp；dev_phone_otp 仅为存量行保留。
ALTER TABLE v2_sessions DROP CONSTRAINT ck_v2_session_method;
ALTER TABLE v2_sessions ADD CONSTRAINT ck_v2_session_method
  CHECK (auth_method IN ('dev_phone_otp', 'email_otp'));
