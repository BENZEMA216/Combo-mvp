import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupExpiredOAuthArtifacts, readOAuthClient } from '../modules/external-mcp/repo.js';
import { registerDynamicClient } from '../modules/external-mcp/service.js';

const adminDatabaseUrl = process.env.DATABASE_URL;
const apiDatabaseUrl = process.env.MCP_OAUTH_API_DATABASE_URL;
const enabled =
  process.env.MCP_OAUTH_PG_TEST === '1' && Boolean(adminDatabaseUrl) && Boolean(apiDatabaseUrl);
const pgDescribe = enabled ? describe : describe.skip;
const CLIENT_CAPACITY = 4096;
const RESOURCE = 'https://test.example/api/external-mcp/mcp';

function registration(clientName: string, port: number, path = 'codex-id') {
  return {
    redirect_uris: [`http://127.0.0.1:${port}/callback/${path}`],
    client_name: clientName,
    grant_types: ['authorization_code', 'refresh_token'] as const,
    response_types: ['code'] as const,
    token_endpoint_auth_method: 'none' as const,
  };
}

pgDescribe('external MCP dynamic-client PostgreSQL lifecycle and capacity', () => {
  const admin = new Pool({ connectionString: adminDatabaseUrl, max: 8 });
  const api = new Pool({ connectionString: apiDatabaseUrl, max: 8 });

  async function resetOAuthTables(): Promise<void> {
    await admin.query('TRUNCATE oauth_clients CASCADE');
  }

  async function seedClients(count: number, age = '0 seconds'): Promise<void> {
    await admin.query(
      `INSERT INTO oauth_clients
         (client_id, registration_digest, client_name, redirect_uris, grant_types,
          response_types, token_endpoint_auth_method, created_at, last_used_at)
       SELECT 'mcp_client_' ||
                substr(md5($1 || ':id:' || item::text) || md5($1 || ':id-tail:' || item::text), 1, 43),
              decode(md5($1 || ':digest:' || item::text) || md5($1 || ':tail:' || item::text), 'hex'),
              'Codex capacity seed',
              ARRAY['http://127.0.0.1:49152/callback/codex-seed-' || item::text],
              ARRAY['authorization_code', 'refresh_token'], ARRAY['code'], 'none',
              now() - $2::interval, now() - $2::interval
         FROM generate_series(1, $3::integer) AS item`,
      [randomBytes(8).toString('hex'), age, count],
    );
  }

  async function protectClient(clientId: string): Promise<void> {
    await admin.query(
      `INSERT INTO oauth_authorization_requests
         (request_digest, client_id, redirect_uri, state, scope, resource_uri,
          code_challenge, expires_at)
       VALUES ($1, $2, 'http://127.0.0.1:49152/callback/protected', 'state',
               'combo.agent:read combo.agent:write', $3, $4, now() + interval '1 hour')`,
      [randomBytes(32), clientId, RESOURCE, 'c'.repeat(43)],
    );
  }

  beforeAll(async () => {
    await Promise.all([admin.query('SELECT 1'), api.query('SELECT 1')]);
  });

  beforeEach(resetOAuthTables);

  afterAll(async () => {
    await resetOAuthTables();
    await Promise.all([admin.end(), api.end()]);
  });

  it('deduplicates a canonical registration across callback-port changes and echoes the new URI', async () => {
    const first = await registerDynamicClient(api, registration('Codex PG', 49152));
    const second = await registerDynamicClient(api, registration('Codex PG', 65530));
    expect(first.kind).toBe('registered');
    expect(second.kind).toBe('registered');
    if (first.kind !== 'registered' || second.kind !== 'registered') return;

    expect(second.response.client_id).toBe(first.response.client_id);
    expect(second.response.redirect_uris).toEqual(['http://127.0.0.1:65530/callback/codex-id']);
    const count = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM oauth_clients',
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('indexes every client reference used by capacity checks and lifecycle cleanup', async () => {
    const indexes = await admin.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [
        [
          'idx_oauth_access_tokens_client',
          'idx_oauth_authorization_codes_client',
          'idx_oauth_authorization_requests_client',
          'idx_oauth_refresh_tokens_client',
        ],
      ],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'idx_oauth_access_tokens_client',
      'idx_oauth_authorization_codes_client',
      'idx_oauth_authorization_requests_client',
      'idx_oauth_refresh_tokens_client',
    ]);
  });

  it('cleans only 30-day inactive clients with no OAuth references', async () => {
    await seedClients(2, '31 days');
    const rows = await admin.query<{ client_id: string }>(
      'SELECT client_id FROM oauth_clients ORDER BY client_id',
    );
    const orphanId = rows.rows[0]!.client_id;
    const protectedId = rows.rows[1]!.client_id;
    await protectClient(protectedId);

    const cleaned = await cleanupExpiredOAuthArtifacts(api, 100);
    expect(cleaned.clientsDeleted).toBe(1);
    const remaining = await admin.query<{ client_id: string }>(
      'SELECT client_id FROM oauth_clients ORDER BY client_id',
    );
    expect(remaining.rows.map((row) => row.client_id)).toEqual([protectedId]);
    expect(remaining.rows.map((row) => row.client_id)).not.toContain(orphanId);
  });

  it('evicts one old unreferenced client at capacity but preserves the hard upper bound', async () => {
    await seedClients(CLIENT_CAPACITY - 1);
    await seedClients(1, '11 minutes');
    const old = await admin.query<{ client_id: string }>(
      `SELECT client_id FROM oauth_clients ORDER BY last_used_at LIMIT 1`,
    );

    const outcome = await registerDynamicClient(api, registration('Codex replacement', 51000));
    expect(outcome.kind).toBe('registered');
    const state = await admin.query<{ count: number; old_count: number }>(
      `SELECT count(*)::int AS count,
              count(*) FILTER (WHERE client_id = $1)::int AS old_count
         FROM oauth_clients`,
      [old.rows[0]!.client_id],
    );
    expect(state.rows[0]).toEqual({ count: CLIENT_CAPACITY, old_count: 0 });
  });

  it('fails closed when every full-capacity client is in grace or referenced', async () => {
    await seedClients(CLIENT_CAPACITY - 1);
    await seedClients(1, '11 minutes');
    const old = await admin.query<{ client_id: string }>(
      `SELECT client_id FROM oauth_clients ORDER BY last_used_at LIMIT 1`,
    );
    await protectClient(old.rows[0]!.client_id);

    await expect(registerDynamicClient(api, registration('Codex blocked', 52000))).resolves.toEqual(
      { kind: 'capacity_exceeded' },
    );
    const count = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM oauth_clients',
    );
    expect(count.rows[0]?.count).toBe(CLIENT_CAPACITY);
  });

  it('serializes concurrent boundary registrations without exceeding capacity', async () => {
    await seedClients(CLIENT_CAPACITY - 1);
    const outcomes = await Promise.all([
      registerDynamicClient(api, registration('Codex boundary A', 53000, 'boundary-a')),
      registerDynamicClient(api, registration('Codex boundary B', 53001, 'boundary-b')),
    ]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
      'capacity_exceeded',
      'registered',
    ]);
    const count = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM oauth_clients',
    );
    expect(count.rows[0]?.count).toBe(CLIENT_CAPACITY);
  });

  it('skips a capacity victim that an authorization request has just touched', async () => {
    await seedClients(CLIENT_CAPACITY - 1);
    await seedClients(1, '11 minutes');
    const old = await admin.query<{ client_id: string }>(
      `SELECT client_id FROM oauth_clients ORDER BY last_used_at LIMIT 1`,
    );
    const oldClientId = old.rows[0]!.client_id;
    const touch = await api.connect();
    await touch.query('BEGIN');
    const touched = await readOAuthClient(touch, oldClientId);
    expect(touched?.clientId).toBe(oldClientId);

    const registrationAttempt = registerDynamicClient(
      api,
      registration('Codex locked victim', 54000, 'locked-victim'),
    );
    let outcome: Awaited<typeof registrationAttempt> | 'blocked' = 'blocked';
    try {
      outcome = await Promise.race([
        registrationAttempt,
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3_000)),
      ]);
    } finally {
      await touch.query('COMMIT');
      touch.release();
    }
    if (outcome === 'blocked') {
      await registrationAttempt;
      throw new Error('capacity registration waited on a client that was already being touched');
    }
    expect(outcome).toEqual({ kind: 'capacity_exceeded' });

    const state = await admin.query<{ count: number; old_count: number }>(
      `SELECT count(*)::int AS count,
              count(*) FILTER (WHERE client_id = $1)::int AS old_count
         FROM oauth_clients`,
      [oldClientId],
    );
    expect(state.rows[0]).toEqual({ count: CLIENT_CAPACITY, old_count: 1 });
  });
});
