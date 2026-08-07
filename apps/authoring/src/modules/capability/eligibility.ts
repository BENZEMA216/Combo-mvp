/**
 * Deterministic extraction fallbacks are diagnostic placeholders, not runnable capabilities.
 * Keep this policy outside the public Capability schema so historical objects remain readable
 * for audit and migration.
 */
export function isFallbackCapabilityMeta(meta: unknown): boolean {
  return (
    typeof meta === 'object' &&
    meta !== null &&
    !Array.isArray(meta) &&
    (meta as Record<string, unknown>).origin === 'fallback'
  );
}
