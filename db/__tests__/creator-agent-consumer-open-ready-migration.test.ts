import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(directory, '..', 'migrations', '0014_creator_agent_consumer_open_ready.sql'),
  'utf8',
);
const previous = readFileSync(
  resolve(directory, '..', 'migrations', '0013_creator_agent_consumer_create.sql'),
  'utf8',
);

describe('0014 Consumer-only Conversation open/ready authority', () => {
  it('leaves the published 0013 migration byte-for-byte immutable', () => {
    expect(createHash('sha256').update(previous).digest('hex')).toBe(
      'f1609c9dd658a42d79ddd5b5500faf98f0391bebf77b5b7c80ad2b2bbc5a33cf',
    );
  });

  it('creates one non-bypass Consumer role with no direct table writes', () => {
    expect(migration).toContain(
      'CREATE ROLE combo_agent_consumer_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
    );
    expect(migration).toContain('ALTER ROLE combo_agent_consumer_api');
    expect(migration).toContain('FROM combo_agent_consumer_api;');
    expect(migration).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE)[\s\S]*?TO combo_agent_consumer_api;/u,
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION creator_agent_create_opening_conversation(',
    );
    expect(migration).not.toContain(
      'GRANT EXECUTE ON FUNCTION creator_agent_lock_consumer_access(uuid, uuid, uuid) TO combo_agent_consumer_api',
    );
    expect(migration).not.toContain(
      'GRANT EXECUTE ON FUNCTION creator_agent_lock_live_worker(uuid, uuid, uuid, bigint) TO combo_agent_consumer_api',
    );
  });

  it('normalizes exact conversation.open authority into the durable Broker Outbox', () => {
    for (const column of [
      'conversation_id',
      'deployment_id',
      'assignment_lease_id',
      'assignment_fence',
    ]) {
      expect(migration).toContain(`ADD COLUMN ${column}`);
    }
    expect(migration).toContain("command_type = 'conversation.open'");
    expect(migration).toContain('fk_broker_outbox_conversation_tenant');
    expect(migration).toContain('fk_broker_outbox_deployment_creator');
    expect(migration).toContain('fk_broker_outbox_lease_binding');
    expect(migration).toContain('uq_broker_outbox_conversation_open');
    expect(migration).toContain("input_version_digest, 'OPENING', input_worker_id");
    expect(migration).toMatch(
      /INSERT INTO public\.agent_conversations[\s\S]+INSERT INTO public\.broker_outbox/u,
    );
    expect(migration).toContain("'creator-agent:create-conversation:' || input_consumer_id::text");
  });

  it('freezes the exact Gateway ready projector signature and atomic projection', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION creator_agent_commit_conversation_ready(',
    );
    expect(migration).toContain(
      'RETURNS TABLE (outcome text, conversation_state text, open_command_id uuid)',
    );
    expect(migration).toContain('CREATE TABLE conversation_ready_receipts (');
    expect(migration).toContain('CREATE TRIGGER conversation_ready_receipts_immutable');
    expect(migration).toContain("AND command.state = 'SENT'");
    expect(migration).toContain(
      "'creator-agent:conversation-ready:' || input_conversation_id::text",
    );
    expect(migration).toContain("'creator-agent:ready-source:' || input_source_event_id::text");
    expect(migration).toContain("lease.expires_at > clock_timestamp() + interval '3 seconds'");
    expect(migration).toMatch(
      /INSERT INTO public\.conversation_ready_receipts[\s\S]+UPDATE public\.broker_outbox[\s\S]+UPDATE public\.agent_conversations/u,
    );
    expect(migration).toContain("RETURN QUERY SELECT 'REPLAY'::text");
    expect(migration).toContain("RETURN QUERY SELECT 'REJECTED'::text");
    expect(migration).toContain("RETURN QUERY SELECT 'APPLIED'::text, 'IDLE'::text");
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION creator_agent_commit_conversation_ready(',
    );
  });

  it('blocks every application role from bypassing OPENING and open-command authority', () => {
    expect(migration).toContain('OPENING conversation requires exact conversation.ready authority');
    expect(migration).toContain(
      'conversation.open ACK requires exact conversation.ready authority',
    );
    expect(migration).toContain('conversation.open must use its atomic authority function');
    expect(migration).toContain('Conversation create must use its atomic open authority function');
    expect(migration).toContain('CREATE TRIGGER agent_conversations_atomic_insert');
    for (const role of [
      'combo_agent_api',
      'combo_agent_broker',
      'combo_agent_reconciler',
      'combo_agent_consumer_api',
    ]) {
      expect(migration).toContain(`'${role}'`);
    }
  });
});
