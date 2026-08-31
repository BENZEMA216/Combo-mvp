import { describe, expect, it } from 'vitest';
import type { SessionDetail } from '@cb/shared';
import { resolveSessionExperience } from './sessionExperience.js';

const CAPABILITY_ID = '22222222-2222-4222-8222-222222222222';

function detailWithMode(mode?: string): SessionDetail {
  return {
    session: {
      id: '11111111-1111-4111-8111-111111111111',
      capabilityId: CAPABILITY_ID,
      status: 'active',
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
      ...(mode ? { mode } : {}),
    },
    capability: {
      id: CAPABILITY_ID,
      name: 'Agent',
      summary: '',
      kind: 'workflow',
      inputs: [],
      starterPrompts: [],
    },
    messages: [],
    artifacts: [],
    activeTurn: null,
  } as SessionDetail;
}

function knowledgeDetail(mode: 'consume' | 'studio' = 'consume'): SessionDetail {
  return {
    ...detailWithMode(mode),
    agentBinding: {
      productKind: 'knowledge_agent_test',
      capability: {
        id: CAPABILITY_ID,
        protocol: 'combo.agent-package-capability/2',
      },
      release: {
        protocol: 'combo.agent-package-release/1',
        releaseId: `release.agent-package.${'a'.repeat(32)}`,
        packageDigest: `sha256:${'b'.repeat(64)}`,
      },
      releaseScope: 'controlled_test',
      knowledge: {
        protocol: 'combo.knowledge-bundle/1',
        resourcePath: 'skills/knowledge/references/knowledge-bundle.json',
        resourceDigest: `sha256:${'c'.repeat(64)}`,
      },
    },
    knowledgeResults: [],
  } as SessionDetail;
}

describe('resolveSessionExperience', () => {
  it('uses the persisted studio mode as the source of truth', () => {
    expect(resolveSessionExperience(detailWithMode('studio'), null)).toBe('studio');
    expect(resolveSessionExperience(detailWithMode('consume'), 'studio')).toBe('consume');
  });

  it('supports a temporary mode query while older detail responses roll out', () => {
    expect(resolveSessionExperience(detailWithMode(), 'studio')).toBe('studio');
  });

  it('keeps ordinary runtime sessions in consume semantics', () => {
    expect(resolveSessionExperience(detailWithMode('consume'), null)).toBe('consume');
    expect(resolveSessionExperience(undefined, null)).toBe('consume');
  });

  it('recognizes an empty knowledge Session from its persisted consume binding', () => {
    expect(resolveSessionExperience(knowledgeDetail(), null)).toBe('knowledge');
  });

  it('does not guess knowledge semantics from capability kind or result-shaped data', () => {
    const kindOnly = detailWithMode('consume');
    kindOnly.capability.kind = 'knowledge_agent_test';
    expect(resolveSessionExperience(kindOnly, null)).toBe('consume');

    const resultOnly = {
      ...detailWithMode('consume'),
      knowledgeResults: [],
    } as SessionDetail;
    expect(resolveSessionExperience(resultOnly, null)).toBe('consume');
  });

  it('keeps Studio authoritative before considering a hostile knowledge binding', () => {
    expect(resolveSessionExperience(knowledgeDetail('studio'), null)).toBe('studio');
  });
});
