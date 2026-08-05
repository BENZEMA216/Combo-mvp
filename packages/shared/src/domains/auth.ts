// 认证域：邮箱六位验证码与 PostgreSQL 不透明浏览器会话。
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, TraceIdSchema } from '../core/ids.js';
import { MCP_AUTHORIZATION_REQUEST_PATTERN, OAUTH_AUTHORIZE_PATH } from './mcp-oauth.js';

/** 角色。当前只有 creator；权限模型扩展时加值。 */
export const RoleSchema = z.enum(['creator']);
export type Role = z.infer<typeof RoleSchema>;

// ---------- 固定认证参数 ----------
export const AUTH_SESSION_COOKIE_NAME = 'cb_session';
export const AUTH_SESSION_COOKIE_PRODUCTION_NAME = '__Host-cb_session';
export const AUTH_SESSION_COOKIE_PATH = '/';
export const AUTH_SESSION_COOKIE_PREFIX = 's1.';
export const AUTH_SESSION_TOKEN_BYTES = 32;
export const AUTH_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const AUTH_SESSION_COOKIE_MAX_AGE_SECONDS = AUTH_SESSION_TTL_SECONDS;
export const AUTH_SESSION_COOKIE_HTTP_ONLY = true;
export const AUTH_SESSION_COOKIE_SAME_SITE = 'lax' as const;
export const AUTH_SESSION_COOKIE_VALUE_PATTERN = /^s1\.[A-Za-z0-9_-]{43}$/;

/**
 * HTTPS 入口使用主机限定前缀；显式的本地 HTTP 开发入口使用不带前缀的同语义 Cookie。
 * 这里刻意不读取 NODE_ENV：具体发布环境是否允许 HTTP 由应用启动配置单独约束。
 */
export function authSessionCookieName(secure: boolean): string {
  return secure ? AUTH_SESSION_COOKIE_PRODUCTION_NAME : AUTH_SESSION_COOKIE_NAME;
}

export const CREATOR_ACCOUNT_PATTERN = /^creator-[a-z2-7]{8}$/;
export const CreatorAccountSchema = z.string().regex(CREATOR_ACCOUNT_PATTERN);
export type CreatorAccount = z.infer<typeof CreatorAccountSchema>;

export const EMAIL_OTP_CODE_LENGTH = 6;
export const EMAIL_OTP_EXPIRES_IN_SECONDS = 5 * 60;
export const EMAIL_OTP_RESEND_AFTER_SECONDS = 60;

export const AUTH_DEFAULT_RETURN_TO = '/tasks';
export const AUTH_RETURN_TO_MAX_LENGTH = 512;
const AUTH_ID_PATH_SEGMENT =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const CAPABILITY_RELEASE_RETURN_PATH = new RegExp(
  `^/capabilities/${AUTH_ID_PATH_SEGMENT}/release(?:/(?:pricing|identity|review|success))?$`,
  'i',
);

export const AuthSessionCookieValueSchema = z
  .string()
  .regex(AUTH_SESSION_COOKIE_VALUE_PATTERN, '会话 Cookie 格式不合法');
export type AuthSessionCookieValue = z.infer<typeof AuthSessionCookieValueSchema>;

// ---------- 邮箱与站内回跳 ----------
const EMAIL_INPUT_PATTERN = /^[^\s@]+@[^\s@]+$/u;
const ASCII_DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** 请求中的邮箱原文。该 schema 不裁剪、不折叠 local-part，也不执行供应商特有规则。 */
export const EmailAddressInputSchema = z
  .string()
  .min(3)
  .max(254)
  .regex(EMAIL_INPUT_PATTERN, '邮箱格式不合法')
  .refine((email) => !containsAsciiControlCharacter(email), '邮箱格式不合法');
export type EmailAddressInput = z.infer<typeof EmailAddressInputSchema>;

/** 服务端完成 IDNA 处理后可对外返回和写入身份表的规范邮箱。 */
export const NormalizedEmailAddressSchema = EmailAddressInputSchema.refine((email) => {
  const separator = email.indexOf('@');
  const domain = email.slice(separator + 1);
  return (
    domain === domain.toLowerCase() &&
    domain.length <= 253 &&
    domain.split('.').every((label) => ASCII_DOMAIN_LABEL_PATTERN.test(label))
  );
}, '邮箱域名必须是小写 ASCII 规范形式');
export type NormalizedEmailAddress = z.infer<typeof NormalizedEmailAddressSchema>;

/**
 * 只保留认证完成后允许进入的站内业务路径。任何不可信输入统一回落到 /tasks，
 * 调用方不得把返回值再次解释成外部 URL。
 */
export function sanitizeAuthReturnTo(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > AUTH_RETURN_TO_MAX_LENGTH ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('//') ||
    value.includes('\\') ||
    containsAsciiControlCharacter(value) ||
    /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)
  ) {
    return AUTH_DEFAULT_RETURN_TO;
  }

  try {
    const base = 'https://auth-return.invalid';
    const parsed = new URL(value, base);
    const path = parsed.pathname;
    const oauthRequestToken = parsed.searchParams.get('request');
    const oauthAuthorizationResume =
      path === OAUTH_AUTHORIZE_PATH &&
      parsed.hash === '' &&
      [...parsed.searchParams.keys()].length === 1 &&
      typeof oauthRequestToken === 'string' &&
      MCP_AUTHORIZATION_REQUEST_PATTERN.test(oauthRequestToken);
    const allowed =
      path === '/tasks' ||
      path.startsWith('/tasks/') ||
      path === '/capabilities' ||
      CAPABILITY_RELEASE_RETURN_PATH.test(path) ||
      path === '/try' ||
      path.startsWith('/try/') ||
      oauthAuthorizationResume;

    if (parsed.origin !== base || parsed.username || parsed.password || !allowed) {
      return AUTH_DEFAULT_RETURN_TO;
    }

    return `${path}${parsed.search}${parsed.hash}`;
  } catch {
    return AUTH_DEFAULT_RETURN_TO;
  }
}

