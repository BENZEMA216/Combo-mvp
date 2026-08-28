import { describe, expect, it } from 'vitest';

import {
  CREATOR_AUTHORIZATION_AUDIENCE,
  CREATOR_AUTHORIZATION_MAX_LIFETIME_MS,
  CREATOR_AUTHORIZATION_PROTOCOL,
  CreatorAuthorizationClaimsSchema,
  CreatorAuthorizationError,
  type CreatorAuthorizationClaims,
  type CreatorAuthorizationErrorCode,
} from '../creator-authorization.js';
import * as consumerApi from '../creator-authorization.js';

const REQUEST_DIGEST = `sha256:${'1'.repeat(64)}` as const;
const EXECUTOR_DIGEST = `sha256:${'2'.repeat(64)}` as const;

function claims(overrides: Record<string, unknown> = {}): CreatorAuthorizationClaims {
  return CreatorAuthorizationClaimsSchema.parse({
    protocol: CREATOR_AUTHORIZATION_PROTOCOL,
    authorizationId: 'a'.repeat(64),
    issuer: 'codex_host',
    audience: CREATOR_AUTHORIZATION_AUDIENCE,
    binding: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      projectBindingId: 'project-1',
      creatorRequestDigest: REQUEST_DIGEST,
      executorDigest: EXECUTOR_DIGEST,
    },
    scope: {
      operation: 'create_agent_package_draft',
      sourceProfile: 'combo.creator-project-source-profile/1',
      hostReadIsolation: 'same_uid_unisolated_not_os_enforced',
      modelDisclosure: 'selected_project_context_to_codex_model',
      comboDisclosure: 'draft_and_relative_citations_only',
      projectMutation: 'none',
      terminalProduct: 'draft_only',
    },
    issuedAtMs: 1_000,
    expiresAtMs: 1_000 + CREATOR_AUTHORIZATION_MAX_LIFETIME_MS,
    useLimit: 1,
    ...overrides,
  });
}

describe('CreatorAuthorization semantic contract', () => {
  it('defines strict path-free claims for one Draft-only approval', () => {
    const value = claims();
    expect(value).toMatchObject({
      protocol: 'combo.creator-authorization/1',
      issuer: 'codex_host',
      audience: 'combo.agent-package-creator-authorized/1',
      useLimit: 1,
      scope: {
        operation: 'create_agent_package_draft',
        hostReadIsolation: 'same_uid_unisolated_not_os_enforced',
        projectMutation: 'none',
        terminalProduct: 'draft_only',
      },
    });
    expect(JSON.stringify(value)).not.toMatch(
      /canonicalPath|device|inode|workspaceGeneration|\/Users\/|\/private\//u,
    );
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.binding)).toBe(true);
    expect(Object.isFrozen(value.scope)).toBe(true);
  });

  it('rejects path-bearing fields, unknown fields, and non-exact scope', () => {
    const value = claims();
    expect(() =>
      CreatorAuthorizationClaimsSchema.parse({
        ...value,
        canonicalPath: '/private/tmp/project',
      }),
    ).toThrow();
    expect(() =>
      CreatorAuthorizationClaimsSchema.parse({
        ...value,
        binding: { ...value.binding, workspaceGeneration: 3 },
      }),
    ).toThrow();
    expect(() =>
      CreatorAuthorizationClaimsSchema.parse({
        ...value,
        scope: { ...value.scope, projectMutation: 'write' },
      }),
    ).toThrow();
  });

  it('locks the maximum lifetime, opaque identifiers, and exact binding digests', () => {
    expect(() => claims({ expiresAtMs: 1_001 + CREATOR_AUTHORIZATION_MAX_LIFETIME_MS })).toThrow();
    expect(() => claims({ expiresAtMs: 1_000 })).toThrow();
    expect(() => claims({ authorizationId: 'not-opaque' })).toThrow();
    const value = claims();
    expect(() =>
      CreatorAuthorizationClaimsSchema.parse({
        ...value,
        binding: { ...value.binding, executorDigest: `sha256:${'g'.repeat(64)}` },
      }),
    ).toThrow();
  });

  it('exports no mint, handle, consume, or private Project authority API', () => {
    for (const forbidden of [
      'createCreatorAuthorizationHostAdapterController',
      'createCreatorAuthorizationHostAdapterControllerInternal',
      'consumeCreatorAuthorization',
      'readCreatorAuthorizationClaims',
      'readCreatorAuthorizedProjectBinding',
      'CreatorAuthorizationConsumeInputSchema',
    ]) {
      expect(consumerApi).not.toHaveProperty(forbidden);
    }
  });

  it.each([
    'CREATOR_AUTHORIZATION_REQUIRED',
    'CREATOR_AUTHORIZATION_DECLINED',
    'CREATOR_AUTHORIZATION_EXPIRED',
    'CREATOR_AUTHORIZATION_REVOKED',
    'CREATOR_AUTHORIZATION_ALREADY_CONSUMED',
    'CREATOR_AUTHORIZATION_BINDING_MISMATCH',
    'CREATOR_AUTHORIZATION_EVIDENCE_LOST',
  ] satisfies CreatorAuthorizationErrorCode[])('keeps %s on one safe error surface', (code) => {
    expect(new CreatorAuthorizationError(code)).toMatchObject({
      name: 'CreatorAuthorizationError',
      code,
      message: 'Creator authorization is unavailable or invalid.',
    });
  });
});
