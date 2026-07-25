// 登录域 handler：真实 Logto OIDC 登录流 + cb_session 会话层。
//   GET  /auth/login    → 302 跳 Logto 授权端点（PKCE S256 + state + nonce，落短时 auth_tx cookie）。
//   GET  /auth/callback → 校 state、code 换 token、验 id_token（aud=LOGTO_APP_ID + nonce）、
//                         验 access_token（aud=LOGTO_AUDIENCE）、首登 provision、种 cb_session、302 回站内。
//   POST /auth/refresh  → 用独立 HttpOnly refresh cookie 续期并旋转两个 Cookie。
//   POST /auth/logout   → 清 cb_session + cb_refresh（+ 可选 Logto end_session URL），200 幂等。
//   GET  /me            → requireAuth：读 MeView。
//
// 会话模型（cb_session）：HttpOnly + Secure(prod) + SameSite=Lax Cookie，承载 Logto access_token（JWT）。
//   requireAuth / requireSseAuth 从 cb_session 取出该 JWT 走同一套 verifyLogtoJwt → provision →
//   AuthContext，故 callback 种的会话能被后续受保护端点直接识别（无需独立会话存储）。
//
// 失败口径：callback 失败一律 302 回 /login?failureId=<opaque>（随机短串，不带内部 code / OIDC
//   原始报错）；服务端把 failureId → 内部 code + traceId 落日志。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  API_PREFIX,
  ErrorCode,
  RoleSchema,
  type Envelope,
  type ErrorCodeValue,
  type LogoutResult,
  type MeView,
  type Role,
} from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import { provisionUser, readMe, type MeRow } from './repo.js';
import { verifyLogtoIdToken, verifyLogtoJwt } from '../../platform/infra/logto.js';
import {
  DEFAULT_DEV_USER,
  DEV_SESSION_MAX_AGE,
  devLoginAvailable,
  signDevSession,
} from '../../platform/infra/dev-session.js';
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  exchangeCodeForToken,
  pkceChallengeS256,
  randomToken,
  readNonceFromIdToken,
  refreshAccessToken,
  sanitizeReturnTo,
  type AuthTx,
} from '../../platform/infra/logto-oidc.js';
import { SESSION_COOKIE } from '../../platform/middleware/auth.js';

/** 短时登录事务 Cookie 名（HttpOnly，TTL ≤10min，存 state/nonce/code_verifier/returnTo）。 */
export const AUTH_TX_COOKIE = 'cb_auth_tx';

/** 长会话凭据：只在 /api/v1/auth 下发送，永不暴露给 JavaScript。 */
export const REFRESH_COOKIE = 'cb_refresh';

const AUTH_TX_MAX_AGE = 600;

/** cb_session cookie TTL（秒）：会话 Cookie 承载 access_token，给到 8h（token 自带 exp，过期由验签拦）。 */
const SESSION_MAX_AGE = 8 * 60 * 60;

/** refresh cookie 的本地上限；上游 refresh token 的实际过期/撤销仍是最终权威。 */
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

/** 登录失败重定向落点（/login?failureId=<opaque>）。 */
const LOGIN_PATH = '/login';

function isProd(req: FastifyRequest): boolean {
  return req.server.infra.env.NODE_ENV === 'production';
}

function cookieOpts(req: FastifyRequest, maxAge?: number) {
  return {
    httpOnly: true,
    secure: isProd(req),
    sameSite: 'lax' as const,
    path: '/',
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}

/** refresh token 仅需发给 callback/refresh/logout，缩小 Cookie 暴露面。 */
function refreshCookieOpts(req: FastifyRequest, maxAge?: number) {
  return {
    ...cookieOpts(req, maxAge),
    path: `${API_PREFIX}/auth`,
  };
}

function clearSessionCookies(req: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, cookieOpts(req));
  reply.clearCookie(REFRESH_COOKIE, refreshCookieOpts(req));
}

