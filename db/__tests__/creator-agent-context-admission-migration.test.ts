import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(directory, '..', 'migrations', '0021_creator_agent_context_admission.sql'),
  'utf8',
);
const migrationRunner = readFileSync(resolve(directory, '..', 'scripts', 'migrate.ts'), 'utf8');

describe('0021 Creator Agent context admission migration', () => {
  it('adds a durable context-limit marker and a database-owned USER admission guard', () => {
    expect(migration).toContain('ADD COLUMN context_limit_reached_at timestamptz');
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.creator_agent_admit_user_message_v1(',
    );
    expect(migration).toContain("runtime_policy->>'maxConversationTurns'");
    expect(migration).toContain("runtime_policy->>'maxVisibleHistoryBytes'");
    expect(migration).toContain('pg_catalog.octet_length(message.content_ciphertext)');
    expect(migration).toContain("SET state = 'SUSPENDED'");
    expect(migration).toContain("RETURN QUERY SELECT 'CONTEXT_LIMIT'::text");
    expect(migration).toContain("RETURN QUERY SELECT 'ADMITTED'::text");
    expect(migration).toContain('accepted_user_turns + 1');
    expect(migration).toContain("message.role = 'USER'");
  });

  it('keeps the marker cloud-timed, monotonic, and outside direct API authority', () => {
    expect(migration).toContain('clock_timestamp()');
    expect(migration).toContain('context limit marker is immutable once set');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public');
    expect(migration).not.toMatch(/^BEGIN;$/mu);
    expect(migration).not.toMatch(/^COMMIT;$/mu);
    expect(migrationRunner).toContain("await client.query('BEGIN')");
    expect(migrationRunner).toContain(
      "await client.query('INSERT INTO schema_migrations(filename)",
    );
    expect(migrationRunner).toContain("await client.query('COMMIT')");
    expect(migrationRunner).toContain("await client.query('ROLLBACK')");
    expect(migration).not.toMatch(
      /GRANT UPDATE \([^)]*context_limit_reached_at[^)]*\)\s+ON (?:public\.)?agent_conversations TO combo_agent_api/u,
    );
    expect(migration).toContain('REVOKE UPDATE (state, next_turn_no, last_activity_at)');
  });

  it('removes every API Message INSERT column and rejects ambiguous definer identities', () => {
    expect(migration).toMatch(
      /REVOKE INSERT \(\s*id, conversation_id, creator_id, consumer_subject_id, turn_no, role,[\s\S]*content_aad_version, invocation_id\s*\) ON public\.agent_messages FROM combo_agent_api;/u,
    );
    expect(migration).toContain("session_user = 'combo_agent_api'");
    expect(migration).toContain("session_user = 'combo_agent_broker'");
    expect(migration).toContain('USER Message admission authority is ambiguous');
    expect(migration).not.toContain("pg_has_role(current_user, 'combo_agent_api'");
    expect(migration).not.toContain("pg_has_role(current_user, 'combo_agent_broker'");
    expect(migration).toContain("input_content_algorithm IS DISTINCT FROM 'aes-256-gcm/v1'");
    expect(migration).toContain("message.content_algorithm = 'aes-256-gcm/v1'");
  });
});
