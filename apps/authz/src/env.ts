// 启动配置：所有环境变量在这里解析与校验，进程其余部分只读结构化结果。
import { ASSERTION_DEFAULT_TTL_SECONDS, ASSERTION_MAX_TTL_SECONDS } from './assertion.js';
import { OTP_CODE_PATTERN } from './crypto.js';

export interface AuthzEnv {
  NODE_ENV: string;
  PORT: number;
  HOST: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  /** 目标与验证码摘要的 HMAC 密钥，至少 32 字符。 */
  HMAC_SECRET: string;
  /** 开发态 OTP 万能码；无论是否配置 Resend 都可通过校验，与 Resend 同时缺失时登录接口返回 503。 */
  DEV_OTP_CODE?: string;
  /** Resend 发信；两键必须同时配置或同时缺省，缺省时登录只走万能码。 */
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  RESEND_API_BASE_URL: string;
  /** 共享域 Cookie 的 Domain 属性（如 .buildwithcombo.com）；缺省为主机限定 Cookie。 */
  SESSION_COOKIE_DOMAIN?: string;
  SESSION_COOKIE_SECURE: boolean;
  ASSERTION_PRIVATE_KEY: string;
  ASSERTION_KEY_ID: string;
  ASSERTION_ISSUER: string;
  ASSERTION_TTL_SECONDS: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true/false`);
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 4101);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PORT must be an integer within 1..65535');
  }
  return port;
}

function parseAssertionTtl(value: string | undefined): number {
  const ttl = Number(value ?? ASSERTION_DEFAULT_TTL_SECONDS);
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > ASSERTION_MAX_TTL_SECONDS) {
    throw new Error(
      `AUTHZ_ASSERTION_TTL_SECONDS must be an integer within 1..${ASSERTION_MAX_TTL_SECONDS}`,
    );
  }
  return ttl;
}

const OFFICIAL_RESEND_API_BASE_URL = 'https://api.resend.com';
// 与 V1 相同的发件人形态：裸邮箱或 `显示名 <邮箱>`。
const RESEND_MAILBOX_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;

function isValidResendFromAddress(value: string): boolean {
  const displayForm = value.match(/<([^>]+)>\s*$/);
  return RESEND_MAILBOX_PATTERN.test(displayForm ? displayForm[1]! : value);
}

function parseResendBaseUrl(value: string | undefined): string {
  const raw = value || OFFICIAL_RESEND_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw.endsWith('/') ? raw : `${raw}/`);
  } catch {
    throw new Error('RESEND_API_BASE_URL must be an http(s) URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('RESEND_API_BASE_URL must be an http(s) URL');
  }
  return raw;
}

export function loadEnv(): AuthzEnv {
  const hmacSecret = required('AUTHZ_HMAC_SECRET');
  if (hmacSecret.length < 32) {
    throw new Error('AUTHZ_HMAC_SECRET must be at least 32 characters');
  }
  const devOtpCode = optional('AUTHZ_DEV_OTP_CODE');
  if (devOtpCode !== undefined && !OTP_CODE_PATTERN.test(devOtpCode)) {
    throw new Error('AUTHZ_DEV_OTP_CODE must be exactly six digits');
  }
  const cookieDomain = optional('AUTHZ_SESSION_COOKIE_DOMAIN');
  if (cookieDomain !== undefined && !/^\.?[a-z0-9.-]+\.[a-z]{2,}$/i.test(cookieDomain)) {
    throw new Error('AUTHZ_SESSION_COOKIE_DOMAIN must be a domain like .buildwithcombo.com');
  }
  const resendApiKey = optional('RESEND_API_KEY');
  const resendFromEmail = optional('RESEND_FROM_EMAIL');
  if ((resendApiKey === undefined) !== (resendFromEmail === undefined)) {
    throw new Error('RESEND_API_KEY and RESEND_FROM_EMAIL must be configured together');
  }
  if (resendFromEmail !== undefined && !isValidResendFromAddress(resendFromEmail)) {
    throw new Error('RESEND_FROM_EMAIL must be a mailbox or `Display <mailbox>` form');
  }
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  return {
    NODE_ENV: nodeEnv,
    PORT: parsePort(process.env.PORT),
    HOST: process.env.HOST ?? '0.0.0.0',
    DATABASE_URL: required('DATABASE_URL'),
    REDIS_URL: required('REDIS_URL'),
    HMAC_SECRET: hmacSecret,
    DEV_OTP_CODE: devOtpCode,
    RESEND_API_KEY: resendApiKey,
    RESEND_FROM_EMAIL: resendFromEmail,
    RESEND_API_BASE_URL: parseResendBaseUrl(process.env.RESEND_API_BASE_URL),
    SESSION_COOKIE_DOMAIN: cookieDomain,
    SESSION_COOKIE_SECURE: parseBoolean('AUTHZ_SESSION_COOKIE_SECURE', nodeEnv === 'production'),
    ASSERTION_PRIVATE_KEY: required('AUTHZ_ASSERTION_PRIVATE_KEY'),
    ASSERTION_KEY_ID: process.env.AUTHZ_ASSERTION_KEY_ID || 'authz-ed25519-1',
    ASSERTION_ISSUER: process.env.AUTHZ_ASSERTION_ISSUER || 'combo-authz',
    ASSERTION_TTL_SECONDS: parseAssertionTtl(process.env.AUTHZ_ASSERTION_TTL_SECONDS),
  };
}
