import { z } from 'zod';

import {
  HostThreadIdSchema,
  HostTurnIdSchema,
  Sha256DigestSchema,
  type Sha256Digest,
} from './primitives.js';

export const CREATOR_AUTHORIZATION_PROTOCOL = 'combo.creator-authorization/1' as const;
export const CREATOR_AUTHORIZATION_AUDIENCE = 'combo.agent-package-creator-authorized/1' as const;
export const CREATOR_AUTHORIZATION_MAX_LIFETIME_MS = 5 * 60 * 1_000;

const OPAQUE_AUTHORIZATION_ID_PATTERN = /^[0-9a-f]{64}$/u;
const HOST_BINDING_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

const CreatorAuthorizationBindingSchema = z
  .object({
    threadId: HostThreadIdSchema,
    turnId: HostTurnIdSchema,
    itemId: z.string().regex(HOST_BINDING_ID_PATTERN),
    projectBindingId: z.string().regex(HOST_BINDING_ID_PATTERN),
    creatorRequestDigest: Sha256DigestSchema,
    executorDigest: Sha256DigestSchema,
  })
  .strict()
  .readonly();

const CreatorAuthorizationScopeSchema = z
  .object({
    operation: z.literal('create_agent_package_draft'),
    sourceProfile: z.literal('combo.creator-project-source-profile/1'),
    hostReadIsolation: z.literal('same_uid_unisolated_not_os_enforced'),
    modelDisclosure: z.literal('selected_project_context_to_codex_model'),
    comboDisclosure: z.literal('draft_and_relative_citations_only'),
    projectMutation: z.literal('none'),
    terminalProduct: z.literal('draft_only'),
  })
  .strict()
  .readonly();

/**
 * Path-free approval-card semantics for a future Codex Host adapter.
 *
 * These claims are not a bearer token, signature, redemption receipt, or proof that a user saw
 * or approved a card. Only an authenticated Host ledger may mint and atomically redeem the real
 * authority represented by these semantics.
 */
export const CreatorAuthorizationClaimsSchema = z
  .object({
    protocol: z.literal(CREATOR_AUTHORIZATION_PROTOCOL),
    authorizationId: z.string().regex(OPAQUE_AUTHORIZATION_ID_PATTERN),
    issuer: z.literal('codex_host'),
    audience: z.literal(CREATOR_AUTHORIZATION_AUDIENCE),
    binding: CreatorAuthorizationBindingSchema,
    scope: CreatorAuthorizationScopeSchema,
    issuedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    useLimit: z.literal(1),
  })
  .strict()
  .superRefine((claims, context) => {
    const lifetime = claims.expiresAtMs - claims.issuedAtMs;
    if (lifetime <= 0 || lifetime > CREATOR_AUTHORIZATION_MAX_LIFETIME_MS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAtMs'],
        message: 'Creator authorization lifetime is invalid',
      });
    }
  })
  .readonly();
export type CreatorAuthorizationClaims = z.infer<typeof CreatorAuthorizationClaimsSchema>;

export type CreatorAuthorizationErrorCode =
  | 'CREATOR_AUTHORIZATION_REQUIRED'
  | 'CREATOR_AUTHORIZATION_DECLINED'
  | 'CREATOR_AUTHORIZATION_EXPIRED'
  | 'CREATOR_AUTHORIZATION_REVOKED'
  | 'CREATOR_AUTHORIZATION_ALREADY_CONSUMED'
  | 'CREATOR_AUTHORIZATION_BINDING_MISMATCH'
  | 'CREATOR_AUTHORIZATION_EVIDENCE_LOST';

export class CreatorAuthorizationError extends Error {
  public constructor(public readonly code: CreatorAuthorizationErrorCode) {
    super('Creator authorization is unavailable or invalid.');
    this.name = 'CreatorAuthorizationError';
  }
}

export type CreatorAuthorizationDigest = Sha256Digest;
