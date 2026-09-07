import { createHash, generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { createAgentAccessIssuer, parseAgentCredentials } from '../agent-access.js';

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const secretA = 'a'.repeat(43);
const secretB = 'b'.repeat(43);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const registry = [
  { credentialId: 'credential-a', agentId: 'agent-a', secretSha256: digest(secretA) },
  { credentialId: 'credential-b', agentId: 'agent-b', secretSha256: digest(secretB) },
];
const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

describe('per-Agent access credentials', () => {
  it('binds a five-minute token to the authenticated Agent and Gateway-only scope', async () => {
    const now = Date.now();
    const issuer = createAgentAccessIssuer({
      credentials: registry,
      privateKey,
      kid: 'test-key',
      issuer: 'combo-authz',
      now: () => now,
    });
    const token = await issuer.issue(basic('credential-a', secretA));
    expect(token).not.toBeNull();
    const { payload } = await jwtVerify(token!.accessToken, keys.publicKey, {
      audience: 'combo-llm-gateway',
      issuer: 'combo-authz',
      algorithms: ['EdDSA'],
    });
    expect(payload).toMatchObject({
      sub: 'agent-a',
      agent_id: 'agent-a',
      token_use: 'agent_access',
      scope: 'llm:invoke',
    });
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(payload).not.toHaveProperty('secretSha256');
    expect(token!.accessToken).not.toContain(secretA);
    await expect(
      jwtVerify(token!.accessToken, keys.publicKey, { audience: 'combo-billing' }),
    ).rejects.toThrow();
    await expect(
      jwtVerify(token!.accessToken, keys.publicKey, { currentDate: new Date(now + 301_000) }),
    ).rejects.toThrow();
  });
  it('does not let one credential impersonate another Agent', async () => {
    const issuer = createAgentAccessIssuer({
      credentials: registry,
      privateKey,
      kid: 'test-key',
      issuer: 'combo-authz',
    });
    for (const auth of [
      undefined,
      'Bearer wrong',
      basic('credential-b', secretA),
      basic('credential-a', secretB),
      basic('unknown-id', secretA),
      'Basic !!!',
      basic('credential-a', 'short'),
    ])
      expect(await issuer.issue(auth)).toBeNull();
    const issued = await issuer.issue(basic('credential-b', secretB));
    expect((await jwtVerify(issued!.accessToken, keys.publicKey)).payload.agent_id).toBe('agent-b');
  });
  it('rejects duplicate/shared credentials and malformed configuration without exposing it', () => {
    expect(parseAgentCredentials(undefined)).toEqual([]);
    expect(parseAgentCredentials(JSON.stringify(registry))).toHaveLength(2);
    for (const input of [
      '{',
      JSON.stringify([{ ...registry[0], secret: secretA }]),
      JSON.stringify([registry[0], registry[0]]),
      JSON.stringify([registry[0], { ...registry[1], secretSha256: digest(secretA) }]),
    ]) {
      expect(() => parseAgentCredentials(input)).toThrow('AUTHZ_AGENT_CREDENTIALS_JSON');
      try {
        parseAgentCredentials(input);
      } catch (error) {
        expect(String(error)).not.toContain(secretA);
      }
    }
  });
});
