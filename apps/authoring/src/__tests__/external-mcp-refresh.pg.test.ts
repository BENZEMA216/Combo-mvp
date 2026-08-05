import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rotateRefreshToken } from '../modules/external-mcp/repo.js';

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.MCP_OAUTH_PG_TEST === '1' && Boolean(databaseUrl);
const pgDescribe = enabled ? describe : describe.skip;
const RESOURCE = 'https://test.example/api/external-mcp/mcp';

function randomAccount(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `creator-${[...randomBytes(8)].map((byte) => alphabet[byte % alphabet.length]).join('')}`;
}

function digest(): Buffer {
  return randomBytes(32);
}

pgDescribe('external MCP refresh-family PostgreSQL serialization', () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const owners: string[] = [];
  const clients: string[] = [];
  const families: string[] = [];

  beforeAll(async () => {
    await pool.query('SELECT 1');
  });

  afterAll(async () => {
    for (const familyId of families) {
      await pool.query('DELETE FROM oauth_access_tokens WHERE family_id = $1', [familyId]);
      await pool.query('DELETE FROM oauth_refresh_tokens WHERE family_id = $1', [familyId]);
    }
    for (const clientId of clients) {
      await pool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId]);
    }
    for (const ownerId of owners) {
      await pool.query('DELETE FROM users WHERE id = $1', [ownerId]);
    }
    await pool.end();
  });

  async function seedFamily(options: { parentUsed: boolean; child: boolean }) {
    const owner = await pool.query<{ id: string }>(
      `INSERT INTO users (account) VALUES ($1) RETURNING id`,
      [randomAccount()],
    );
    const ownerId = owner.rows[0]!.id;
    owners.push(ownerId);
    const clientId = `mcp_client_${randomBytes(32).toString('base64url')}`;
    clients.push(clientId);
    await pool.query(
      `INSERT INTO oauth_clients
         (client_id, registration_digest, client_name, redirect_uris, grant_types, response_types,
          token_endpoint_auth_method)
       VALUES ($1, $2, 'Codex PG concurrency', ARRAY['http://127.0.0.1:49152/callback/codex-id'],
               ARRAY['authorization_code', 'refresh_token'], ARRAY['code'], 'none')`,
      [clientId, digest()],
    );
    const familyId = randomUUID();
    families.push(familyId);
    const parentDigest = digest();
    await pool.query(
      `INSERT INTO oauth_refresh_tokens
         (token_digest, client_id, owner_user_id, family_id, parent_digest, scope,
          resource_uri, expires_at, used_at)
       VALUES ($1, $2, $3, $4, NULL, 'combo.agent:read combo.agent:write', $5,
               now() + interval '1 hour', CASE WHEN $6 THEN now() ELSE NULL END)`,
      [parentDigest, clientId, ownerId, familyId, RESOURCE, options.parentUsed],
    );
    let childDigest: Buffer | null = null;
    if (options.child) {
      childDigest = digest();
      await pool.query(
        `INSERT INTO oauth_refresh_tokens
           (token_digest, client_id, owner_user_id, family_id, parent_digest, scope,
            resource_uri, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'combo.agent:read combo.agent:write', $6,
                 now() + interval '1 hour')`,
        [childDigest, clientId, ownerId, familyId, parentDigest, RESOURCE],
      );
    }
    return { clientId, familyId, parentDigest, childDigest };
  }

  function rotateInput(clientId: string, refreshTokenDigest: Buffer) {
    return {
      refreshTokenDigest,
      clientId,
      resourceUri: RESOURCE,
      nextAccessTokenDigest: digest(),
      nextRefreshTokenDigest: digest(),
      accessTokenTtlSeconds: 3_600,
      refreshTokenTtlSeconds: 30 * 86_400,
    };
  }

  async function expectNoLiveFamilyTokens(familyId: string): Promise<void> {
    const active = await pool.query<{ refresh_count: number; access_count: number }>(
      `SELECT
         (SELECT count(*)::int FROM oauth_refresh_tokens
           WHERE family_id = $1 AND revoked_at IS NULL AND expires_at > now()) AS refresh_count,
         (SELECT count(*)::int FROM oauth_access_tokens
           WHERE family_id = $1 AND revoked_at IS NULL AND expires_at > now()) AS access_count`,
      [familyId],
    );
    expect(active.rows[0]).toEqual({ refresh_count: 0, access_count: 0 });
  }

  it('serializes concurrent use of the same refresh generation and revokes the family on replay', async () => {
    const seeded = await seedFamily({ parentUsed: false, child: false });
    const outcomes = await Promise.all([
      rotateRefreshToken(pool, rotateInput(seeded.clientId, seeded.parentDigest)),
      rotateRefreshToken(pool, rotateInput(seeded.clientId, seeded.parentDigest)),
    ]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['issued', 'replay_detected']);
    await expectNoLiveFamilyTokens(seeded.familyId);
  });

  it('serializes parent replay against child rotation without leaving a live generation', async () => {
    const seeded = await seedFamily({ parentUsed: true, child: true });
    const outcomes = await Promise.all([
      rotateRefreshToken(pool, rotateInput(seeded.clientId, seeded.parentDigest)),
      rotateRefreshToken(pool, rotateInput(seeded.clientId, seeded.childDigest!)),
    ]);

    expect(outcomes.some((outcome) => outcome.kind === 'replay_detected')).toBe(true);
    expect(outcomes.every((outcome) => outcome.kind !== 'invalid_grant')).toBe(true);
    await expectNoLiveFamilyTokens(seeded.familyId);
  });
});
