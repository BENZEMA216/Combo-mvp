import { describe, expect, it } from 'vitest';
import { listMigrations, planMigrations } from '../scripts/migrate.js';

const V2_TAIL = [
  '0012_v2_end_user_identity.sql',
  '0013_v2_billing.sql',
  '0014_v2_email_login.sql',
] as const;

describe('isolated V2 migration runner contract', () => {
  it('reuses only the canonical 0000-0011 prefix before the V2 tail', () => {
    const canonical = listMigrations();
    const v2 = listMigrations('v2');

    expect(canonical.at(-1)).toBe('0019_pending_usage_recovery.sql');
    expect(v2).toEqual([...canonical.slice(0, 12), ...V2_TAIL]);
    expect(v2.at(-1)).toBe('0014_v2_email_login.sql');
    expect(v2).not.toContain('0012_agent_builder_v1.sql');
  });

  it('accepts the deployed V2 ledger and plans only its missing suffix', () => {
    const v2 = listMigrations('v2');
    const sharedPrefix = v2.slice(0, 12);

    expect(planMigrations(v2, sharedPrefix, '0014_v2_email_login.sql').pending).toEqual(V2_TAIL);
    expect(planMigrations(v2, v2, '0014_v2_email_login.sql').pending).toEqual([]);
  });
});