/** 读 auth_tx（回调比对 state/nonce + 取 code_verifier/returnTo）；缺失/畸形 → null。 */
function readAuthTx(req: FastifyRequest): AuthTx | null {
  const raw = req.cookies?.[AUTH_TX_COOKIE];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AuthTx>;
    if (
      typeof parsed.state === 'string' &&
      typeof parsed.nonce === 'string' &&
      typeof parsed.codeVerifier === 'string' &&
      typeof parsed.returnTo === 'string'
    ) {
      return {
        state: parsed.state,
        nonce: parsed.nonce,
        codeVerifier: parsed.codeVerifier,
        // Cookie 也按不可信输入处理，避免手工伪造或旧版本事务绕过当前回跳规则。
        returnTo: sanitizeReturnTo(parsed.returnTo),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 失败重定向：302 回 /login?failureId=<opaque>。failureId 是随机短串（不含内部 code）；
 * 内部 code + traceId 落日志（经 traceId 关联排障）；清 auth_tx（事务已终结）。
 */
function redirectFailure(
  req: FastifyRequest,
  reply: FastifyReply,
  internalCode: ErrorCodeValue,
): FastifyReply {
  const failureId = randomToken(12);
  req.log.warn(
    { code: internalCode, traceId: req.id, failureId },
    'auth callback failed (opaque failureId to client)',
  );
  reply.clearCookie(AUTH_TX_COOKIE, cookieOpts(req));
  reply.redirect(`${LOGIN_PATH}?failureId=${encodeURIComponent(failureId)}`, 302);
  return reply;
}

function toMeView(row: MeRow): MeView {
  return {
    id: row.id,
    account: row.account,
    email: row.email,
    roles: row.roles,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
  };
}

// ===========================================================================
// GET /auth/login — 发起登录（302 跳 Logto）
// ===========================================================================

/**
 * 发起登录：生成 state/nonce/PKCE，落短时 auth_tx cookie，302 到 Logto 授权端点。
 *   returnTo 经白名单（仅站内相对路径，防 open redirect）；discovery 不可达 → 302 回登录页
 *   （不裸返 JSON 错、不暴露内部错）。
 */
export function loginHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const env = req.server.infra.env;
    const q = req.query as { returnTo?: string; prompt?: string };
    const returnTo = sanitizeReturnTo(q.returnTo);

    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken();
    const codeChallenge = pkceChallengeS256(codeVerifier);

    const authorizeUrl = await buildAuthorizeUrl({
      env,
      state,
      nonce,
      codeChallenge,
      ...(q.prompt ? { prompt: q.prompt } : {}),
    });
    if (!authorizeUrl) {
      req.log.warn(
        { code: ErrorCode.AUTH_UPSTREAM_UNAVAILABLE, traceId: req.id },
        'auth login: discovery unreachable',
      );
      reply.redirect(LOGIN_PATH, 302);
      return reply;
    }

    const tx: AuthTx = { state, nonce, codeVerifier, returnTo };
    reply.setCookie(AUTH_TX_COOKIE, JSON.stringify(tx), cookieOpts(req, AUTH_TX_MAX_AGE));
    reply.redirect(authorizeUrl, 302);
    return reply;
  };
}

// ===========================================================================
// GET /auth/callback — OIDC 回调换会话（302 回站内）
// ===========================================================================

/**
 * 回调换会话：校 state → code 换 token → 验 id_token(nonce) → 首登 provision → 种 cb_session
 * → 302 回 returnTo。失败一律 302 回 /login?failureId=<opaque>。
 */
export function callbackHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const env = req.server.infra.env;
    const q = req.query as { code?: string; state?: string; error?: string };

    // 1) Logto 侧错误（用户取消授权等）：不透传 OIDC 原始 error。
    if (q.error) return redirectFailure(req, reply, ErrorCode.AUTH_CONSENT_DENIED);

    const tx = readAuthTx(req);
    // 2) state 校验（CSRF）：auth_tx 缺失/过期 或 state 不匹配。
    if (!tx || !q.state || q.state !== tx.state || !q.code) {
      return redirectFailure(req, reply, ErrorCode.AUTH_STATE_MISMATCH);
    }

    // 3) code + code_verifier 换 token。
    const exchanged = await exchangeCodeForToken(env, q.code, tx.codeVerifier);
    if (exchanged.kind === 'upstream_unavailable') {
      return redirectFailure(req, reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE);
    }
    if (exchanged.kind === 'failed') {
      return redirectFailure(req, reply, ErrorCode.AUTH_CALLBACK_FAILED);
    }

    // 4) 验 id_token（若有）：id_token 的 aud 是 client_id（LOGTO_APP_ID），与 access_token 的
    //    aud（API resource）职责分开——必须用 verifyLogtoIdToken；nonce 与 auth_tx 比对。
    if (exchanged.idToken) {
      const idVerify = await verifyLogtoIdToken(exchanged.idToken, env);
      if (idVerify.kind === 'upstream_unavailable') {
        return redirectFailure(req, reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE);
      }
      if (idVerify.kind === 'invalid') {
        return redirectFailure(req, reply, ErrorCode.AUTH_CALLBACK_FAILED);
      }
      if (readNonceFromIdToken(exchanged.idToken) !== tx.nonce) {
        return redirectFailure(req, reply, ErrorCode.AUTH_CALLBACK_FAILED);
      }
    }

    // 5) 用 access_token 验签取身份（与受保护路由中间件同一套验签，保证种进 cookie 的 token 后续能被认）。
    const accessVerify = await verifyLogtoJwt(exchanged.accessToken, env);
    if (accessVerify.kind === 'upstream_unavailable') {
      return redirectFailure(req, reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE);
    }
    if (accessVerify.kind === 'invalid') {
      return redirectFailure(req, reply, ErrorCode.AUTH_CALLBACK_FAILED);
    }

    // 6) 首登 upsert provision（按 logto_user_id=sub 查/建 users）。
    try {
      await provisionUser(req.server.infra.db, {
        logtoUserId: accessVerify.token.sub,
        account: accessVerify.token.account,
        email: accessVerify.token.email,
        roles: accessVerify.token.roles,
      });
    } catch {
      return redirectFailure(req, reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE);
    }

    // 7) 种 cb_session + 独立 cb_refresh，清 auth_tx，302 回站内 returnTo。
    reply.setCookie(SESSION_COOKIE, exchanged.accessToken, cookieOpts(req, SESSION_MAX_AGE));
    // 新一轮登录不得沿用上一身份的旧 refresh token；本次未签发则显式清掉。
    if (exchanged.refreshToken) {
      reply.setCookie(
        REFRESH_COOKIE,
        exchanged.refreshToken,
        refreshCookieOpts(req, REFRESH_MAX_AGE),
      );
    } else {
      reply.clearCookie(REFRESH_COOKIE, refreshCookieOpts(req));
    }
    reply.clearCookie(AUTH_TX_COOKIE, cookieOpts(req));
    reply.redirect(tx.returnTo, 302);
    return reply;
  };
}

