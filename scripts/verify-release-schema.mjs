#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONTRACT_VERSION = 'combo-schema-0008-v1';
const EXPECTED_MIGRATION_HEAD = '0008_application_database_roles.sql';
const ENVIRONMENT_NAMESPACES = Object.freeze({
  preview: 'combo-review',
  production: 'combo',
});

const MIGRATIONS = Object.freeze([
  '0000_baseline_schema.sql',
  '0001_expired_upload_reconciliation.sql',
  '0002_drop_stream_events.sql',
  '0003_turns.sql',
  '0004_studio_sessions.sql',
  '0005_capability_current_ui.sql',
  '0006_one_running_turn_per_session.sql',
  '0007_first_party_email_auth.sql',
  EXPECTED_MIGRATION_HEAD,
]);

const RELATIONS = Object.freeze(
  [
    'artifacts',
    'audit_llm_calls',
    'auth_audit_events',
    'auth_identities',
    'auth_otp_challenges',
    'auth_sessions',
    'capabilities',
    'messages',
    'schema_migrations',
    'sessions',
    'tasks',
    'turns',
    'uploads',
    'users',
  ].sort(),
);

function column(table, name, type, nullable = false) {
  return `${table}|${name}|pg_catalog.${type}|${nullable ? 'nullable' : 'required'}`;
}

