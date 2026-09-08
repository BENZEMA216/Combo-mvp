import { describe, expect, it } from 'vitest';
import {
  AUTH_DEFAULT_RETURN_TO,
  AUTH_SESSION_COOKIE_HTTP_ONLY,
  AUTH_SESSION_COOKIE_MAX_AGE_SECONDS,
  AUTH_SESSION_COOKIE_NAME,
  AUTH_SESSION_COOKIE_PATH,
  AUTH_SESSION_COOKIE_PRODUCTION_NAME,
  AUTH_SESSION_COOKIE_SAME_SITE,
  AUTH_SESSION_TTL_SECONDS,
  AuthSessionCookieValueSchema,
  DependencyNameSchema,
  EmailChallengeBodySchema,
  EmailChallengeResponseSchema,
  EmailOtpCodeSchema,
  EmailVerificationBodySchema,
  EmailVerificationResponseSchema,
  ERROR_CLASSIFICATION,
  ErrorCode,
  LogoutBodySchema,
  LogoutResultSchema,
  MeViewSchema,
  NormalizedEmailAddressSchema,
  REQUIRED_DEPENDENCIES,
  authSessionCookieName,
  errorBodyFor,
  sanitizeAuthReturnTo,
} from '../index.js';

const me = {
  id: '01900000-0000-7000-8000-000000000001',
  account: 'creator-k7m4p2qx',
  email: 'Alice@example.com',
  roles: ['creator'],
  createdAt: '2026-01-01T08:00:00.000Z',
  lastLoginAt: '2026-01-01T09:00:00.000Z',
};

describe('邮箱验证码请求契约', () => {
  it('challenge 只接受一个未裁剪的邮箱字段', () => {
    expect(EmailChallengeBodySchema.parse({ email: 'Alice@example.com' })).toEqual({
      email: 'Alice@example.com',
    });
    expect(EmailChallengeBodySchema.safeParse({ email: ' Alice@example.com' }).success).toBe(false);
    expect(EmailChallengeBodySchema.safeParse({ email: 'a\u0000@example.com' }).success).toBe(
      false,
    );
    expect(EmailChallengeBodySchema.safeParse({ email: 'a@@example.com' }).success).toBe(false);
    expect(
      EmailChallengeBodySchema.safeParse({ email: 'a@example.com', provider: 'email' }).success,
    ).toBe(false);
  });

  it('verification 保留六位码的前导零并拒绝额外字段', () => {
    expect(EmailOtpCodeSchema.parse('004271')).toBe('004271');
    expect(EmailOtpCodeSchema.safeParse('4271').success).toBe(false);
    expect(EmailOtpCodeSchema.safeParse('12a456').success).toBe(false);

    const parsed = EmailVerificationBodySchema.parse({
      email: 'Alice@example.com',
      code: '004271',
    });
    expect(parsed).toEqual({
      email: 'Alice@example.com',
      code: '004271',
      returnTo: AUTH_DEFAULT_RETURN_TO,
    });
    expect(
      EmailVerificationBodySchema.safeParse({
        email: 'Alice@example.com',
        code: '004271',
        remember: true,
      }).success,
    ).toBe(false);
  });
});

