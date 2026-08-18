// 登录与 session 的业务逻辑。依赖以端口注入：repo.ts 提供 PostgreSQL 实现，
// cache.ts 提供 Redis 实现，测试注入内存假实现，不依赖外部服务。
import { randomBytes } from 'node:crypto';
import {
  OTP_CHALLENGE_TTL_SECONDS,
  OTP_CODE_PATTERN,
  V2_SESSION_TTL_SECONDS,
  digestPhoneCode,
  digestPhoneTarget,
  digestSessionCookieValue,
  generateSessionCookieValue,
  normalizePhone,
  type RandomBytes,
} from './crypto.js';

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

/** 终端用户与认证状态的持久层端口（PostgreSQL 事实源）。 */
export interface AuthzStore {
  /** 作废旧挑战并写入新挑战，同一目标同一时间最多一个未完成挑战。 */
  replaceChallenge(input: {
    targetDigest: Buffer;
    codeDigest: Buffer;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * 校验并消费目标当前唯一未完成挑战。验证码不匹配时累加失败次数，
   * 达到上限后作废挑战；无论成败挑战都只能消费一次。
   */
  consumeChallenge(input: { targetDigest: Buffer; candidateCodeDigest: Buffer }): Promise<boolean>;
  /** 按手机号身份查已有用户；首次登录时同事务创建用户与身份，返回用户主键。 */
  findOrCreatePhoneUser(phone: string): Promise<string>;
  insertSession(input: {
    userId: string;
    tokenDigest: Buffer;
    expiresAt: Date;
  }): Promise<ResolvedSession>;
  /** 未知、过期与已撤销会话统一返回 null。 */
  resolveSession(tokenDigest: Buffer): Promise<ResolvedSession | null>;
  revokeSession(tokenDigest: Buffer): Promise<void>;
}

/** 会话读路径缓存端口。缓存方法的实现自己吞错降级，调用方把缓存视为尽力而为。 */
export interface SessionCache {
  get(tokenDigest: Buffer): Promise<ResolvedSession | null>;
  set(session: ResolvedSession, tokenDigest: Buffer): Promise<void>;
  del(tokenDigest: Buffer): Promise<void>;
}

export interface AuthzServiceDependencies {
  store: AuthzStore;
  cache: SessionCache;
  hmacSecret: string;
  /** 开发态万能码；未配置时登录接口不可用。 */
  devOtpCode?: string;
  randomBytes?: RandomBytes;
  now?: () => number;
}

export type RequestOtpResult =
  | { kind: 'accepted'; expiresInSeconds: number }
  | { kind: 'invalid_input' }
  | { kind: 'unavailable' };

/** 开发态 OTP：挑战落库时直接写入万能码摘要，跳过真实短信投递。 */
export async function requestOtp(
  deps: AuthzServiceDependencies,
  input: { phone: string },
): Promise<RequestOtpResult> {
  const phone = normalizePhone(input.phone);
  if (!phone) return { kind: 'invalid_input' };
  if (!deps.devOtpCode || !OTP_CODE_PATTERN.test(deps.devOtpCode) || !secretsReady(deps)) {
    return { kind: 'unavailable' };
  }

  const targetDigest = digestPhoneTarget(deps.hmacSecret, phone);
  const codeDigest = digestPhoneCode(deps.hmacSecret, targetDigest, deps.devOtpCode);
  const now = deps.now?.() ?? Date.now();
  await deps.store.replaceChallenge({
    targetDigest,
    codeDigest,
    expiresAt: new Date(now + OTP_CHALLENGE_TTL_SECONDS * 1000),
  });
  return { kind: 'accepted', expiresInSeconds: OTP_CHALLENGE_TTL_SECONDS };
}

export type VerifyOtpResult =
  | { kind: 'ok'; userId: string; sessionCookie: string; expiresInSeconds: number }
  | { kind: 'invalid_input' }
  | { kind: 'invalid_code' }
  | { kind: 'unavailable' };

/** 校验 OTP；首次登录自动建用户与手机号身份，随后签发不透明会话 Cookie。 */
export async function verifyOtp(
  deps: AuthzServiceDependencies,
  input: { phone: string; code: string },
): Promise<VerifyOtpResult> {
  const phone = normalizePhone(input.phone);
  if (!phone || !OTP_CODE_PATTERN.test(input.code)) return { kind: 'invalid_input' };
  if (!secretsReady(deps)) return { kind: 'unavailable' };

  const targetDigest = digestPhoneTarget(deps.hmacSecret, phone);
  const candidateCodeDigest = digestPhoneCode(deps.hmacSecret, targetDigest, input.code);
  const consumed = await deps.store.consumeChallenge({ targetDigest, candidateCodeDigest });
  if (!consumed) return { kind: 'invalid_code' };

  const userId = await deps.store.findOrCreatePhoneUser(phone);
  const sessionCookie = generateSessionCookieValue(deps.randomBytes ?? randomBytes);
  const tokenDigest = digestSessionCookieValue(sessionCookie);
  if (!tokenDigest) return { kind: 'unavailable' };

  const now = deps.now?.() ?? Date.now();
  const session = await deps.store.insertSession({
    userId,
    tokenDigest,
    expiresAt: new Date(now + V2_SESSION_TTL_SECONDS * 1000),
  });
  await deps.cache.set(session, tokenDigest);
  return {
    kind: 'ok',
    userId,
    sessionCookie,
    expiresInSeconds: V2_SESSION_TTL_SECONDS,
  };
}

function secretsReady(deps: AuthzServiceDependencies): boolean {
  return deps.hmacSecret.length >= 32;
}

/**
 * 解析会话 Cookie：Redis 缓存优先（PostgreSQL 抖动不影响已登录用户），
 * 缓存未命中或不可用时回源 PostgreSQL 并尽力回填。存储异常向上抛给路由层映射 503。
 */
export async function resolveSession(
  deps: Pick<AuthzServiceDependencies, 'store' | 'cache'>,
  cookieValue: string | undefined,
): Promise<ResolvedSession | null> {
  const tokenDigest = digestSessionCookieValue(cookieValue);
  if (!tokenDigest) return null;

  // 缓存实现按约定自行吞错；这里再做一层防御，缓存异常一律按未命中回源。
  let cached: ResolvedSession | null = null;
  try {
    cached = await deps.cache.get(tokenDigest);
  } catch {
    cached = null;
  }
  const now = Date.now();
  if (cached && cached.expiresAt.getTime() > now) return cached;
  if (cached) await deps.cache.del(tokenDigest);

  const session = await deps.store.resolveSession(tokenDigest);
  if (!session) return null;
  await deps.cache.set(session, tokenDigest);
  return session;
}

/** 无会话、畸形会话与重复登出都视为成功。 */
export async function logout(
  deps: Pick<AuthzServiceDependencies, 'store' | 'cache'>,
  cookieValue: string | undefined,
): Promise<void> {
  const tokenDigest = digestSessionCookieValue(cookieValue);
  if (!tokenDigest) return;
  await deps.store.revokeSession(tokenDigest);
  await deps.cache.del(tokenDigest);
}
