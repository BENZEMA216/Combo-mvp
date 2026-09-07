import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { parseAssertionPrivateKey } from './assertion.js';

const CredentialSchema = z
  .object({
    credentialId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    secretSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type AgentCredential = Readonly<z.infer<typeof CredentialSchema>>;
export const AGENT_ACCESS_AUDIENCE = 'combo-llm-gateway';
export const AGENT_ACCESS_SCOPE = 'llm:invoke';
export const AGENT_ACCESS_TTL_SECONDS = 300;

/** Configuration stores only secret digests. Raw per-Agent credentials never enter Authz storage. */
export function parseAgentCredentials(value: string | undefined): readonly AgentCredential[] {
  if (!value) return [];
  try {
    if (value.length > 256 * 1024) throw new Error('too large');
    const records = z.array(CredentialSchema).max(1000).parse(JSON.parse(value));
    if (
      new Set(records.map((r) => r.credentialId)).size !== records.length ||
      new Set(records.map((r) => r.secretSha256)).size !== records.length
    )
      throw new Error('duplicate credentials');
    return Object.freeze(records.map((record) => Object.freeze(record)));
  } catch {
    throw new Error(
      'AUTHZ_AGENT_CREDENTIALS_JSON must contain unique, valid per-Agent credential records',
    );
  }
}

export interface AgentAccessToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
}
export interface AgentAccessIssuer {
  issue(authorization: string | undefined): Promise<AgentAccessToken | null>;
}

export function createAgentAccessIssuer(options: {
  credentials: readonly AgentCredential[];
  privateKey: string;
  kid: string;
  issuer: string;
  now?: () => number;
}): AgentAccessIssuer {
  const credentials = parseAgentCredentials(JSON.stringify(options.credentials));
  if (!/^[\x21-\x7e]{1,128}$/.test(options.kid) || !/^[\x21-\x7e]{1,256}$/.test(options.issuer))
    throw new Error('agent access signing metadata is invalid');
  const key = parseAssertionPrivateKey(options.privateKey);
  const records = new Map(
    credentials.map((r) => [
      r.credentialId,
      { agentId: r.agentId, digest: Buffer.from(r.secretSha256, 'hex') },
    ]),
  );
  const missing = Buffer.alloc(32);
  return {
    async issue(authorization) {
      if (!authorization || authorization.length > 1024 || !authorization.startsWith('Basic '))
        return null;
      const encoded = authorization.slice(6);
      const decoded = Buffer.from(encoded, 'base64');
      if (decoded.toString('base64') !== encoded) return null;
      const value = decoded.toString('utf8');
      const match = /^([A-Za-z0-9_-]{8,128}):([A-Za-z0-9_-]{32,256})$/.exec(value);
      if (!match) return null;
      const record = records.get(match[1]!);
      const digest = createHash('sha256').update(match[2]!).digest();
      const matches = timingSafeEqual(digest, record?.digest ?? missing);
      if (!record || !matches) return null;
      const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
      const accessToken = await new SignJWT({
        token_use: 'agent_access',
        agent_id: record.agentId,
        scope: AGENT_ACCESS_SCOPE,
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: options.kid })
        .setSubject(record.agentId)
        .setIssuer(options.issuer)
        .setAudience(AGENT_ACCESS_AUDIENCE)
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + AGENT_ACCESS_TTL_SECONDS)
        .setJti(randomUUID())
        .sign(key);
      return { accessToken, tokenType: 'Bearer', expiresInSeconds: AGENT_ACCESS_TTL_SECONDS };
    },
  };
}
