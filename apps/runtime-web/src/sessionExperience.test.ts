import { describe, expect, it } from 'vitest';
import type { SessionDetail } from '@cb/shared';
import { resolveSessionExperience } from './sessionExperience.js';

function detailWithMode(mode?: string): SessionDetail {
  return {
    session: {
      id: '11111111-1111-4111-8111-111111111111',
      capabilityId: '22222222-2222-4222-8222-222222222222',
      status: 'active',
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
      ...(mode ? { mode } : {}),
    },
    capability: {
      id: '22222222-2222-4222-8222-222222222222',
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
});