const COLUMNS = Object.freeze(
  [
    column('schema_migrations', 'filename', 'text'),
    column('schema_migrations', 'applied_at', 'timestamptz'),

    column('users', 'id', 'uuid'),
    column('users', 'account', 'text'),
    column('users', 'roles', '_text'),
    column('users', 'created_at', 'timestamptz'),
    column('users', 'last_login_at', 'timestamptz', true),
    column('users', 'disabled_at', 'timestamptz', true),

    column('tasks', 'id', 'uuid'),
    column('tasks', 'owner_user_id', 'uuid'),
    column('tasks', 'current_step', 'text'),
    column('tasks', 'status', 'text'),
    column('tasks', 'description', 'text', true),
    column('tasks', 'meta', 'jsonb'),
    column('tasks', 'retry_count', 'int4'),
    column('tasks', 'last_error', 'jsonb', true),
    column('tasks', 'lease_owner', 'text', true),
    column('tasks', 'lease_expires_at', 'timestamptz', true),
    column('tasks', 'idempotency_key', 'text'),
    column('tasks', 'created_at', 'timestamptz'),
    column('tasks', 'updated_at', 'timestamptz'),

    column('uploads', 'task_id', 'uuid'),
    column('uploads', 'storage_key', 'text', true),
    column('uploads', 'status', 'text'),
    column('uploads', 'pairing_code_hash', 'text'),
    column('uploads', 'pairing_expires_at', 'timestamptz'),
    column('uploads', 'parts', 'jsonb'),
    column('uploads', 'raw_purged_at', 'timestamptz', true),
    column('uploads', 'meta', 'jsonb'),
    column('uploads', 'created_at', 'timestamptz'),
    column('uploads', 'updated_at', 'timestamptz'),

    column('capabilities', 'id', 'uuid'),
    column('capabilities', 'task_id', 'uuid'),
    column('capabilities', 'owner_user_id', 'uuid'),
    column('capabilities', 'name', 'text'),
    column('capabilities', 'summary', 'text'),
    column('capabilities', 'kind', 'text'),
    column('capabilities', 'storage_key', 'text'),
    column('capabilities', 'published', 'bool'),
    column('capabilities', 'published_at', 'timestamptz', true),
    column('capabilities', 'share_token', 'text', true),
    column('capabilities', 'meta', 'jsonb'),
    column('capabilities', 'created_at', 'timestamptz'),
    column('capabilities', 'updated_at', 'timestamptz'),
    column('capabilities', 'ui_artifact_id', 'uuid', true),

    column('sessions', 'id', 'uuid'),
    column('sessions', 'capability_id', 'uuid'),
    column('sessions', 'owner_user_id', 'uuid'),
    column('sessions', 'title', 'text', true),
    column('sessions', 'status', 'text'),
    column('sessions', 'created_at', 'timestamptz'),
    column('sessions', 'updated_at', 'timestamptz'),
    column('sessions', 'mode', 'text'),

    column('turns', 'id', 'uuid'),
    column('turns', 'session_id', 'uuid'),
    column('turns', 'status', 'text'),
    column('turns', 'last_error', 'jsonb', true),
    column('turns', 'created_at', 'timestamptz'),
    column('turns', 'finished_at', 'timestamptz', true),

    column('messages', 'id', 'uuid'),
    column('messages', 'session_id', 'uuid'),
    column('messages', 'seq', 'int4', true),
    column('messages', 'role', 'text'),
    column('messages', 'content', 'jsonb'),
    column('messages', 'status', 'text'),
    column('messages', 'created_at', 'timestamptz'),
    column('messages', 'turn_id', 'uuid', true),
    column('messages', 'idx', 'int4', true),

    column('artifacts', 'id', 'uuid'),
    column('artifacts', 'session_id', 'uuid'),
    column('artifacts', 'message_id', 'uuid', true),
    column('artifacts', 'kind', 'text'),
    column('artifacts', 'title', 'text', true),
    column('artifacts', 'storage_key', 'text'),
    column('artifacts', 'meta', 'jsonb'),
    column('artifacts', 'created_at', 'timestamptz'),
    column('artifacts', 'updated_at', 'timestamptz'),
    column('artifacts', 'turn_id', 'uuid', true),

    column('audit_llm_calls', 'id', 'uuid'),
    column('audit_llm_calls', 'owner_user_id', 'uuid', true),
    column('audit_llm_calls', 'task_id', 'uuid', true),
    column('audit_llm_calls', 'task_class', 'text'),
    column('audit_llm_calls', 'model', 'text', true),
    column('audit_llm_calls', 'prompt_tokens', 'int4'),
    column('audit_llm_calls', 'completion_tokens', 'int4'),
    column('audit_llm_calls', 'cost_micros', 'int8'),
    column('audit_llm_calls', 'degraded', 'bool'),
    column('audit_llm_calls', 'retries', 'int4'),
    column('audit_llm_calls', 'trace_id', 'text', true),
    column('audit_llm_calls', 'created_at', 'timestamptz'),

    column('auth_identities', 'id', 'uuid'),
    column('auth_identities', 'user_id', 'uuid'),
    column('auth_identities', 'provider', 'text'),
    column('auth_identities', 'issuer', 'text'),
    column('auth_identities', 'subject', 'text'),
    column('auth_identities', 'verified_at', 'timestamptz'),
    column('auth_identities', 'created_at', 'timestamptz'),
    column('auth_identities', 'updated_at', 'timestamptz'),

    column('auth_otp_challenges', 'id', 'uuid'),
    column('auth_otp_challenges', 'channel', 'text'),
    column('auth_otp_challenges', 'purpose', 'text'),
    column('auth_otp_challenges', 'initiated_by_user_id', 'uuid', true),
    column('auth_otp_challenges', 'target_digest', 'bytea'),
    column('auth_otp_challenges', 'code_digest', 'bytea'),
    column('auth_otp_challenges', 'attempt_count', 'int2'),
    column('auth_otp_challenges', 'max_attempts', 'int2'),
    column('auth_otp_challenges', 'created_at', 'timestamptz'),
    column('auth_otp_challenges', 'activated_at', 'timestamptz', true),
    column('auth_otp_challenges', 'expires_at', 'timestamptz'),
    column('auth_otp_challenges', 'consumed_at', 'timestamptz', true),
    column('auth_otp_challenges', 'invalidated_at', 'timestamptz', true),

    column('auth_sessions', 'id', 'uuid'),
    column('auth_sessions', 'user_id', 'uuid'),
    column('auth_sessions', 'token_digest', 'bytea'),
    column('auth_sessions', 'auth_method', 'text'),
    column('auth_sessions', 'authenticated_at', 'timestamptz'),
    column('auth_sessions', 'created_at', 'timestamptz'),
    column('auth_sessions', 'expires_at', 'timestamptz'),
    column('auth_sessions', 'revoked_at', 'timestamptz', true),

    column('auth_audit_events', 'id', 'uuid'),
    column('auth_audit_events', 'user_id', 'uuid', true),
    column('auth_audit_events', 'event_type', 'text'),
    column('auth_audit_events', 'outcome', 'text'),
    column('auth_audit_events', 'auth_method', 'text', true),
    column('auth_audit_events', 'target_digest', 'bytea', true),
    column('auth_audit_events', 'session_id', 'uuid', true),
    column('auth_audit_events', 'trace_id', 'text'),
    column('auth_audit_events', 'details', 'jsonb'),
    column('auth_audit_events', 'created_at', 'timestamptz'),
  ].sort(),
);

