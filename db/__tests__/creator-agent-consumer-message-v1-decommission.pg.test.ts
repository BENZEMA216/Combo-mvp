import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const consumerPassword = process.env.POSTGRES_AGENT_CONSUMER_API_PASSWORD;
const requested = process.env.CREATOR_AGENT_CONSUMER_V1_DECOMMISSION_PG_TEST === '1';

if (requested && (!databaseUrl || !consumerPassword)) {
  throw new Error(
    'CREATOR_AGENT_CONSUMER_V1_DECOMMISSION_PG_TEST requires DATABASE_URL and ' +
      'POSTGRES_AGENT_CONSUMER_API_PASSWORD',
  );
}

const pgDescribe = requested ? describe.sequential : describe.skip;
const legacyAcceptSignature =
  'public.creator_agent_accept_consumer_message_v1(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer)';
const preflightSignature =
  'public.creator_agent_preflight_consumer_message_v2(uuid,uuid,text,text)';
const finalizeSignature =
  'public.creator_agent_finalize_consumer_message_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer,jsonb,text)';

function consumerDatabaseUrl(): string {
  const url = new URL(databaseUrl ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid');
  url.username = 'combo_agent_consumer_api';
  url.password = consumerPassword ?? 'invalid';
  return url.toString();
}

pgDescribe('0030 Consumer legacy v1 decommission real PostgreSQL authority', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const consumer = new Client({ connectionString: consumerDatabaseUrl() });

  beforeAll(async () => {
    await owner.connect();
    await consumer.connect();
  });

  afterAll(async () => {
    await Promise.all([owner.end(), consumer.end()]);
  });

  it('keeps the final ledger at 0030 and replaces legacy accept with the v2 authorities', async () => {
    const head = await owner.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`,
    );
    expect(head.rows).toEqual([{ filename: '0030_creator_agent_runtime_product_wiring.sql' }]);

    const authority = await consumer.query<{
      current_user: string;
      session_user: string;
      legacy_accept: boolean;
      preflight_v2: boolean;
      finalize_v2: boolean;
      direct_message_insert: boolean;
      direct_invocation_insert: boolean;
      direct_outbox_insert: boolean;
    }>(
      `SELECT current_user,
              session_user,
              has_function_privilege(current_user, $1, 'EXECUTE') AS legacy_accept,
              has_function_privilege(current_user, $2, 'EXECUTE') AS preflight_v2,
              has_function_privilege(current_user, $3, 'EXECUTE') AS finalize_v2,
              has_table_privilege(current_user, 'agent_messages', 'INSERT')
                AS direct_message_insert,
              has_table_privilege(current_user, 'agent_invocations', 'INSERT')
                AS direct_invocation_insert,
              has_table_privilege(current_user, 'broker_outbox', 'INSERT')
                AS direct_outbox_insert`,
      [legacyAcceptSignature, preflightSignature, finalizeSignature],
    );
    expect(authority.rows[0]).toEqual({
      current_user: 'combo_agent_consumer_api',
      session_user: 'combo_agent_consumer_api',
      legacy_accept: false,
      preflight_v2: true,
      finalize_v2: true,
      direct_message_insert: false,
      direct_invocation_insert: false,
      direct_outbox_insert: false,
    });

    await expect(
      consumer.query(
        `SELECT * FROM public.creator_agent_accept_consumer_message_v1(
           NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
           NULL::text, NULL::uuid, NULL::text, NULL::text,
           NULL::text, NULL::text, NULL::bytea, NULL::bytea,
           NULL::bytea, NULL::text, NULL::text, NULL::integer
         )`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
