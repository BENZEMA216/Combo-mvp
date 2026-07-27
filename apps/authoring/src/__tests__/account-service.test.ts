import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeView } from '@cb/shared';

const repoMocks = vi.hoisted(() => ({
  insertPendingEmailChallenge: vi.fn(),
  finalizeEmailChallenge: vi.fn(),
  verifyEmailChallenge: vi.fn(),
}));
vi.mock('../modules/account/repo.js', () => repoMocks);

import { requestEmailChallenge, verifyEmail } from '../modules/account/service.js';
import type { AccountAuthDependencies } from '../modules/account/service.js';

const USER: MeView = {
  id: '01900000-0000-7000-8000-000000000001',
  account: 'creator-aaaaaaaa',
  email: 'Alice@example.com',
  roles: ['creator'],
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: '2026-01-01T01:00:00.000Z',
};

function dependencies(): AccountAuthDependencies & {
  mailer: { sendLoginCode: ReturnType<typeof vi.fn> };
  rateLimiter: {
    consumeChallenge: ReturnType<typeof vi.fn>;
    consumeVerification: ReturnType<typeof vi.fn>;
  };
} {
  return {
    db: {} as AccountAuthDependencies['db'],
    hmacSecret: 'h'.repeat(32),
    randomId: () => '01900000-0000-7000-8000-000000000099',
    randomInteger: () => 42,
    randomBytes: (size) => Buffer.alloc(size, 5),
    mailer: { sendLoginCode: vi.fn().mockResolvedValue('accepted') },
    rateLimiter: {
      consumeChallenge: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 1 }),
      consumeVerification: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 1 }),
    },
  };
}

