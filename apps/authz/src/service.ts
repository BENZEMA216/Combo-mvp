// 登录与 session 的业务逻辑。依赖以端口注入：repo.ts 提供 PostgreSQL 实现，
// cache.ts 提供 Redis 实现，resend.ts 提供真实发信实现，测试注入内存假实现，
// 不依赖外部服务。
import { randomBytes, randomUUID } from 'node:crypto';
import {
  OTP_CHALLENGE_TTL_SECONDS,
  OTP_CODE_PATTERN,
  V2_SESSION_TTL_SECONDS,
  digestEmailCode,
  digestEmailTarget,
  digestSessionCookieValue,
  generateOtpCode,
  generateSessionCookieValue,
  normalizeEmail,
  type RandomBytes,
} from './crypto.js';
import type { OtpMailer } from './resend.js';

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
  /** 按邮箱身份查已有用户；首次登录时同事务创建用户与身份，返回用户主键。 */
  findOrCreateEmailUser(email: string): Promise<string>;
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
  /**
   * 真实发信端口（Resend）。配置后挑战码随机生成并邮件投递；
   * 未配置时挑战码退化为 devOtpCode（仅验证期开发旁路）。
   */
  mailer?: OtpMailer;
  /**
   * 开发态万能码。无论是否配置发信通道都可以通过校验（验证期便利）；
   * 与发信通道同时缺失时登录接口返回 503。
   */
  devOtpCode?: string;
  randomBytes?: RandomBytes;
  now?: () => number;
}

export type RequestOtpResult =
  | { kind: 'accepted'; expiresInSeconds: number }
  | { kind: 'invalid_input' }
  | { kind: 'unavailable' };

/**
 * 请求登录验证码。配置了发信通道时生成随机码并投递：供应商受理才落库挑战；
 * 永久拒绝返回统一受理结果（不暴露邮箱可达性，也不回退明文）；暂时性故障与
 * 配置故障返回 unavailable。未配置发信通道时挑战直接写万能码摘要。
 */
export async function requestOtp(
  deps: AuthzServiceDependencies,
  input: { email: string },
): Promise<RequestOtpResult> {
  const email = normalizeEmail(input.email);
  if (!email) return { kind: 'invalid_input' };
  if (!secretsReady(deps)) return { kind: 'unavailable' };

  const targetDigest = digestEmailTarget(deps.hmacSecret, email);
  const now = deps.now?.() ?? Date.now();
  const expiresAt = new Date(now + OTP_CHALLENGE_TTL_SECONDS * 1000);

  if (deps.mailer) {
    const code = generateOtpCode();
    const delivery = await deps.mailer.sendLoginCode({
      challengeId: randomUUID(),
      to: email,
      code,
    });
    if (delivery === 'transient_failure' || delivery === 'configuration_failure') {
      return { kind: 'unavailable' };
    }
    // 永久拒绝返回与受理一致的统一结果，不暴露邮箱可达性，也不回退明文。
    if (delivery === 'permanent_rejection') {
      return { kind: 'accepted', expiresInSeconds: OTP_CHALLENGE_TTL_SECONDS };
    }
    await deps.store.replaceChallenge({
      targetDigest,
      codeDigest: digestEmailCode(deps.hmacSecret, targetDigest, code),
      expiresAt,
    });
    return { kind: 'accepted', expiresInSeconds: OTP_CHALLENGE_TTL_SECONDS };
  }

  if (!deps.devOtpCode || !OTP_CODE_PATTERN.test(deps.devOtpCode)) {
    return { kind: 'unavailable' };
  }
  await deps.store.replaceChallenge({
    targetDigest,
    codeDigest: digestEmailCode(deps.hmacSecret, targetDigest, deps.devOtpCode),
    expiresAt,
  });
  return { kind: 'accepted', expiresInSeconds: OTP_CHALLENGE_TTL_SECONDS };
}

export type VerifyOtpResult =
  | { kind: 'ok'; userId: string; sessionCookie: string; expiresInSeconds: number }
  | { kind: 'invalid_input' }
  | { kind: 'invalid_code' }
  | { kind: 'unavailable' };

/**
 * 校验 OTP；首次登录自动建用户与邮箱身份，随后签发不透明会话 Cookie。
 * 万能码（验证期旁路）：配了发信通道时挑战存的是随机码摘要，输入等于万能码
 * 直接放行、不消耗挑战；未配发信通道时挑战本来就是万能码摘要，走常规消费
 * （TTL 与次数限制照常生效）。
 */
export async function verifyOtp(
  deps: AuthzServiceDependencies,
  input: { email: string; code: string },
): Promise<VerifyOtpResult> {
  const email = normalizeEmail(input.email);
  if (!email || !OTP_CODE_PATTERN.test(input.code)) return { kind: 'invalid_input' };
  if (!secretsReady(deps)) return { kind: 'unavailable' };

  const targetDigest = digestEmailTarget(deps.hmacSecret, email);
  const devBypass = deps.mailer !== undefined && deps.devOtpCode === input.code;
  const consumed =
    devBypass ||
    (await deps.store.consumeChallenge({
      targetDigest,
      candidateCodeDigest: digestEmailCode(deps.hmacSecret, targetDigest, input.code),
    }));
  if (!consumed) return { kind: 'invalid_code' };

  const userId = await deps.store.findOrCreateEmailUser(email);
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