// ===========================================================================
// POST /auth/refresh — 用 refresh cookie 续期（204）
// ===========================================================================

/**
 * 续期失败的统一收口：不在 refresh 失败响应里清 Cookie。
 * 原因是多 tab 可能并发携带同一旧 RT：先到请求已旋转成新 RT 后，晚到的 invalid_grant
 * 若再 Set-Cookie 清理，会把浏览器刚收到的有效新 Cookie 一并覆盖。失效凭据由显式
 * logout 或下一次成功 login 覆盖；对外始终只返安全错误信封。
 */
function failRefresh(req: FastifyRequest, reply: FastifyReply, code: ErrorCodeValue): FastifyReply {
  req.log.warn({ code, traceId: req.id }, 'auth refresh failed');
  return sendError(req, reply, code);
}

/**
 * access token 过期时本端点仍必须可调，因此不挂 requireAuth，
 * 只接受 SameSite + HttpOnly refresh cookie。新 access token 验签/验 aud 成功后才写 Cookie；
 * Logto 返回旋转后 refresh token 则覆盖旧值，未返则安全保留旧值。
 */
export function refreshHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!refreshToken) return failRefresh(req, reply, ErrorCode.UNAUTHENTICATED);

    const refreshed = await refreshAccessToken(req.server.infra.env, refreshToken);
    if (refreshed.kind === 'upstream_unavailable') {
      return failRefresh(req, reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE);
    }
    if (refreshed.kind === 'invalid_grant') {
      return failRefresh(req, reply, ErrorCode.UNAUTHENTICATED);
    }

    // 在任何 Cookie 旋转之前验新 access token（iss/aud/exp/JWKS）。
    const verified = await verifyLogtoJwt(refreshed.accessToken, req.server.infra.env);
    if (verified.kind === 'upstream_unavailable') {
      // token endpoint 可能已作废旧 refresh token。即便 JWKS 短时不可达，
      // 也必须先保存上游旋转后的新值，否则下次重试将永久失败。
      // 但绝不写入未验签的 access token。
      if (refreshed.refreshToken) {
        reply.setCookie(
          REFRESH_COOKIE,
          refreshed.refreshToken,
          refreshCookieOpts(req, REFRESH_MAX_AGE),
        );
      }
      return failRefresh(req, reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE);
    }
    if (verified.kind === 'invalid') {
      // 上游已接受 RT 时，invalid 也可能是新 kid 在 JOSE cooldown 窗口内尚未刷新。
      // 保留旋转后 RT、不写未验 access，返 503 给客户端重试，避免不可逆掉线。
      if (refreshed.refreshToken) {
        reply.setCookie(
          REFRESH_COOKIE,
          refreshed.refreshToken,
          refreshCookieOpts(req, REFRESH_MAX_AGE),
        );
      }
      return failRefresh(req, reply, ErrorCode.AUTH_UPSTREAM_UNAVAILABLE);
    }

    const nextRefreshToken = refreshed.refreshToken ?? refreshToken;
    reply.setCookie(SESSION_COOKIE, refreshed.accessToken, cookieOpts(req, SESSION_MAX_AGE));
    reply.setCookie(REFRESH_COOKIE, nextRefreshToken, refreshCookieOpts(req, REFRESH_MAX_AGE));
    reply.code(204).send();
    return reply;
  };
}