const CONSTRAINTS = Object.freeze(
  [
    'fk_artifacts_turn_session|artifacts|foreign|turn_id,session_id|turns|id,session_id|cascade|not-deferrable',
    'fk_messages_turn_session|messages|foreign|turn_id,session_id|turns|id,session_id|no-action|not-deferrable',
    'uq_turns_id_session|turns|unique|id,session_id||||not-deferrable',
  ].sort(),
);

const INDEXES = Object.freeze(
  [
    'idx_artifacts_turn|artifacts|non-unique|turn_id|(turn_idISNOTNULL)',
    'idx_auth_audit_target_recent|auth_audit_events|non-unique|target_digest,created_at|(target_digestISNOTNULL)',
    'idx_auth_sessions_user_live|auth_sessions|non-unique|user_id,expires_at|(revoked_atISNULL)',
    'idx_messages_turn|messages|non-unique|turn_id|(turn_idISNOTNULL)',
    "idx_sessions_owner_mode|sessions|non-unique|owner_user_id,mode,updated_at|(status='active'::text)",
    "idx_tasks_claimable|tasks|non-unique|lease_expires_at|(status='running'::text)",
    "idx_turns_running|turns|non-unique|created_at|(status='running'::text)",
    "idx_uploads_expired_unpurged|uploads|non-unique|updated_at,task_id|((status='expired'::text)AND(raw_purged_atISNULL))",
    "idx_uploads_pending_expiry|uploads|non-unique|pairing_expires_at,task_id|(status='pending'::text)",
    'uq_auth_otp_unfinished_target|auth_otp_challenges|unique|channel,purpose,target_digest|((activated_atISNOTNULL)AND(consumed_atISNULL)AND(invalidated_atISNULL))',
    'uq_capabilities_ui_artifact|capabilities|unique|ui_artifact_id|(ui_artifact_idISNOTNULL)',
    'uq_messages_turn_idx|messages|unique|turn_id,idx|(turn_idISNOTNULL)',
    "uq_sessions_active_studio_owner_capability|sessions|unique|owner_user_id,capability_id|((status='active'::text)AND(mode='studio'::text))",
    "uq_turns_session_running|turns|unique|session_id|(status='running'::text)",
  ].sort(),
);

const FUNCTIONS = Object.freeze(['gen_uuid_v7|uuid|plpgsql|volatile|0']);

const ROLES = Object.freeze(
  ['combo_api', 'combo_runtime', 'combo_worker']
    .map(
      (role) =>
        `${role}|login|no-superuser|no-createdb|no-createrole|no-inherit|no-replication|no-bypassrls`,
    )
    .sort(),
);

const API_TABLES = Object.freeze([
  'audit_llm_calls',
  'auth_audit_events',
  'auth_identities',
  'auth_otp_challenges',
  'auth_sessions',
  'capabilities',
  'tasks',
  'uploads',
  'users',
]);
const WORKER_TABLES = Object.freeze(['audit_llm_calls', 'capabilities', 'tasks', 'uploads']);
const RUNTIME_WRITE_TABLES = Object.freeze(['artifacts', 'messages', 'sessions', 'turns']);