describe('认证 returnTo 白名单', () => {
  const transferPath = '/agent-transfers/11111111-1111-4111-8111-111111111111';
  it('保留精确的小写 UUIDv4 Agent transfer 登录回跳', () => {
    expect(sanitizeAuthReturnTo(transferPath)).toBe(transferPath);
    expect(
      EmailVerificationBodySchema.parse({
        email: 'Alice@example.com',
        code: '123456',
        returnTo: transferPath,
      }).returnTo,
    ).toBe(transferPath);
  });
  it.each([
    `${transferPath}?secret=x`,
    `${transferPath}#confirm`,
    `${transferPath}/`,
    '/agent-transfers/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    '/agent-transfers/11111111-1111-7111-8111-111111111111',
    '/agent-transfers/11111111-1111-4111-1111-111111111111',
    '/agent-transfers/not-an-id',
    '/agent-transfers',
    '/agent-transfers/%31' + transferPath.slice('/agent-transfers/1'.length),
    `/tasks/..${transferPath}`,
    `/unused/..${transferPath}`,
    `https://evil.example${transferPath}`,
    `/${transferPath}`,
  ])('Agent transfer 回跳拒绝非规范变体 %s', (value) => {
    expect(sanitizeAuthReturnTo(value)).toBe(AUTH_DEFAULT_RETURN_TO);
  });
  it.each([
    ['/tasks', '/tasks'],
    ['/tasks/task-1?tab=events', '/tasks/task-1?tab=events'],
    ['/capabilities', '/capabilities'],
    [
      '/capabilities/01982e62-6d6e-7f4d-8fe8-b55f62720b5b/release/review?from=studio',
      '/capabilities/01982e62-6d6e-7f4d-8fe8-b55f62720b5b/release/review?from=studio',
    ],
    ['/try', '/try'],
    ['/try/capability-1#preview', '/try/capability-1#preview'],
  ])('保留允许的站内目标 %s', (input, expected) => {
    expect(sanitizeAuthReturnTo(input)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'tasks',
    'https://evil.example/tasks',
    '//evil.example/tasks',
    '/tasks//evil',
    '/tasks\\evil',
    '/tasks/%2Fevil',
    '/tasks/%5cevil',
    '/tasks/%00evil',
    '/tasks/%2e%2e/admin',
    '/admin',
    '/capabilities/private',
    '/capabilities/not-an-id/release/pricing',
    '/capabilities/01982e62-6d6e-7f4d-8fe8-b55f62720b5b/release/admin',
    `/tasks/${'a'.repeat(512)}`,
    '/tasks\nnext',
  ])('把不可信目标统一回落到 /tasks', (input) => {
    expect(sanitizeAuthReturnTo(input)).toBe(AUTH_DEFAULT_RETURN_TO);
  });

  it('verification schema 在解析时净化字符串 returnTo，但拒绝非字符串', () => {
    expect(
      EmailVerificationBodySchema.parse({
        email: 'Alice@example.com',
        code: '123456',
        returnTo: 'https://evil.example',
      }).returnTo,
    ).toBe('/tasks');
    expect(
      EmailVerificationBodySchema.safeParse({
        email: 'Alice@example.com',
        code: '123456',
        returnTo: 42,
      }).success,
    ).toBe(false);
  });
});

describe('第一方会话与响应契约', () => {
  it('固定生产 __Host- 与本地 HTTP Cookie 策略、根路径、期限和格式', () => {
    expect(AUTH_SESSION_COOKIE_NAME).toBe('cb_session');
    expect(AUTH_SESSION_COOKIE_PRODUCTION_NAME).toBe('__Host-cb_session');
    expect(authSessionCookieName(true)).toBe('__Host-cb_session');
    expect(authSessionCookieName(false)).toBe('cb_session');
    expect(AUTH_SESSION_COOKIE_PATH).toBe('/');
    expect(AUTH_SESSION_TTL_SECONDS).toBe(604_800);
    expect(AUTH_SESSION_COOKIE_MAX_AGE_SECONDS).toBe(604_800);
    expect(AUTH_SESSION_COOKIE_HTTP_ONLY).toBe(true);
    expect(AUTH_SESSION_COOKIE_SAME_SITE).toBe('lax');
    expect(AuthSessionCookieValueSchema.safeParse(`s1.${'A'.repeat(43)}`).success).toBe(true);
    expect(AuthSessionCookieValueSchema.safeParse(`s1.${'A'.repeat(42)}`).success).toBe(false);
    expect(AuthSessionCookieValueSchema.safeParse(`s1.${'A'.repeat(42)}+`).success).toBe(false);
  });

  it('MeView 的邮箱必填且必须使用小写 ASCII 域名', () => {
    expect(MeViewSchema.safeParse(me).success).toBe(true);
    expect(NormalizedEmailAddressSchema.safeParse('Alice@xn--fsqu00a.xn--0zwm56d').success).toBe(
      true,
    );
    expect(MeViewSchema.safeParse({ ...me, email: null }).success).toBe(false);
    expect(MeViewSchema.safeParse({ ...me, email: 'Alice@Example.com' }).success).toBe(false);
    expect(MeViewSchema.safeParse({ ...me, account: 'creator-old-format' }).success).toBe(false);
    expect(MeViewSchema.safeParse({ ...me, roles: [] }).success).toBe(false);
  });

  it('登出请求只能是空对象，响应解码会忽略未来新增字段', () => {
    expect(LogoutBodySchema.safeParse({}).success).toBe(true);
    expect(LogoutBodySchema.safeParse({ allSessions: true }).success).toBe(false);
    expect(LogoutResultSchema.safeParse({ loggedOut: true }).success).toBe(true);
    expect(LogoutResultSchema.parse({ loggedOut: true, futureLogoutHint: 'ignored' })).toEqual({
      loggedOut: true,
    });
  });

  it('认证成功包络强制 traceId，并在每层忽略可选新增字段', () => {
    expect(
      EmailChallengeResponseSchema.parse({
        data: {
          accepted: true,
          expiresInSeconds: 300,
          resendAfterSeconds: 60,
          deliveryHint: 'future-field',
        },
        meta: { traceId: 'trace-1', serverRegion: 'future-region' },
        links: { help: '/help' },
      }),
    ).toEqual({
      data: { accepted: true, expiresInSeconds: 300, resendAfterSeconds: 60 },
      meta: { traceId: 'trace-1' },
    });
    expect(
      EmailChallengeResponseSchema.safeParse({
        data: { accepted: true, expiresInSeconds: 300, resendAfterSeconds: 60 },
      }).success,
    ).toBe(false);
    expect(
      EmailVerificationResponseSchema.parse({
        data: {
          user: { ...me, avatarUrl: 'https://example.test/avatar' },
          returnTo: '/tasks/task-1',
          onboarding: 'future-field',
        },
        meta: { traceId: 'trace-2', requestVersion: 2 },
      }),
    ).toEqual({
      data: { user: me, returnTo: '/tasks/task-1' },
      meta: { traceId: 'trace-2' },
    });
  });
});

describe('认证安全错误与健康依赖', () => {
  it('验证码失败和停用账号使用固定状态与文案，但不暴露任何错误码', () => {
    expect(ERROR_CLASSIFICATION[ErrorCode.AUTH_OTP_INVALID]).toMatchObject({
      http: 401,
      retriable: false,
      action: 'change_input',
      userMessageTemplate: '验证码无效或已过期，请重新获取。',
    });
    expect(ERROR_CLASSIFICATION[ErrorCode.AUTH_ACCOUNT_DISABLED]).toMatchObject({
      http: 403,
      retriable: false,
      action: 'escalate',
    });

    const otpError = errorBodyFor(ErrorCode.AUTH_OTP_INVALID, 'trace-otp');
    const disabledError = errorBodyFor(ErrorCode.AUTH_ACCOUNT_DISABLED, 'trace-disabled');
    expect(otpError.http).toBe(401);
    expect(disabledError.http).toBe(403);
    expect(otpError.body.userMessage).toBe('验证码无效或已过期，请重新获取。');
    expect(JSON.stringify(otpError.body)).not.toContain('AUTH_OTP_INVALID');
    expect(JSON.stringify(disabledError.body)).not.toContain('AUTH_ACCOUNT_DISABLED');
    expect(otpError.body).not.toHaveProperty('code');
    expect(disabledError.body).not.toHaveProperty('code');
  });

  it('readiness 不再依赖外部身份或邮件供应商', () => {
    expect(REQUIRED_DEPENDENCIES).toEqual(['db', 'redis_queue', 'redis_hot', 'minio']);
    expect(DependencyNameSchema.safeParse('external_auth').success).toBe(false);
    expect(DependencyNameSchema.safeParse('resend').success).toBe(false);
  });
});
