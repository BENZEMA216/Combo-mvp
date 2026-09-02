import { KNOWLEDGE_AGENT_PRODUCT_KIND, type SessionDetail, type SessionMode } from '@cb/shared';

export type RuntimeSessionExperience = SessionMode | 'knowledge';

/**
 * The persisted session field is authoritative. `?mode=studio` is a temporary
 * compatibility bridge for links created while older runtime nodes are still
 * rolling out; it can be removed once every SessionDetail carries `mode`.
 */
export function resolveSessionExperience(
  detail: SessionDetail | undefined,
  queryMode: string | null | undefined,
): RuntimeSessionExperience {
  const persistedMode = detail?.session.mode;
  const binding = detail?.agentBinding;
  if (persistedMode === 'studio') return 'studio';
  if (persistedMode === 'consume' && binding?.productKind === KNOWLEDGE_AGENT_PRODUCT_KIND) {
    return 'knowledge';
  }
  if (persistedMode === 'consume') return 'consume';
  return queryMode === 'studio' ? 'studio' : 'consume';
}