const GRANTS = Object.freeze(
  [
    ...API_TABLES.flatMap((table) =>
      ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map(
        (privilege) => `table|combo_api|${table}|${privilege}`,
      ),
    ),
    ...WORKER_TABLES.flatMap((table) =>
      ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map(
        (privilege) => `table|combo_worker|${table}|${privilege}`,
      ),
    ),
    ...['auth_sessions', 'capabilities', 'users'].map(
      (table) => `table|combo_runtime|${table}|SELECT`,
    ),
    ...RUNTIME_WRITE_TABLES.flatMap((table) =>
      ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map(
        (privilege) => `table|combo_runtime|${table}|${privilege}`,
      ),
    ),
    'column|combo_runtime|capabilities.ui_artifact_id|UPDATE',
    'function|combo_api|gen_uuid_v7()|EXECUTE',
    'function|combo_runtime|gen_uuid_v7()|EXECUTE',
    'function|combo_worker|gen_uuid_v7()|EXECUTE',
    'schema|PUBLIC|public|USAGE',
    'schema|combo_api|public|USAGE',
    'schema|combo_runtime|public|USAGE',
    'schema|combo_worker|public|USAGE',
  ].sort(),
);

export const SCHEMA_CONTRACT = Object.freeze({
  ledger: MIGRATIONS,
  relations: RELATIONS,
  columns: COLUMNS,
  constraints: CONSTRAINTS,
  indexes: INDEXES,
  functions: FUNCTIONS,
  roles: ROLES,
  grants: GRANTS,
});

const ACTUAL_KEYS = Object.freeze([
  'columns',
  'constraints',
  'functions',
  'grants',
  'indexes',
  'ledger',
  'relations',
  'roles',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set([
    '--environment',
    '--namespace',
    '--source-sha',
    '--migration-head',
    '--output',
  ]);

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith('--')) {
      throw new Error('invalid arguments');
    }
    if (Object.hasOwn(values, flag)) throw new Error('duplicate argument');
    values[flag] = value;
  }

  if (Object.keys(values).length !== allowed.size) throw new Error('missing argument');

  const environment = values['--environment'];
  const namespace = values['--namespace'];
  const sourceSha = values['--source-sha'];
  const migrationHead = values['--migration-head'];
  const output = values['--output'];

  if (!Object.hasOwn(ENVIRONMENT_NAMESPACES, environment)) {
    throw new Error('invalid environment');
  }
  if (namespace !== ENVIRONMENT_NAMESPACES[environment]) {
    throw new Error('environment namespace mismatch');
  }
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('invalid source sha');
  if (migrationHead !== EXPECTED_MIGRATION_HEAD) throw new Error('invalid migration head');
  if (!output || output.includes('\0')) throw new Error('invalid output');

  return { environment, namespace, sourceSha, migrationHead, output: resolve(output) };
}

function sqlArray(expression, fromClause, whereClause = '') {
  return `(
    SELECT COALESCE(json_agg(value ORDER BY value), '[]'::json)
      FROM (
        SELECT ${expression} AS value
          ${fromClause}
          ${whereClause}
      ) facts
  )`;
}

