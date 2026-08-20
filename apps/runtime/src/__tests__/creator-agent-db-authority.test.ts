import { describe, expect, it } from 'vitest';
import { isExactCreatorAgentConsumerAuthority } from '../platform/infra/db.js';

const exact = {
  current_user_name: 'combo_agent_consumer_api',
  session_user_name: 'combo_agent_consumer_api',
  can_login: true,
  superuser: false,
  bypass_rls: false,
  create_database: false,
  create_role: false,
  inherit_privileges: false,
  replicate: false,
  database_connect: true,
  database_create: false,
  database_temporary: true,
  exact_capabilities: true,
} as const;

describe('Creator Agent Consumer database readiness authority', () => {
  it('accepts only the exact direct-login Consumer role and capability set', () => {
    expect(isExactCreatorAgentConsumerAuthority(exact)).toBe(true);
  });

  it.each([
    ['current role', { current_user_name: 'combo_agent_api' }],
    ['session role', { session_user_name: 'postgres' }],
    ['LOGIN', { can_login: false }],
    ['SUPERUSER', { superuser: true }],
    ['BYPASSRLS', { bypass_rls: true }],
    ['CREATEDB', { create_database: true }],
    ['CREATEROLE', { create_role: true }],
    ['INHERIT', { inherit_privileges: true }],
    ['REPLICATION', { replicate: true }],
    ['database CONNECT', { database_connect: false }],
    ['database CREATE', { database_create: true }],
    ['database TEMPORARY', { database_temporary: false }],
    ['capability drift', { exact_capabilities: false }],
  ] as const)('rejects %s drift', (_name, override) => {
    expect(isExactCreatorAgentConsumerAuthority({ ...exact, ...override })).toBe(false);
  });
});
