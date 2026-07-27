import type { NormalizedEmailAddress } from '@cb/shared';
import { describe, expect, it, vi } from 'vitest';
import { verifyEmailChallenge } from '../modules/account/repo.js';
import type { TxConn, TxPool } from '../platform/infra/db-tx.js';

function emptyChallengePool(): {
  pool: TxPool;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const release = vi.fn();
  return {
    pool: {
      async connect() {
        return {
          query: query as unknown as TxConn['query'],
          release,
        };
      },
    },
    query,
    release,
  };
}

describe('email verification PostgreSQL fallback guard', () => {
  it('does not append audit rows for repeated targets without an active challenge', async () => {
    const { pool, query, release } = emptyChallengePool();
    const input = {
      email: 'Absent@example.com' as NormalizedEmailAddress,
      targetDigest: Buffer.alloc(32, 1),
      candidateCodeDigest: Buffer.alloc(32, 2),
      sessionDigest: Buffer.alloc(32, 3),
      currentSessionDigest: null,
      traceId: 'trace-redis-outage',
      accountCandidate: () => 'creator-aaaaaaaa',
    };

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await expect(verifyEmailChallenge(pool, input)).resolves.toEqual({ kind: 'invalid' });
    }

    const sql = query.mock.calls.map(([statement]) => String(statement));
    expect(sql.filter((statement) => statement.includes('FOR UPDATE'))).toHaveLength(25);
    expect(sql.filter((statement) => statement.includes('INSERT INTO auth_audit_events'))).toEqual(
      [],
    );
    expect(release).toHaveBeenCalledTimes(25);
  });
});