export function buildCatalogQuery() {
  const constraints = [
    'fk_artifacts_turn_session',
    'fk_messages_turn_session',
    'uq_turns_id_session',
  ]
    .map((name) => `'${name}'`)
    .join(', ');

  return String.raw`\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT json_build_object(
  'ledger',
  ${sqlArray('filename', 'FROM public.schema_migrations')},
  'relations',
  ${sqlArray(
    'relation.relname',
    `FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace`,
    `WHERE namespace.nspname = 'public'
           AND relation.relkind IN ('r', 'p')`,
  )},
  'columns',
  ${sqlArray(
    `columns.table_name || '|' || columns.column_name || '|' ||
         columns.udt_schema || '.' || columns.udt_name || '|' ||
         CASE WHEN columns.is_nullable = 'YES' THEN 'nullable' ELSE 'required' END`,
    'FROM information_schema.columns',
    `WHERE columns.table_schema = 'public'`,
  )},
  'constraints',
  ${sqlArray(
    `constraint_record.conname || '|' || source_relation.relname || '|' ||
         CASE constraint_record.contype
           WHEN 'f' THEN 'foreign'
           WHEN 'u' THEN 'unique'
           ELSE 'unsupported'
         END || '|' ||
         (
           SELECT string_agg(attribute.attname, ',' ORDER BY key_column.ordinality)
             FROM unnest(constraint_record.conkey) WITH ORDINALITY key_column(attnum, ordinality)
             JOIN pg_catalog.pg_attribute attribute
               ON attribute.attrelid = constraint_record.conrelid
              AND attribute.attnum = key_column.attnum
         ) || '|' ||
         CASE
           WHEN constraint_record.contype = 'f' THEN referenced_relation.relname
           ELSE ''
         END || '|' ||
         CASE
           WHEN constraint_record.contype = 'f' THEN (
             SELECT string_agg(attribute.attname, ',' ORDER BY key_column.ordinality)
               FROM unnest(constraint_record.confkey)
                    WITH ORDINALITY key_column(attnum, ordinality)
               JOIN pg_catalog.pg_attribute attribute
                 ON attribute.attrelid = constraint_record.confrelid
                AND attribute.attnum = key_column.attnum
           )
           ELSE ''
         END || '|' ||
         CASE
           WHEN constraint_record.contype <> 'f' THEN ''
           WHEN constraint_record.confdeltype = 'c' THEN 'cascade'
           WHEN constraint_record.confdeltype = 'a' THEN 'no-action'
           ELSE 'unsupported'
         END || '|' ||
         CASE
           WHEN constraint_record.condeferrable THEN 'deferrable'
           ELSE 'not-deferrable'
         END`,
    `FROM pg_catalog.pg_constraint constraint_record
         JOIN pg_catalog.pg_class source_relation
           ON source_relation.oid = constraint_record.conrelid
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = source_relation.relnamespace
         LEFT JOIN pg_catalog.pg_class referenced_relation
           ON referenced_relation.oid = constraint_record.confrelid`,
    `WHERE namespace.nspname = 'public'
           AND constraint_record.conname IN (${constraints})`,
  )},
  'indexes',
  ${sqlArray(
    `index_relation.relname || '|' || table_relation.relname || '|' ||
         CASE WHEN index_record.indisunique THEN 'unique' ELSE 'non-unique' END || '|' ||
         (
           SELECT string_agg(attribute.attname, ',' ORDER BY key_column.ordinality)
             FROM unnest(index_record.indkey::smallint[])
                  WITH ORDINALITY key_column(attnum, ordinality)
             JOIN pg_catalog.pg_attribute attribute
               ON attribute.attrelid = index_record.indrelid
              AND attribute.attnum = key_column.attnum
            WHERE key_column.ordinality <= index_record.indnkeyatts
         ) || '|' ||
         regexp_replace(
           pg_catalog.pg_get_expr(index_record.indpred, index_record.indrelid),
           '[[:space:]]',
           '',
           'g'
         )`,
    `FROM pg_catalog.pg_index index_record
         JOIN pg_catalog.pg_class index_relation
           ON index_relation.oid = index_record.indexrelid
         JOIN pg_catalog.pg_class table_relation
           ON table_relation.oid = index_record.indrelid
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = table_relation.relnamespace`,
    `WHERE namespace.nspname = 'public'
           AND index_record.indpred IS NOT NULL`,
  )},
  'functions',
  ${sqlArray(
    `function_record.proname || '|'
         || return_type.typname || '|'
         || language.lanname || '|'
         || CASE function_record.provolatile
              WHEN 'v' THEN 'volatile'
              WHEN 's' THEN 'stable'
              WHEN 'i' THEN 'immutable'
              ELSE 'unsupported'
            END || '|'
         || function_record.pronargs::text`,
    `FROM pg_catalog.pg_proc function_record
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = function_record.pronamespace
         JOIN pg_catalog.pg_type return_type
           ON return_type.oid = function_record.prorettype
         JOIN pg_catalog.pg_language language
           ON language.oid = function_record.prolang`,
    `WHERE namespace.nspname = 'public'
           AND function_record.proname = 'gen_uuid_v7'`,
  )},
  'roles',
  ${sqlArray(
    `role_record.rolname || '|' ||
         CASE WHEN role_record.rolcanlogin THEN 'login' ELSE 'no-login' END || '|' ||
         CASE WHEN role_record.rolsuper THEN 'superuser' ELSE 'no-superuser' END || '|' ||
         CASE WHEN role_record.rolcreatedb THEN 'createdb' ELSE 'no-createdb' END || '|' ||
         CASE WHEN role_record.rolcreaterole THEN 'createrole' ELSE 'no-createrole' END || '|' ||
         CASE WHEN role_record.rolinherit THEN 'inherit' ELSE 'no-inherit' END || '|' ||
         CASE WHEN role_record.rolreplication THEN 'replication' ELSE 'no-replication' END || '|' ||
         CASE WHEN role_record.rolbypassrls THEN 'bypassrls' ELSE 'no-bypassrls' END`,
    'FROM pg_catalog.pg_roles role_record',
    `WHERE role_record.rolname IN ('combo_api', 'combo_worker', 'combo_runtime')`,
  )},
  'grants',
  (
    SELECT COALESCE(json_agg(value ORDER BY value), '[]'::json)
      FROM (
        SELECT 'table|' || COALESCE(grantee.rolname, 'PUBLIC') || '|' ||
               relation.relname || '|' ||
               table_acl.privilege_type AS value
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
          ) table_acl
          LEFT JOIN pg_catalog.pg_roles grantee
            ON grantee.oid = table_acl.grantee
         WHERE namespace.nspname = 'public'
           AND (
             table_acl.grantee = 0
             OR grantee.rolname IN ('combo_api', 'combo_worker', 'combo_runtime')
           )
        UNION ALL
        SELECT 'column|' || COALESCE(grantee.rolname, 'PUBLIC') || '|' ||
               relation.relname || '.' ||
               attribute.attname || '|' || column_acl.privilege_type
          FROM pg_catalog.pg_attribute attribute
          JOIN pg_catalog.pg_class relation
            ON relation.oid = attribute.attrelid
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) column_acl
          LEFT JOIN pg_catalog.pg_roles grantee
            ON grantee.oid = column_acl.grantee
         WHERE namespace.nspname = 'public'
           AND (
             column_acl.grantee = 0
             OR grantee.rolname IN ('combo_api', 'combo_worker', 'combo_runtime')
           )
        UNION ALL
        SELECT 'function|' || COALESCE(grantee.rolname, 'PUBLIC') ||
               '|gen_uuid_v7()|' ||
               function_acl.privilege_type
          FROM pg_catalog.pg_proc function_record
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = function_record.pronamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              function_record.proacl,
              pg_catalog.acldefault('f', function_record.proowner)
            )
          ) function_acl
          LEFT JOIN pg_catalog.pg_roles grantee
            ON grantee.oid = function_acl.grantee
         WHERE namespace.nspname = 'public'
           AND function_record.proname = 'gen_uuid_v7'
           AND function_record.pronargs = 0
           AND (
             function_acl.grantee = 0
             OR grantee.rolname IN ('combo_api', 'combo_worker', 'combo_runtime')
           )
        UNION ALL
        SELECT 'schema|' || COALESCE(grantee.rolname, 'PUBLIC') || '|public|' ||
               schema_acl.privilege_type
          FROM pg_catalog.pg_namespace namespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
          ) schema_acl
          LEFT JOIN pg_catalog.pg_roles grantee
            ON grantee.oid = schema_acl.grantee
         WHERE namespace.nspname = 'public'
           AND (
             schema_acl.grantee = 0
             OR grantee.rolname IN ('combo_api', 'combo_worker', 'combo_runtime')
           )
        UNION ALL
        SELECT 'membership|' || member_role.rolname || '|' || granted_role.rolname ||
               '|MEMBER'
          FROM pg_catalog.pg_auth_members membership
          JOIN pg_catalog.pg_roles member_role
            ON member_role.oid = membership.member
          JOIN pg_catalog.pg_roles granted_role
            ON granted_role.oid = membership.roleid
         WHERE member_role.rolname IN ('combo_api', 'combo_worker', 'combo_runtime')
      ) grant_facts
  )
);
COMMIT;
`;
}

