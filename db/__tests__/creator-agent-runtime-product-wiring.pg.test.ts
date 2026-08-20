import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  ExecutionCapabilitySchema,
  MODEL_ID_PATTERN_SOURCE,
  ModelIdSchema,
  canonicalizeJson,
  executionCapabilityDigest,
} from '@cb/creator-agent-protocol';

const databaseUrl = process.env.CREATOR_AGENT_PG_TEST_URL;
const expectedClusterName = process.env.CREATOR_AGENT_R3_PG_CLUSTER_NAME;
const enabled =
  process.env.CREATOR_AGENT_RUNTIME_PRODUCT_PG_TEST === '1' &&
  process.env.CREATOR_AGENT_R3_PG_ISOLATED === '1' &&
  Boolean(expectedClusterName) &&
  Boolean(databaseUrl);
const pgDescribe = enabled ? describe : describe.skip;
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const applicationRoles = [
  'combo_api',
  'combo_worker',
  'combo_runtime',
  'combo_agent_api',
  'combo_agent_broker',
  'combo_agent_reconciler',
  'combo_agent_maintenance',
  'combo_agent_consumer_api',
] as const;

interface RoleAttributes {
  rolname: (typeof applicationRoles)[number];
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolcanlogin: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

function databaseConnectionString(name: string): string {
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function applyMigration(client: Client, filename: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(readFileSync(join(migrationsDirectory, filename), 'utf8'));
    await client.query(`INSERT INTO schema_migrations(filename) VALUES ($1)`, [filename]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function expectBrokerLifecycleAuthorityDenied(client: Client): Promise<void> {
  await client.query(`SET SESSION AUTHORIZATION combo_agent_broker`);
  try {
    await client.query(`
      SELECT set_config('app.creator_id', '', false),
             set_config('app.consumer_id', '', false)
    `);
    await expect(
      client.query(`SELECT creator_agent_gateway_lifecycle_v2_ready() AS ready`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      client.query(
        `SELECT * FROM creator_agent_lock_gateway_lifecycle_command_v2(
           NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
         )`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await client.query(`RESET SESSION AUTHORIZATION`);
  }
}

async function expectBrokerLifecycleAuthorityExact(client: Client): Promise<void> {
  await client.query(`SET SESSION AUTHORIZATION combo_agent_broker`);
  try {
    await client.query(`
      SELECT set_config('app.creator_id', '', false),
             set_config('app.consumer_id', '', false)
    `);
    await expect(
      client.query<{ ready: boolean }>(
        `SELECT creator_agent_gateway_lifecycle_v2_ready() AS ready`,
      ),
    ).resolves.toMatchObject({ rows: [{ ready: true }] });
    await expect(
      client.query(
        `SELECT * FROM creator_agent_lock_gateway_lifecycle_command_v2(
           NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
         )`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  } finally {
    await client.query(`RESET SESSION AUTHORIZATION`);
  }
}

pgDescribe('0030 Runtime product PostgreSQL upgrade', () => {
  it('applies over the real 0029 head and keeps validators/ACLs fail closed', async () => {
    const admin = new Client({ connectionString: databaseUrl });
    const databaseName = `combo_runtime_product_${randomUUID().replaceAll('-', '')}`;
    let target: Client | undefined;
    let originalRoles: RoleAttributes[] = [];
    await admin.connect();
    try {
      await expect(
        admin.query<{ cluster_name: string }>(
          `SELECT current_setting('cluster_name') AS cluster_name`,
        ),
      ).resolves.toMatchObject({ rows: [{ cluster_name: expectedClusterName }] });
      // The historical migrations deliberately harden these cluster-global roles.
      // Serialize this opt-in real-PG gate and restore every attribute they mutate.
      await admin.query(`SELECT pg_advisory_lock(hashtext('combo-runtime-product-role-state'))`);
      const roleSnapshot = await admin.query<RoleAttributes>(
        `
        SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
               rolcanlogin, rolreplication, rolbypassrls
          FROM pg_roles
         WHERE rolname = ANY($1::text[])
         ORDER BY rolname
      `,
        [applicationRoles],
      );
      originalRoles = roleSnapshot.rows;
      expect(originalRoles.map(({ rolname }) => rolname).sort()).toEqual(
        [...applicationRoles].sort(),
      );

      await admin.query(`CREATE DATABASE "${databaseName}"`);
      target = new Client({ connectionString: databaseConnectionString(databaseName) });
      await target.connect();
      await target.query(`
        CREATE TABLE schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const migrations = readdirSync(migrationsDirectory)
        .filter((filename) => /^\d{4}_.+\.sql$/u.test(filename))
        .sort();
      const legacy = migrations.filter((filename) => filename < '0030_');
      expect(legacy.at(-1)).toBe('0029_creator_agent_cancelled_fact_admission.sql');
      for (const filename of legacy) await applyMigration(target, filename);

      await expect(
        target.query(`SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`),
      ).resolves.toMatchObject({
        rows: [{ filename: '0029_creator_agent_cancelled_fact_admission.sql' }],
      });
      await applyMigration(target, '0030_creator_agent_runtime_product_wiring.sql');
      await target.query(`ALTER ROLE combo_agent_broker LOGIN`);

      const capability = ExecutionCapabilitySchema.parse({
        protocol: 'combo.execution-capability/1',
        schemaVersion: 1,
        capabilityId: '01900000-0000-7000-8000-000000000101',
        invocationId: '01900000-0000-7000-8000-000000000102',
        conversationId: '01900000-0000-7000-8000-000000000103',
        deploymentId: '01900000-0000-7000-8000-000000000104',
        agentVersionId: '01900000-0000-7000-8000-000000000105',
        agentVersionDigest: 'a'.repeat(64),
        workerInstallationId: '01900000-0000-7000-8000-000000000106',
        leaseId: '01900000-0000-7000-8000-000000000107',
        fence: '7',
        providerRequestId: '01900000-0000-7000-8000-000000000108',
        requestDigest: `hmac-sha256:${'b'.repeat(64)}`,
        model: 'gpt-5.6-sol/test:latest',
        reasoningEffort: 'medium',
        budget: { maxInputTokens: 12_345, maxOutputTokens: 2_048, maxCostMicros: 9_876_543 },
        notBefore: '2026-08-20T01:02:03.004Z',
        expiresAt: '2026-08-20T01:03:03.004Z',
        nonce: Buffer.alloc(32, 7).toString('base64url'),
        signatureAlgorithm: 'ES256',
        signatureEncoding: 'ieee-p1363',
        signature: Buffer.alloc(64, 8).toString('base64url'),
      });
      expect(MODEL_ID_PATTERN_SOURCE).toBe('^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$');
      expect(ModelIdSchema.parse(capability.model)).toBe(capability.model);
      const capabilityAuthority = await target.query<{
        canonical_text: string;
        capability_digest: string;
      }>(
        `
        SELECT creator_agent_execution_capability_wire_v1_canonical_text($1::jsonb)
                 AS canonical_text,
               creator_agent_execution_capability_wire_v1_digest($1::jsonb)
                 AS capability_digest
      `,
        [capability],
      );
      expect(capabilityAuthority.rows[0]).toEqual({
        canonical_text: canonicalizeJson(capability),
        capability_digest: executionCapabilityDigest(capability),
      });

      const workerSessionId = '01900000-0000-7000-8000-000000000115';
      const commandId = '01900000-0000-7000-8000-000000000116';
      const keyId = 'worker-session-v1';
      const prepareFrame = {
        protocol: 'combo.creator-broker/1',
        schemaVersion: 1,
        kind: 'command',
        type: 'invocation.prepare',
        messageId: commandId,
        correlationId: capability.invocationId,
        connectionId: '01900000-0000-7000-8000-000000000117',
        sequence: '1',
        sentAt: '2026-08-20T01:02:03.004Z',
        expiresAt: '2026-08-20T01:02:33.004Z',
        lease: {
          deploymentId: capability.deploymentId,
          leaseId: capability.leaseId,
          workerSessionId,
          fence: capability.fence,
        },
        body: {
          invocationId: capability.invocationId,
          conversationId: capability.conversationId,
          clientMessageId: '00000000-0000-4000-8000-000000000001',
          requestDigest: capability.requestDigest,
          userMessageCiphertext: {
            algorithm: 'aes-256-gcm/v1',
            keyScope: 'worker-session',
            keyId,
            nonce: Buffer.alloc(12, 1).toString('base64url'),
            ciphertext: 'eA',
            authTag: Buffer.alloc(16, 2).toString('base64url'),
            cipherDigest: 'c'.repeat(64),
            aad: {
              protocol: 'combo.creator-broker/1',
              schemaVersion: 1,
              envelopeType: 'invocation.prepare',
              messageId: commandId,
              conversationId: capability.conversationId,
              invocationId: capability.invocationId,
              workerSessionId,
              role: 'USER',
              keyId,
            },
            aadDigest: 'd'.repeat(64),
            aadVersion: 1,
          },
          agentVersionId: capability.agentVersionId,
          agentVersionDigest: capability.agentVersionDigest,
          snapshotDigest: 'e'.repeat(64),
          deadlineAt: capability.expiresAt,
          executionCapability: capability,
        },
      };

      const validators = await target.query<{
        capability_null: boolean;
        frame_empty: boolean;
        frame_required_null: boolean;
        receipt_empty: boolean;
        receipt_required_null: boolean;
      }>(`
        SELECT
          creator_agent_execution_capability_wire_v1_is_safe(
            jsonb_build_object(
              'protocol', null, 'schemaVersion', null, 'capabilityId', null,
              'invocationId', null, 'conversationId', null, 'deploymentId', null,
              'agentVersionId', null, 'agentVersionDigest', null,
              'workerInstallationId', null, 'leaseId', null, 'fence', null,
              'providerRequestId', null, 'requestDigest', null, 'model', null,
              'reasoningEffort', null, 'budget', null, 'notBefore', null,
              'expiresAt', null, 'nonce', null, 'signatureAlgorithm', null,
              'signatureEncoding', null, 'signature', null
            )
          ) AS capability_null,
          creator_agent_gateway_lifecycle_frame_v2_is_safe('{}'::jsonb) AS frame_empty,
          creator_agent_gateway_lifecycle_frame_v2_is_safe(
            jsonb_build_object(
              'protocol', null, 'schemaVersion', null, 'kind', null, 'type', null,
              'messageId', null, 'correlationId', null, 'connectionId', null,
              'sequence', null, 'sentAt', null, 'expiresAt', null,
              'lease', null, 'body', null
            )
          ) AS frame_required_null,
          creator_agent_gateway_lifecycle_claim_receipt_v2_is_safe('{}'::jsonb)
            AS receipt_empty,
          creator_agent_gateway_lifecycle_claim_receipt_v2_is_safe(
            '{"sessionId":null,"commandId":null,"sequence":null,"canonicalDigest":null}'::jsonb
          ) AS receipt_required_null
      `);
      expect(validators.rows[0]).toEqual({
        capability_null: false,
        frame_empty: false,
        frame_required_null: false,
        receipt_empty: false,
        receipt_required_null: false,
      });

      const strictValidators = await target.query<{
        capability_valid: boolean;
        schema_version_string: boolean;
        fence_number: boolean;
        model_number: boolean;
        model_empty: boolean;
        model_max: boolean;
        model_too_long: boolean;
        model_leading_dash: boolean;
        model_unicode: boolean;
        model_quote: boolean;
        model_backslash: boolean;
        frame_valid: boolean;
        ciphertext_invalid_character: boolean;
        ciphertext_too_short: boolean;
        ciphertext_too_long: boolean;
        connection_null: boolean;
        key_id_null: boolean;
        cipher_digest_null: boolean;
      }>(
        `
        SELECT
          creator_agent_execution_capability_wire_v1_is_safe($1::jsonb)
            AS capability_valid,
          creator_agent_execution_capability_wire_v1_is_safe(
            jsonb_set($1::jsonb, '{schemaVersion}', '"1"'::jsonb)
          ) AS schema_version_string,
          creator_agent_execution_capability_wire_v1_is_safe(
            jsonb_set($1::jsonb, '{fence}', '7'::jsonb)
          ) AS fence_number,
          creator_agent_execution_capability_wire_v1_is_safe(
            jsonb_set($1::jsonb, '{model}', '123'::jsonb)
          ) AS model_number,
          creator_agent_execution_capability_wire_v1_is_safe(
            jsonb_set($1::jsonb, '{model}', to_jsonb(''::text))
          ) AS model_empty,
          creator_agent_execution_capability_wire_v1_is_safe(
            jsonb_set($1::jsonb, '{model}', to_jsonb('a' || repeat('b', 127)))
          ) AS model_max,
          creator_agent_execution_capability_wire_v1_is_safe(
            jsonb_set($1::jsonb, '{model}', to_jsonb('a' || repeat('b', 128)))
          ) AS model_too_long,
          creator_agent_execution_capability_wire_v1_is_safe(
            jsonb_set($1::jsonb, '{model}', to_jsonb('-leading'::text))
          ) AS model_leading_dash,
          creator_agent_execution_capability_wire_v1_is_safe(
            jsonb_set($1::jsonb, '{model}', to_jsonb('模型/test'::text))
          ) AS model_unicode,
          creator_agent_execution_capability_wire_v1_is_safe(
            jsonb_set($1::jsonb, '{model}', to_jsonb('bad"model'::text))
          ) AS model_quote,
          creator_agent_execution_capability_wire_v1_is_safe(
            jsonb_set($1::jsonb, '{model}', to_jsonb(E'bad\\\\model'::text))
          ) AS model_backslash,
          creator_agent_gateway_lifecycle_frame_v2_is_safe($2::jsonb)
            AS frame_valid,
          creator_agent_gateway_lifecycle_frame_v2_is_safe(
            jsonb_set($2::jsonb, '{body,userMessageCiphertext,ciphertext}', to_jsonb('e+'::text))
          ) AS ciphertext_invalid_character,
          creator_agent_gateway_lifecycle_frame_v2_is_safe(
            jsonb_set($2::jsonb, '{body,userMessageCiphertext,ciphertext}', to_jsonb('e'::text))
          ) AS ciphertext_too_short,
          creator_agent_gateway_lifecycle_frame_v2_is_safe(
            jsonb_set(
              $2::jsonb,
              '{body,userMessageCiphertext,ciphertext}',
              to_jsonb(repeat('A', 61441))
            )
          ) AS ciphertext_too_long,
          creator_agent_gateway_lifecycle_frame_v2_is_safe(
            jsonb_set($2::jsonb, '{connectionId}', 'null'::jsonb)
          ) AS connection_null,
          creator_agent_gateway_lifecycle_frame_v2_is_safe(
            jsonb_set($2::jsonb, '{body,userMessageCiphertext,keyId}', 'null'::jsonb)
          ) AS key_id_null,
          creator_agent_gateway_lifecycle_frame_v2_is_safe(
            jsonb_set($2::jsonb, '{body,userMessageCiphertext,cipherDigest}', 'null'::jsonb)
          ) AS cipher_digest_null
      `,
        [capability, prepareFrame],
      );
      expect(strictValidators.rows[0]).toEqual({
        capability_valid: true,
        schema_version_string: false,
        fence_number: false,
        model_number: false,
        model_empty: false,
        model_max: true,
        model_too_long: false,
        model_leading_dash: false,
        model_unicode: false,
        model_quote: false,
        model_backslash: false,
        frame_valid: true,
        ciphertext_invalid_character: false,
        ciphertext_too_short: false,
        ciphertext_too_long: false,
        connection_null: false,
        key_id_null: false,
        cipher_digest_null: false,
      });

      const authority = await target.query<{
        trusted_functions: string;
        consumer_preflight: boolean;
        consumer_finalize: boolean;
        consumer_legacy_accept: boolean;
        api_legacy_admit: boolean;
        consumer_lock: boolean;
        consumer_direct_dml: boolean;
        v2_unique: boolean;
        canonical_text: boolean;
        capability_acl_exact: boolean;
      }>(`
        SELECT
          (
            SELECT count(*)::text
              FROM pg_proc AS procedure
              JOIN pg_roles AS owner ON owner.oid = procedure.proowner
             WHERE procedure.oid = ANY(ARRAY[
               'creator_agent_issue_runtime_product_ids_v2(integer)'::regprocedure,
               'creator_agent_preflight_consumer_message_v2(uuid,uuid,text,text)'::regprocedure,
              'creator_agent_finalize_consumer_message_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer,jsonb,text)'::regprocedure,
              'creator_agent_lock_gateway_lifecycle_command_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint)'::regprocedure,
              'creator_agent_gateway_lifecycle_v2_ready()'::regprocedure
             ])
               AND procedure.prosecdef
               AND (owner.rolsuper OR owner.rolbypassrls)
          ) AS trusted_functions,
          has_function_privilege(
            'combo_agent_consumer_api',
            'creator_agent_preflight_consumer_message_v2(uuid,uuid,text,text)', 'EXECUTE'
          ) AS consumer_preflight,
          has_function_privilege(
            'combo_agent_consumer_api',
            'creator_agent_finalize_consumer_message_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer,jsonb,text)',
            'EXECUTE'
          ) AS consumer_finalize,
          has_function_privilege(
            'combo_agent_consumer_api',
            'creator_agent_accept_consumer_message_v1(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer)',
            'EXECUTE'
          ) AS consumer_legacy_accept,
          has_function_privilege(
            'combo_agent_api',
            'creator_agent_admit_user_message_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)',
            'EXECUTE'
          ) AS api_legacy_admit,
          has_function_privilege(
            'combo_agent_consumer_api',
            'creator_agent_lock_gateway_lifecycle_command_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint)',
            'EXECUTE'
          ) AS consumer_lock,
          has_table_privilege(
            'combo_agent_consumer_api', 'agent_invocations', 'INSERT,UPDATE,DELETE'
          ) AS consumer_direct_dml,
          to_regclass('uq_worker_gateway_outbound_lifecycle_per_session') IS NOT NULL AS v2_unique,
          EXISTS (
            SELECT 1
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'worker_gateway_outbound_frames'
               AND column_name = 'wire_canonical_text'
          ) AS canonical_text,
          has_function_privilege(
            'combo_agent_api',
            'creator_agent_execution_capability_wire_v1_is_safe(jsonb)', 'EXECUTE'
          )
          AND has_function_privilege(
            'combo_agent_broker',
            'creator_agent_execution_capability_wire_v1_is_safe(jsonb)', 'EXECUTE'
          )
          AND has_function_privilege(
            'combo_agent_reconciler',
            'creator_agent_execution_capability_wire_v1_is_safe(jsonb)', 'EXECUTE'
          )
          AND NOT has_function_privilege(
            'combo_agent_consumer_api',
            'creator_agent_execution_capability_wire_v1_is_safe(jsonb)', 'EXECUTE'
          )
          AND has_function_privilege(
            'combo_agent_api',
            'creator_agent_execution_capability_wire_v1_digest(jsonb)', 'EXECUTE'
          )
          AND has_function_privilege(
            'combo_agent_broker',
            'creator_agent_execution_capability_wire_v1_digest(jsonb)', 'EXECUTE'
          )
          AND has_function_privilege(
            'combo_agent_reconciler',
            'creator_agent_execution_capability_wire_v1_digest(jsonb)', 'EXECUTE'
          )
          AND NOT has_function_privilege(
            'combo_agent_consumer_api',
            'creator_agent_execution_capability_wire_v1_digest(jsonb)', 'EXECUTE'
          )
          AND has_function_privilege(
            'combo_agent_broker',
            'creator_agent_execution_capability_wire_v1_canonical_text(jsonb)', 'EXECUTE'
          )
          AND NOT has_function_privilege(
            'combo_agent_api',
            'creator_agent_execution_capability_wire_v1_canonical_text(jsonb)', 'EXECUTE'
          )
          AND NOT has_function_privilege(
            'combo_agent_reconciler',
            'creator_agent_execution_capability_wire_v1_canonical_text(jsonb)', 'EXECUTE'
          )
          AND has_function_privilege(
            'combo_agent_broker',
            'creator_agent_gateway_lifecycle_frame_v2_is_safe(jsonb)', 'EXECUTE'
          )
          AND NOT has_function_privilege(
            'combo_agent_api',
            'creator_agent_gateway_lifecycle_frame_v2_is_safe(jsonb)', 'EXECUTE'
          ) AS capability_acl_exact
      `);
      expect(authority.rows[0]).toEqual({
        trusted_functions: '5',
        consumer_preflight: true,
        consumer_finalize: true,
        consumer_legacy_accept: false,
        api_legacy_admit: true,
        consumer_lock: false,
        consumer_direct_dml: false,
        v2_unique: true,
        canonical_text: true,
        capability_acl_exact: true,
      });

      await target.query(`SET SESSION AUTHORIZATION combo_agent_consumer_api`);
      try {
        await expect(
          target.query<{ count: string; exact: boolean }>(`
            SELECT count(*)::text AS count,
                   bool_and(
                     ordinal BETWEEN 1 AND 8
                     AND id::text ~
                       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                   ) AS exact
              FROM creator_agent_issue_runtime_product_ids_v2(8)
          `),
        ).resolves.toMatchObject({ rows: [{ count: '8', exact: true }] });
        await target.query(`SELECT set_config('app.consumer_id', $1, false)`, [
          '01900000-0000-7000-8000-000000000109',
        ]);
        await expect(
          target.query(
            `SELECT * FROM creator_agent_finalize_consumer_message_v2(
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               $11,$12,$13,$14,$15,$16,$17,$18,$19,$20
             )`,
            [
              capability.conversationId,
              '01900000-0000-7000-8000-000000000109',
              '01900000-0000-7000-8000-000000000110',
              capability.invocationId,
              '01900000-0000-7000-8000-000000000111',
              '01900000-0000-7000-8000-000000000112',
              '01900000-0000-7000-8000-000000000113',
              '01900000-0000-7000-8000-000000000114',
              '00000000-0000-4000-8000-000000000001',
              capability.requestDigest,
              'aes-256-gcm/v1',
              'owner-key-v1',
              Buffer.alloc(12, 1),
              Buffer.from('x'),
              Buffer.alloc(16, 2),
              'c'.repeat(64),
              `hmac-sha256:${'d'.repeat(64)}`,
              1,
              capability,
              '0'.repeat(64),
            ],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await target.query(`RESET SESSION AUTHORIZATION`);
      }

      await expectBrokerLifecycleAuthorityExact(target);

      for (const roleAttribute of [
        { enable: 'SUPERUSER', disable: 'NOSUPERUSER' },
        { enable: 'INHERIT', disable: 'NOINHERIT' },
        { enable: 'CREATEROLE', disable: 'NOCREATEROLE' },
        { enable: 'CREATEDB', disable: 'NOCREATEDB' },
        { enable: 'NOLOGIN', disable: 'LOGIN' },
        { enable: 'REPLICATION', disable: 'NOREPLICATION' },
        { enable: 'BYPASSRLS', disable: 'NOBYPASSRLS' },
      ] as const) {
        await target.query(`ALTER ROLE combo_agent_broker ${roleAttribute.enable}`);
        try {
          await expectBrokerLifecycleAuthorityDenied(target);
        } finally {
          await target.query(`ALTER ROLE combo_agent_broker ${roleAttribute.disable}`);
        }
        await expectBrokerLifecycleAuthorityExact(target);
      }

      await target.query(
        `CREATE ROLE combo_r3_broker_acl_probe
           NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      for (const membership of [
        {
          grant: `GRANT combo_r3_broker_acl_probe TO combo_agent_broker`,
          revoke: `REVOKE combo_r3_broker_acl_probe FROM combo_agent_broker`,
        },
        {
          grant: `GRANT combo_agent_broker TO combo_r3_broker_acl_probe`,
          revoke: `REVOKE combo_agent_broker FROM combo_r3_broker_acl_probe`,
        },
      ]) {
        await target.query(membership.grant);
        try {
          await expectBrokerLifecycleAuthorityDenied(target);
        } finally {
          await target.query(membership.revoke);
        }
        await expectBrokerLifecycleAuthorityExact(target);
      }

      for (const aclMutation of [
        {
          grant: `GRANT CREATE ON DATABASE "${databaseName}" TO combo_agent_broker`,
          revoke: `REVOKE CREATE ON DATABASE "${databaseName}" FROM combo_agent_broker`,
        },
        {
          grant: `GRANT CREATE ON SCHEMA public TO combo_agent_broker`,
          revoke: `REVOKE CREATE ON SCHEMA public FROM combo_agent_broker`,
        },
        {
          grant: `GRANT DELETE ON public.broker_outbox TO combo_agent_broker`,
          revoke: `REVOKE DELETE ON public.broker_outbox FROM combo_agent_broker`,
        },
        {
          grant:
            `GRANT UPDATE ON SEQUENCE public.agent_invocation_events_id_seq ` +
            `TO combo_agent_broker`,
          revoke:
            `REVOKE UPDATE ON SEQUENCE public.agent_invocation_events_id_seq ` +
            `FROM combo_agent_broker`,
        },
      ]) {
        await target.query(aclMutation.grant);
        try {
          await expectBrokerLifecycleAuthorityDenied(target);
        } finally {
          await target.query(aclMutation.revoke);
        }
        await expectBrokerLifecycleAuthorityExact(target);
      }

      await target.query(`REVOKE SELECT ON public.broker_outbox FROM combo_agent_broker`);
      try {
        await expectBrokerLifecycleAuthorityDenied(target);
      } finally {
        await target.query(`GRANT SELECT ON public.broker_outbox TO combo_agent_broker`);
      }
      await expectBrokerLifecycleAuthorityExact(target);

      await target.query(`
        CREATE FUNCTION public.creator_agent_gateway_acl_drift_probe()
        RETURNS boolean
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = pg_catalog
        AS 'SELECT true';
        REVOKE ALL ON FUNCTION public.creator_agent_gateway_acl_drift_probe() FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION public.creator_agent_gateway_acl_drift_probe()
          TO combo_agent_broker
      `);
      try {
        await expectBrokerLifecycleAuthorityDenied(target);
      } finally {
        await target.query(`DROP FUNCTION public.creator_agent_gateway_acl_drift_probe()`);
      }
      await expectBrokerLifecycleAuthorityExact(target);
    } finally {
      await target?.end().catch(() => undefined);
      const keyword = (enabled: boolean, positive: string, negative: string): string =>
        enabled ? positive : negative;
      try {
        await admin.query(`DROP ROLE IF EXISTS combo_r3_broker_acl_probe`);
        await admin.query(
          originalRoles
            .map(
              (role) => `
          ALTER ROLE "${role.rolname}"
            ${keyword(role.rolsuper, 'SUPERUSER', 'NOSUPERUSER')}
            ${keyword(role.rolinherit, 'INHERIT', 'NOINHERIT')}
            ${keyword(role.rolcreaterole, 'CREATEROLE', 'NOCREATEROLE')}
            ${keyword(role.rolcreatedb, 'CREATEDB', 'NOCREATEDB')}
            ${keyword(role.rolcanlogin, 'LOGIN', 'NOLOGIN')}
            ${keyword(role.rolreplication, 'REPLICATION', 'NOREPLICATION')}
            ${keyword(role.rolbypassrls, 'BYPASSRLS', 'NOBYPASSRLS')}
        `,
            )
            .join(';'),
        );
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await admin
          .query(`SELECT pg_advisory_unlock(hashtext('combo-runtime-product-role-state'))`)
          .catch(() => undefined);
        await admin.end();
      }
    }
  }, 120_000);
});
