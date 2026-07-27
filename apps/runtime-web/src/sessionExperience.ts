import type { SessionDetail, SessionMode } from '@cb/shared';

export type RuntimeSessionExperience = SessionMode;

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
  if (persistedMode === 'studio') return 'studio';
  if (persistedMode === 'consume') return 'consume';
  return queryMode === 'studio' ? 'studio' : 'consume';
}