describe('account auth service orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoMocks.insertPendingEmailChallenge.mockResolvedValue({ kind: 'created' });
    repoMocks.finalizeEmailChallenge.mockResolvedValue(undefined);
    repoMocks.verifyEmailChallenge.mockResolvedValue({ kind: 'ok', user: USER });
  });

  it('creates pending state, sends outside the transaction helper and activates only accepted mail', async () => {
    const deps = dependencies();

    await expect(
      requestEmailChallenge(deps, {
        email: 'Alice@Example.COM',
        clientAddress: '192.0.2.4',
        traceId: 'trace-service',
      }),
    ).resolves.toEqual({ kind: 'accepted' });

    expect(repoMocks.insertPendingEmailChallenge).toHaveBeenCalledWith(deps.db, {
      challengeId: '01900000-0000-7000-8000-000000000099',
      targetDigest: expect.any(Buffer),
      codeDigest: expect.any(Buffer),
    });
    expect(deps.mailer.sendLoginCode).toHaveBeenCalledWith({
      challengeId: '01900000-0000-7000-8000-000000000099',
      to: 'Alice@example.com',
      code: '000042',
    });
    expect(repoMocks.finalizeEmailChallenge).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ delivery: 'accepted', traceId: 'trace-service' }),
    );
  });

  it('returns dependency-unavailable when accepted delivery cannot be activated', async () => {
    const deps = dependencies();
    repoMocks.finalizeEmailChallenge.mockRejectedValueOnce(
      new Error('activation transaction failed'),
    );

    await expect(
      requestEmailChallenge(deps, {
        email: 'Alice@example.com',
        clientAddress: '192.0.2.4',
        traceId: 'trace-finalize-failure',
      }),
    ).resolves.toEqual({ kind: 'dependency_unavailable' });
    expect(deps.mailer.sendLoginCode).toHaveBeenCalledTimes(1);
    expect(repoMocks.finalizeEmailChallenge).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ delivery: 'accepted' }),
    );
  });

  it('returns uniform accepted semantics for a permanent provider rejection', async () => {
    const deps = dependencies();
    deps.mailer.sendLoginCode.mockResolvedValue('permanent_rejection');

    const result = await requestEmailChallenge(deps, {
      email: 'Alice@example.com',
      clientAddress: '192.0.2.4',
      traceId: 'trace-service',
    });

    expect(result.kind).toBe('accepted');
    expect(repoMocks.finalizeEmailChallenge).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ delivery: 'permanent_rejection' }),
    );
  });

  it.each(['transient_failure', 'configuration_failure'] as const)(
    'invalidates pending state and returns 503 semantics for %s',
    async (delivery) => {
      const deps = dependencies();
      deps.mailer.sendLoginCode.mockResolvedValue(delivery);

      await expect(
        requestEmailChallenge(deps, {
          email: 'Alice@example.com',
          clientAddress: '192.0.2.4',
          traceId: 'trace-service',
        }),
      ).resolves.toEqual({ kind: 'dependency_unavailable' });
      expect(repoMocks.finalizeEmailChallenge).toHaveBeenCalledWith(
        deps.db,
        expect.objectContaining({ delivery }),
      );
    },
  );

  it('classifies an unexpected mail-port rejection without leaving pending state active', async () => {
    const deps = dependencies();
    deps.mailer.sendLoginCode.mockRejectedValue(new Error('network internals'));

    await expect(
      requestEmailChallenge(deps, {
        email: 'Alice@example.com',
        clientAddress: '192.0.2.4',
        traceId: 'trace-service',
      }),
    ).resolves.toEqual({ kind: 'dependency_unavailable' });
    expect(repoMocks.finalizeEmailChallenge).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ delivery: 'transient_failure' }),
    );
  });

  it('fails a new challenge closed when Redis is unavailable', async () => {
    const deps = dependencies();
    deps.rateLimiter.consumeChallenge.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      requestEmailChallenge(deps, {
        email: 'Alice@example.com',
        clientAddress: '192.0.2.4',
        traceId: 'trace-service',
      }),
    ).resolves.toEqual({ kind: 'dependency_unavailable' });
    expect(repoMocks.insertPendingEmailChallenge).not.toHaveBeenCalled();
    expect(deps.mailer.sendLoginCode).not.toHaveBeenCalled();
  });

  it('does not send when the PostgreSQL target budget returns Retry-After', async () => {
    const deps = dependencies();
    repoMocks.insertPendingEmailChallenge.mockResolvedValue({
      kind: 'rate_limited',
      retryAfterSeconds: 53,
    });

    await expect(
      requestEmailChallenge(deps, {
        email: 'Alice@example.com',
        clientAddress: '192.0.2.4',
        traceId: 'trace-service',
      }),
    ).resolves.toEqual({ kind: 'rate_limited', retryAfterSeconds: 53 });
    expect(deps.mailer.sendLoginCode).not.toHaveBeenCalled();
  });

  it('continues verification through a Redis outage and returns a fixed opaque session', async () => {
    const deps = dependencies();
    deps.rateLimiter.consumeVerification.mockRejectedValue(new Error('redis unavailable'));

    const result = await verifyEmail(deps, {
      email: 'Alice@example.com',
      code: '042731',
      returnTo: '/tasks',
      clientAddress: '192.0.2.4',
      traceId: 'trace-service',
      currentSessionCookie: `s1.${Buffer.alloc(32, 9).toString('base64url')}`,
    });

    expect(result).toEqual({
      kind: 'ok',
      user: USER,
      sessionCookie: `s1.${Buffer.alloc(32, 5).toString('base64url')}`,
      returnTo: '/tasks',
    });
    expect(repoMocks.verifyEmailChallenge).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({
        email: 'Alice@example.com',
        targetDigest: expect.any(Buffer),
        candidateCodeDigest: expect.any(Buffer),
        sessionDigest: expect.any(Buffer),
        currentSessionDigest: expect.any(Buffer),
      }),
    );
  });

  it.each([
    [{ kind: 'invalid' }, { kind: 'invalid_code' }],
    [{ kind: 'disabled' }, { kind: 'account_disabled' }],
  ] as const)(
    'maps repository verification result without leaking its cause',
    async (repoResult, expected) => {
      const deps = dependencies();
      repoMocks.verifyEmailChallenge.mockResolvedValue(repoResult);
      await expect(
        verifyEmail(deps, {
          email: 'Alice@example.com',
          code: '111111',
          returnTo: '/tasks',
          clientAddress: '192.0.2.4',
          traceId: 'trace-service',
        }),
      ).resolves.toEqual(expected);
    },
  );
});
