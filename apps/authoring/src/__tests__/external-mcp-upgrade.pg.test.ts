import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_ACCESS_TOKEN_PATTERN, MCP_REFRESH_TOKEN_PATTERN } from '@cb/shared';
import { asTxPool } from '../platform/infra/db-tx.js';
import { issueTokens, resolveMcpBearer, secretDigest } from '../modules/external-mcp/service.js';

const adminDatabaseUrl = process.env.DATABASE_URL;
const apiDatabaseUrl = process.env.MCP_OAUTH_API_DATABASE_URL;
const enabled =
  process.env.MCP_OAUTH_PG_TEST === '1' && Boolean(adminDatabaseUrl) && Boolean(apiDatabaseUrl);
const pgDescribe = enabled ? describe : describe.skip;

// Fixed rows use only columns and token encodings from c54f751 / Combo 0.8.3. They model the
// already-persisted client and token family that an in-place 0.8.4 upgrade must keep accepting.
const LEGACY_OWNER_ID = '00000000-0000-4000-8000-000000000083';
const LEGACY_FAMILY_ID = '00000000-0000-4000-8000-000000000084';
const LEGACY_CLIENT_ID = `mcp_client_${'c'.repeat(43)}`;
const LEGACY_ACCESS_TOKEN = `mat1.${'a'.repeat(43)}`;
const LEGACY_REFRESH_TOKEN = `mrt1.${'r'.repeat(43)}`;
const LEGACY_RESOURCE = 'https://test.43-160-242-46.sslip.io/api/external-mcp/mcp';

pgDescribe('Combo 0.8.3 external MCP OAuth in-place upgrade', () => {
  const admin = new Pool({ connectionString: adminDatabaseUrl, max: 2 });
  const api = new Pool({ connectionString: apiDatabaseUrl, max: 2 });

  async function clearFixture(): Promise<void> {
    await admin.query('DELETE FROM oauth_access_tokens WHERE family_id = $1', [LEGACY_FAMILY_ID]);
    await admin.query('DELETE FROM oauth_refresh_tokens WHERE family_id = $1', [LEGACY_FAMILY_ID]);
    await admin.query('DELETE FROM oauth_clients WHERE client_id = $1', [LEGACY_CLIENT_ID]);
    await admin.query('DELETE FROM users WHERE id = $1', [LEGACY_OWNER_ID]);
  }

  beforeAll(async () => {
    await Promise.all([admin.query('SELECT 1'), api.query('SELECT 1')]);
    await clearFixture();
    await admin.query(
      `INSERT INTO users (id, account, roles)
       VALUES ($1, 'creator-legacyaa', ARRAY['creator'])`,
      [LEGACY_OWNER_ID],
    );
    await admin.query(
      `INSERT INTO oauth_clients
         (client_id, registration_digest, client_name, redirect_uris, grant_types,
          response_types, token_endpoint_auth_method)
       VALUES ($1, $2, 'Codex 0.8.3 fixture',
               ARRAY['http://127.0.0.1:49152/callback/codex-id'],
               ARRAY['authorization_code', 'refresh_token'], ARRAY['code'], 'none')`,
      [LEGACY_CLIENT_ID, secretDigest('combo-0.8.3-client-fixture')],
    );
    await admin.query(
      `INSERT INTO oauth_access_tokens
         (token_digest, client_id, owner_user_id, family_id, scope, resource_uri, expires_at)
       VALUES ($1, $2, $3, $4, 'combo.agent:read combo.agent:write', $5,
               now() + interval '1 day')`,
      [
        secretDigest(LEGACY_ACCESS_TOKEN),
        LEGACY_CLIENT_ID,
        LEGACY_OWNER_ID,
        LEGACY_FAMILY_ID,
        LEGACY_RESOURCE,
      ],
    );
    await admin.query(
      `INSERT INTO oauth_refresh_tokens
         (token_digest, client_id, owner_user_id, family_id, parent_digest, scope,
          resource_uri, expires_at)
       VALUES ($1, $2, $3, $4, NULL, 'combo.agent:read combo.agent:write', $5,
               now() + interval '30 days')`,
      [
        secretDigest(LEGACY_REFRESH_TOKEN),
        LEGACY_CLIENT_ID,
        LEGACY_OWNER_ID,
        LEGACY_FAMILY_ID,
        LEGACY_RESOURCE,
      ],
    );
  });

  afterAll(async () => {
    await clearFixture();
    await Promise.all([admin.end(), api.end()]);
  });

  it('keeps the existing access token and rotates the existing refresh family without relogin', async () => {
    expect(MCP_ACCESS_TOKEN_PATTERN.test(LEGACY_ACCESS_TOKEN)).toBe(true);
    expect(MCP_REFRESH_TOKEN_PATTERN.test(LEGACY_REFRESH_TOKEN)).toBe(true);

    await expect(
      resolveMcpBearer(api, `Bearer ${LEGACY_ACCESS_TOKEN}`, LEGACY_RESOURCE),
    ).resolves.toEqual({
      kind: 'valid',
      principal: {
        userId: LEGACY_OWNER_ID,
        account: 'creator-legacyaa',
        scopes: ['combo.agent:read', 'combo.agent:write'],
      },
    });

    const rotated = await issueTokens(
      asTxPool(api),
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: LEGACY_CLIENT_ID,
        resource: LEGACY_RESOURCE,
        refresh_token: LEGACY_REFRESH_TOKEN,
        scope: 'combo.agent:read combo.agent:write',
      }),
      LEGACY_RESOURCE,
    );
    expect(rotated.kind).toBe('issued');
    if (rotated.kind !== 'issued') return;
    expect(rotated.response.access_token).toMatch(MCP_ACCESS_TOKEN_PATTERN);
    expect(rotated.response.refresh_token).toMatch(MCP_REFRESH_TOKEN_PATTERN);
    expect(rotated.response.scope).toBe('combo.agent:read combo.agent:write');

    await expect(
      resolveMcpBearer(api, `Bearer ${rotated.response.access_token}`, LEGACY_RESOURCE),
    ).resolves.toMatchObject({ kind: 'valid', principal: { userId: LEGACY_OWNER_ID } });
    await expect(
      resolveMcpBearer(api, `Bearer ${LEGACY_ACCESS_TOKEN}`, LEGACY_RESOURCE),
    ).resolves.toMatchObject({ kind: 'valid', principal: { userId: LEGACY_OWNER_ID } });

    const state = await admin.query<{
      legacy_used: boolean;
      child_refresh_count: number;
      live_access_count: number;
    }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM oauth_refresh_tokens
            WHERE token_digest = $1 AND used_at IS NOT NULL AND revoked_at IS NULL
         ) AS legacy_used,
         (SELECT count(*)::int FROM oauth_refresh_tokens
           WHERE family_id = $2 AND parent_digest = $1 AND revoked_at IS NULL) AS child_refresh_count,
         (SELECT count(*)::int FROM oauth_access_tokens
           WHERE family_id = $2 AND revoked_at IS NULL AND expires_at > now()) AS live_access_count`,
      [secretDigest(LEGACY_REFRESH_TOKEN), LEGACY_FAMILY_ID],
    );
    expect(state.rows[0]).toEqual({
      legacy_used: true,
      child_refresh_count: 1,
      live_access_count: 2,
    });
  });
});