// ===========================================================================
// POST /auth/logout — 登出（200 幂等）
// ===========================================================================

/** 登出：清 cb_session（+ 可选 Logto end_session URL）。未登录调用同样 200（幂等，不报 401）。 */
export function logoutHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const env = req.server.infra.env;
    clearSessionCookies(req, reply);
    // 兜带清残留 auth_tx（防中断的登录事务遗留）。
    reply.clearCookie(AUTH_TX_COOKIE, cookieOpts(req));

    const logoutUrl = await buildLogoutUrl(env);
    const result: LogoutResult = logoutUrl ? { loggedOut: true, logoutUrl } : { loggedOut: true };
    const body: Envelope<LogoutResult> = { data: result, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// GET /me — 当前登录用户（requireAuth）
// ===========================================================================

export function meHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);

    let row: MeRow | null;
    try {
      row = await readMe(req.server.infra.db, userId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'me: readMe failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    // 找不到（理论不可达，requireAuth 已 provision）→ 当作登录态失效让前端重登。
    if (!row) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);

    const body: Envelope<MeView> = { data: toMeView(row), meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

// ===========================================================================
// POST /auth/dev-login — 仅 dev/test 种子登录（live 测试拿有效会话跑主链路）
// ===========================================================================

/** dev-login 请求体（全可选）：指定测试用户；缺省 = seeded 测试创作者。 */
interface DevLoginBody {
  email?: string;
  account?: string;
  role?: string;
  roles?: string[];
}

/** 解析 dev-login body 的角色（RoleSchema 过滤；全空回落默认，绝不强转 raw string）。 */
function resolveDevRoles(body: DevLoginBody): Role[] {
  const candidates: string[] = [];
  if (typeof body.role === 'string') candidates.push(body.role);
  if (Array.isArray(body.roles)) {
    for (const r of body.roles) if (typeof r === 'string') candidates.push(r);
  }
  const out: Role[] = [];
  for (const c of candidates) {
    const parsed = RoleSchema.safeParse(c);
    if (parsed.success && !out.includes(parsed.data)) out.push(parsed.data);
  }
  return out.length > 0 ? out : DEFAULT_DEV_USER.roles;
}

/**
 * 仅 dev/test 种子登录（安全双守卫，绝不上生产）：仅当 devLoginAvailable(env) 才工作，
 * 否则当作【不存在】返 404（不暴露端点存在性——routes 也只在可用时注册，此处再兜一层）。
 * provisionUser 建/取 users 行；用 DEV_SESSION_SECRET 签 HS256 dev 会话写 cb_session，返 MeView。
 */
export function devLoginHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const env = req.server.infra.env;
    if (!devLoginAvailable(env)) {
      req.log.warn({ traceId: req.id }, 'dev-login hit while unavailable (guarded)');
      return sendError(req, reply, ErrorCode.NOT_FOUND);
    }

    const body = (req.body ?? {}) as DevLoginBody;
    const email =
      typeof body.email === 'string' && body.email.trim()
        ? body.email.trim()
        : DEFAULT_DEV_USER.email;
    const account =
      typeof body.account === 'string' && body.account.trim()
        ? body.account.trim()
        : DEFAULT_DEV_USER.account;
    const roles = resolveDevRoles(body);
    // 稳定 sub（去重键）：默认用户固定 sub；自定义 email 派生稳定 sub，复登命中同一 users 行。
    const sub =
      email === DEFAULT_DEV_USER.email ? DEFAULT_DEV_USER.sub : `dev|${email.toLowerCase()}`;

    let provisioned;
    try {
      provisioned = await provisionUser(req.server.infra.db, {
        logtoUserId: sub,
        account,
        email,
        roles,
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'dev-login: provisionUser failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }

    // 签 dev 会话（HS256）写 cb_session（与 callback 同 cookie 名/属性）。
    const token = await signDevSession(env, {
      sub,
      roles: provisioned.roles,
      account: provisioned.account,
      email,
    });
    reply.setCookie(SESSION_COOKIE, token, cookieOpts(req, DEV_SESSION_MAX_AGE));
    // dev 会话不能混用浏览器中残留的真实 Logto refresh token。
    reply.clearCookie(REFRESH_COOKIE, refreshCookieOpts(req));

    let row: MeRow | null;
    try {
      row = await readMe(req.server.infra.db, provisioned.id);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'dev-login: readMe failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (!row) return sendError(req, reply, ErrorCode.INTERNAL);

    const resBody: Envelope<MeView> = { data: toMeView(row), meta: { traceId: req.id } };
    reply.code(200).send(resBody);
    return reply;
  };
}