function normalizeActual(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid catalog response');
  }
  const keys = Object.keys(raw).sort();
  if (canonicalJson(keys) !== canonicalJson(ACTUAL_KEYS)) {
    throw new Error('invalid catalog response keys');
  }

  const normalized = {};
  for (const key of ACTUAL_KEYS) {
    const values = raw[key];
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
      throw new Error('invalid catalog response values');
    }
    if (new Set(values).size !== values.length) {
      throw new Error('duplicate catalog response values');
    }
    normalized[key] = [...values].sort();
  }
  return normalized;
}

function queryCatalog(namespace) {
  const result = spawnSync(
    'kubectl',
    [
      '--namespace',
      namespace,
      'exec',
      '-i',
      'pod/release-postgres-0',
      '--container',
      'postgres',
      '--',
      'sh',
      '-eu',
      '-c',
      'exec env PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" PGDATABASE="$POSTGRES_DB" psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --set=VERBOSITY=terse --tuples-only --no-align',
    ],
    {
      encoding: 'utf8',
      input: buildCatalogQuery(),
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  if (result.error || result.status !== 0 || result.signal || !result.stdout) {
    throw new Error('catalog query failed');
  }

  const lines = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) throw new Error('unexpected catalog output');
  return normalizeActual(JSON.parse(lines[0]));
}

function evidenceCounts(contract) {
  return {
    relations: contract.relations.length,
    columns: contract.columns.length,
    constraints: contract.constraints.length,
    indexes: contract.indexes.length,
    functions: contract.functions.length,
    roles: contract.roles.length,
    grants: contract.grants.length,
  };
}

function writeAtomic0600(outputPath, content) {
  const outputDirectory = dirname(outputPath);
  const directoryMetadata = lstatSync(outputDirectory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error('unsafe output directory');
  }
  if (existsSync(outputPath)) {
    const outputMetadata = lstatSync(outputPath);
    if (!outputMetadata.isFile() || outputMetadata.isSymbolicLink()) {
      throw new Error('unsafe output target');
    }
  }

  const temporaryPath = resolve(
    outputDirectory,
    `.${basename(outputPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, outputPath);
    const directoryDescriptor = openSync(outputDirectory, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function buildPassedEvidence(options, actual, verifiedAt = new Date().toISOString()) {
  const contractDigest = digest(SCHEMA_CONTRACT);
  const actualDigest = digest(actual);
  if (actualDigest !== contractDigest) throw new Error('schema contract mismatch');

  return {
    schemaVersion: 1,
    status: 'passed',
    contractVersion: CONTRACT_VERSION,
    environment: options.environment,
    namespace: options.namespace,
    sourceSha: options.sourceSha,
    migrationHead: options.migrationHead,
    contractDigest,
    actualDigest,
    verified: true,
    counts: evidenceCounts(SCHEMA_CONTRACT),
    verifiedAt,
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const actual = queryCatalog(options.namespace);
  const evidence = buildPassedEvidence(options, actual);
  const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
  writeAtomic0600(options.output, serializedEvidence);
  process.stdout.write(`sha256:${createHash('sha256').update(serializedEvidence).digest('hex')}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    process.stderr.write('schema_verification_failed\n');
    process.exitCode = 1;
  }
}
