import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MCP_AUTHORIZATION_REQUEST_PATTERN, PKCE_S256_CHALLENGE_PATTERN } from '@cb/shared';
import type { Queryable } from '../platform/infra/db.js';
import {
  beginAuthorization,
  createOAuthCleanupScheduler,
  issueTokens,
  matchesRegisteredLoopbackRedirect,
  registerDynamicClient,
} from '../modules/external-mcp/service.js';

const RESOURCE = 'https://test.example/api/external-mcp/mcp';
const REGISTERED_REDIRECT = 'http://127.0.0.1:1455/callback/codex-id';

function registrationDb() {
  const clients = new Map<string, Record<string, unknown>>();
  const clientsByDigest = new Map<string, Record<string, unknown>>();
  const authorizationInsert = vi.fn();
  const db: Queryable = {
    async query<R>(sql: string, params: unknown[] = []) {
      if (sql.includes('FROM register_oauth_client')) {
        const [
          clientId,
          registrationDigest,
          clientName,
          redirectUris,
          grantTypes,
          responseTypes,
          authMethod,
        ] = params;
        const digestKey = (registrationDigest as Buffer).toString('hex');
        const existing = clientsByDigest.get(digestKey);
        if (existing) {
          existing.redirect_uris = redirectUris;
          return {
            rows: [{ ...existing, registration_status: 'registered' }] as R[],
            rowCount: 1,
          };
        }
        const row = {
          client_id: clientId,
          client_name: clientName,
          redirect_uris: redirectUris,
          grant_types: grantTypes,
          response_types: responseTypes,
          token_endpoint_auth_method: authMethod,
          created_at: new Date('2026-08-06T00:00:00.000Z'),
        };
        clients.set(String(clientId), row);
        clientsByDigest.set(digestKey, row);
        return {
          rows: [{ ...row, registration_status: 'registered' }] as R[],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE oauth_clients')) {
        const row = clients.get(String(params[0]));
        return { rows: (row ? [row] : []) as R[], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO oauth_authorization_requests')) {
        authorizationInsert(params);
        return { rows: [] as R[], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { db, authorizationInsert, clients };
}

describe('external MCP OAuth client and authorization validation', () => {
  it('runs bounded OAuth cleanup at most once per process interval', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          authorization_requests_deleted: 3,
          authorization_codes_deleted: 2,
          access_tokens_deleted: 1,
          refresh_tokens_deleted: 1,
          clients_deleted: 1,
        },
      ],
      rowCount: 1,
    });
    const db = { query } as Queryable;
    const schedule = createOAuthCleanupScheduler(60_000, 100);

    await expect(Promise.all([schedule(db, 1_000), schedule(db, 1_000)])).resolves.toEqual([
      true,
      false,
    ]);
    await expect(schedule(db, 60_999)).resolves.toBe(false);
    await expect(schedule(db, 61_000)).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('cleanup_expired_oauth_artifacts($1)'),
      [100],
    );
  });

  it('matches loopback redirects while ignoring only the callback port', () => {
    expect(
      matchesRegisteredLoopbackRedirect('http://127.0.0.1:65530/callback/codex-id', [
        REGISTERED_REDIRECT,
      ]),
    ).toBe(true);
    expect(
      matchesRegisteredLoopbackRedirect('http://127.0.0.1:65530/callback/another', [
        REGISTERED_REDIRECT,
      ]),
    ).toBe(false);
    expect(
      matchesRegisteredLoopbackRedirect('http://localhost:65530/callback/codex-id', [
        REGISTERED_REDIRECT,
      ]),
    ).toBe(false);
    expect(
      matchesRegisteredLoopbackRedirect('https://127.0.0.1:65530/callback/codex-id', [
        REGISTERED_REDIRECT,
      ]),
    ).toBe(false);
  });

  it('accepts only loopback public clients with authorization-code plus refresh grants', async () => {
    const { db, clients } = registrationDb();
    await expect(
      registerDynamicClient(db, {
        redirect_uris: ['https://evil.example/callback'],
        client_name: 'Codex',
      }),
    ).resolves.toEqual({ kind: 'invalid_request' });
    await expect(
      registerDynamicClient(db, {
        redirect_uris: ['http://localhost:1455/callback/codex-id'],
        client_name: 'Codex',
      }),
    ).resolves.toEqual({ kind: 'invalid_request' });
    await expect(
      registerDynamicClient(db, {
        redirect_uris: [REGISTERED_REDIRECT],
        grant_types: ['authorization_code'],
      }),
    ).resolves.toEqual({ kind: 'invalid_request' });

    const outcome = await registerDynamicClient(db, {
      redirect_uris: [REGISTERED_REDIRECT],
      client_name: 'Codex',
      grant_types: ['refresh_token', 'authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(outcome.kind).toBe('registered');
    if (outcome.kind !== 'registered') return;
    expect(outcome.response).toMatchObject({
      client_name: 'Codex',
      redirect_uris: [REGISTERED_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });

    const ipv6 = await registerDynamicClient(db, {
      redirect_uris: ['http://[::1]:1455/callback/codex-id'],
      client_name: 'Codex IPv6',
    });
    expect(ipv6.kind).toBe('registered');

    const sameCodexInstallOnAnotherPort = await registerDynamicClient(db, {
      redirect_uris: ['http://127.0.0.1:65530/callback/codex-id'],
      client_name: 'Codex',
    });
    expect(sameCodexInstallOnAnotherPort.kind).toBe('registered');
    if (outcome.kind === 'registered' && sameCodexInstallOnAnotherPort.kind === 'registered') {
      expect(sameCodexInstallOnAnotherPort.response.client_id).toBe(outcome.response.client_id);
      expect(sameCodexInstallOnAnotherPort.response.redirect_uris).toEqual([
        'http://127.0.0.1:65530/callback/codex-id',
      ]);
    }
    expect(clients.size).toBe(2);
  });

  it('surfaces database capacity exhaustion without attempting a direct table insert', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ registration_status: 'capacity_exceeded' }],
      rowCount: 1,
    });
    await expect(
      registerDynamicClient({ query } as Queryable, {
        redirect_uris: [REGISTERED_REDIRECT],
        client_name: 'Codex',
      }),
    ).resolves.toEqual({ kind: 'capacity_exceeded' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('FROM register_oauth_client(');
    expect(query.mock.calls[0]?.[0]).not.toContain('INSERT INTO oauth_clients');
  });

  it('requires exact resource, state, PKCE S256 and stores only an opaque request digest', async () => {
    const { db, authorizationInsert } = registrationDb();
    const registered = await registerDynamicClient(db, {
      redirect_uris: [REGISTERED_REDIRECT],
      client_name: 'Codex',
    });
    if (registered.kind !== 'registered') throw new Error('client registration failed');
    const verifier = 'v'.repeat(43);
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    expect(PKCE_S256_CHALLENGE_PATTERN.test(challenge)).toBe(true);
    const base = {
      responseType: 'code',
      clientId: registered.response.client_id,
      redirectUri: 'http://127.0.0.1:49152/callback/codex-id',
      scope: 'combo.agent:read combo.agent:write',
      state: 'codex-state',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      resource: RESOURCE,
    };

    await expect(
      beginAuthorization(db, { ...base, resource: `${RESOURCE}/wrong` }, RESOURCE),
    ).resolves.toEqual({ kind: 'invalid_request' });
    await expect(
      beginAuthorization(db, { ...base, codeChallengeMethod: 'plain' }, RESOURCE),
    ).resolves.toEqual({ kind: 'invalid_request' });
    await expect(beginAuthorization(db, { ...base, state: undefined }, RESOURCE)).resolves.toEqual({
      kind: 'invalid_request',
    });

    const outcome = await beginAuthorization(db, base, RESOURCE);
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.requestToken).toMatch(MCP_AUTHORIZATION_REQUEST_PATTERN);
    expect(authorizationInsert).toHaveBeenCalledTimes(1);
    const params = authorizationInsert.mock.calls[0]![0] as unknown[];
    expect(params[0]).toBeInstanceOf(Buffer);
    expect(params[0]).toHaveLength(32);
    expect(JSON.stringify(params)).not.toContain(outcome.requestToken);
    expect(params).toContain(RESOURCE);
    expect(params).toContain(challenge);
  });

  it('rejects conflicting token resources, duplicated scalar parameters and public-client secrets before a transaction', async () => {
    const pool = { connect: vi.fn().mockRejectedValue(new Error('must not connect')) };
    await expect(
      issueTokens(
        pool,
        new URLSearchParams([
          ['grant_type', 'refresh_token'],
          ['client_id', `mcp_client_${'a'.repeat(43)}`],
          ['resource', RESOURCE],
          ['resource', `${RESOURCE}/conflict`],
          ['refresh_token', `mrt1.${'a'.repeat(43)}`],
        ]),
        RESOURCE,
      ),
    ).resolves.toEqual({ kind: 'invalid_request' });
    await expect(
      issueTokens(
        pool,
        new URLSearchParams([
          ['grant_type', 'refresh_token'],
          ['grant_type', 'refresh_token'],
          ['client_id', `mcp_client_${'a'.repeat(43)}`],
          ['resource', RESOURCE],
          ['refresh_token', `mrt1.${'a'.repeat(43)}`],
        ]),
        RESOURCE,
      ),
    ).resolves.toEqual({ kind: 'invalid_request' });
    await expect(
      issueTokens(
        pool,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: `mcp_client_${'a'.repeat(43)}`,
          client_secret: 'not-accepted',
          resource: RESOURCE,
          refresh_token: `mrt1.${'a'.repeat(43)}`,
        }),
        RESOURCE,
      ),
    ).resolves.toEqual({ kind: 'invalid_client' });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('coalesces repeated identical resource values before entering the token transaction', async () => {
    const pool = { connect: vi.fn().mockRejectedValue(new Error('transaction reached')) };
    await expect(
      issueTokens(
        pool,
        new URLSearchParams([
          ['grant_type', 'refresh_token'],
          ['client_id', `mcp_client_${'a'.repeat(43)}`],
          ['resource', RESOURCE],
          ['resource', RESOURCE],
          ['refresh_token', `mrt1.${'a'.repeat(43)}`],
        ]),
        RESOURCE,
      ),
    ).rejects.toThrow('transaction reached');
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });
});