/** 已经过 sanitizeAuthReturnTo 的服务端回跳值。 */
export const AuthReturnToSchema = z
  .string()
  .refine((value) => sanitizeAuthReturnTo(value) === value, 'returnTo 必须是允许的站内路径');
export type AuthReturnTo = z.infer<typeof AuthReturnToSchema>;

/** 请求中的 returnTo 会在解析时统一净化；非字符串仍是契约错误。 */
export const AuthReturnToInputSchema = z.string().transform((value) => sanitizeAuthReturnTo(value));

// ---------- 邮箱 challenge ----------
export const EmailChallengeBodySchema = z
  .object({
    email: EmailAddressInputSchema,
  })
  .strict();
export type EmailChallengeBody = z.input<typeof EmailChallengeBodySchema>;
export const EmailChallengeRequestSchema = EmailChallengeBodySchema;
export type EmailChallengeRequest = EmailChallengeBody;

/** 成功响应解码器只校验已知必填字段，并忽略服务端未来新增字段。 */
export const EmailChallengeResultSchema = z.object({
  accepted: z.literal(true),
  expiresInSeconds: z.literal(EMAIL_OTP_EXPIRES_IN_SECONDS),
  resendAfterSeconds: z.literal(EMAIL_OTP_RESEND_AFTER_SECONDS),
});
export type EmailChallengeResult = z.infer<typeof EmailChallengeResultSchema>;

// ---------- 邮箱 verification ----------
export const EmailOtpCodeSchema = z
  .string()
  .regex(new RegExp(`^[0-9]{${EMAIL_OTP_CODE_LENGTH}}$`), '验证码必须是六位数字');
export type EmailOtpCode = z.infer<typeof EmailOtpCodeSchema>;

export const EmailVerificationBodySchema = z
  .object({
    email: EmailAddressInputSchema,
    code: EmailOtpCodeSchema,
    returnTo: AuthReturnToInputSchema.optional().default(AUTH_DEFAULT_RETURN_TO),
  })
  .strict();
/** 线上请求输入；returnTo 在 JSON 中可省略。 */
export type EmailVerificationBody = z.input<typeof EmailVerificationBodySchema>;
/** schema 解析后的安全输入；returnTo 始终是白名单内路径。 */
export type ParsedEmailVerificationBody = z.output<typeof EmailVerificationBodySchema>;
export const EmailVerificationRequestSchema = EmailVerificationBodySchema;
export type EmailVerificationRequest = EmailVerificationBody;

// ---------- /me 视图 ----------
export const MeViewSchema = z.object({
  id: IdSchema,
  account: CreatorAccountSchema,
  email: NormalizedEmailAddressSchema,
  roles: z.array(RoleSchema).length(1),
  createdAt: IsoDateTimeSchema,
  lastLoginAt: IsoDateTimeSchema.nullable(),
});
export type MeView = z.infer<typeof MeViewSchema>;

export const EmailVerificationResultSchema = z.object({
  user: MeViewSchema,
  returnTo: AuthReturnToSchema,
});
export type EmailVerificationResult = z.infer<typeof EmailVerificationResultSchema>;

// ---------- 登出 ----------
export const LogoutBodySchema = z.object({}).strict();
export type LogoutBody = z.infer<typeof LogoutBodySchema>;
export const LogoutRequestSchema = LogoutBodySchema;
export type LogoutRequest = LogoutBody;

export const LogoutResultSchema = z.object({
  loggedOut: z.literal(true),
});
export type LogoutResult = z.infer<typeof LogoutResultSchema>;

// ---------- 四条认证接口的成功包络 ----------
export const AuthResponseMetaSchema = z.object({ traceId: TraceIdSchema });
export type AuthResponseMeta = z.infer<typeof AuthResponseMetaSchema>;

/** 认证成功包络要求 traceId，但允许各层以可选字段向前扩展。 */
export function authEnvelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({ data, meta: AuthResponseMetaSchema });
}

export const EmailChallengeResponseSchema = authEnvelopeSchema(EmailChallengeResultSchema);
export type EmailChallengeResponse = z.infer<typeof EmailChallengeResponseSchema>;

export const EmailVerificationResponseSchema = authEnvelopeSchema(EmailVerificationResultSchema);
export type EmailVerificationResponse = z.infer<typeof EmailVerificationResponseSchema>;

export const MeResponseSchema = authEnvelopeSchema(MeViewSchema);
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const LogoutResponseSchema = authEnvelopeSchema(LogoutResultSchema);
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

// ---------- 鉴权上下文（中间件注入，非对外响应体）----------
export interface AuthContext {
  userId: string;
  account: string;
  roles: Role[];
}
