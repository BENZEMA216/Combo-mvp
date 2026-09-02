import type { Client } from 'pg';

const V2_APPLICATION_ROLES = [
  { role: 'combo_api', envKey: 'POSTGRES_API_PASSWORD', introducedBy: '0008' },
  { role: 'combo_worker', envKey: 'POSTGRES_WORKER_PASSWORD', introducedBy: '0008' },
  { role: 'combo_runtime', envKey: 'POSTGRES_RUNTIME_PASSWORD', introducedBy: '0008' },
  { role: 'combo_authz', envKey: 'POSTGRES_AUTHZ_PASSWORD', introducedBy: '0012' },
  { role: 'combo_billing', envKey: 'POSTGRES_BILLING_PASSWORD', introducedBy: '0013' },
] as const;

type V2ApplicationRole = (typeof V2_APPLICATION_ROLES)[number];
export type ExistingV2ApplicationRoles = ReadonlySet<string>;
const SHARED_CANONICAL_ROLES = new Set(['combo_api', 'combo_worker', 'combo_runtime']);

function configuredRoles(): Array<V2ApplicationRole & { password: string }> {
  const missing = V2_APPLICATION_ROLES.filter(({ envKey }) => !process.env[envKey]).map(
    ({ envKey }) => envKey,
  );
  if (missing.length > 0) {
    throw new Error(`[db-v2-roles] V2 应用数据库角色配置不完整：${missing.join(', ')}`);
  }
  return V2_APPLICATION_ROLES.map((role) => ({ ...role, password: process.env[role.envKey]! }));
}

export function assertV2ApplicationRolePasswords(): void {
  configuredRoles();
}

async function applyRoleLogins(
  client: Pick<Client, 'query'>,
  roles: ReadonlyArray<V2ApplicationRole & { password: string }>,
  preexistingRoles: ExistingV2ApplicationRoles,
): Promise<void> {
  for (const { role, password } of roles) {
    if (SHARED_CANONICAL_ROLES.has(role) && preexistingRoles.has(role)) {
      await client.query(
        `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      continue;
    }
    const formatted = await client.query<{ statement: string }>(
      `SELECT format(
         'ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
         $1::text
       ) AS statement`,
      [password],
    );
    const statement = formatted.rows[0]?.statement;
    if (!statement) throw new Error('role statement formatting failed');
    await client.query(statement);
  }
}

/** 迁移前的 cluster-global 角色快照；已存在的 canonical 三角色绝不改密码。 */
export async function snapshotExistingV2ApplicationRoles(
  client: Pick<Client, 'query'>,
): Promise<Set<string>> {
  const found = await client.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles
      WHERE rolname = ANY($1::text[])`,
    [V2_APPLICATION_ROLES.map(({ role }) => role)],
  );
  return new Set(found.rows.map(({ rolname }) => rolname));
}

/**
 * V2 重放 canonical 0008、V2 0012/0013 时会执行 NOLOGIN。runner 在同一迁移
 * transaction、COMMIT 之前恢复该文件涉及的角色，因此其他连接永远看不到禁用状态。
 */
export async function restoreV2RoleLoginsWithinMigration(
  client: Pick<Client, 'query'>,
  migrationFile: string,
  preexistingRoles: ExistingV2ApplicationRoles = new Set(),
): Promise<void> {
  const prefix = migrationFile.slice(0, 4);
  const roles = configuredRoles().filter(({ introducedBy }) => introducedBy === prefix);
  if (roles.length > 0) await applyRoleLogins(client, roles, preexistingRoles);
}

/** 全量账本成功后再复验并配置五个角色；独立 transaction 保证全有或全无。 */
export async function provisionV2ApplicationRoleLogins(
  client: Client,
  preexistingRoles: ExistingV2ApplicationRoles = new Set(),
): Promise<boolean> {
  const roles = configuredRoles();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await applyRoleLogins(client, roles, preexistingRoles);
    await client.query('COMMIT');
    transactionStarted = false;
    return true;
  } catch {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 回滚诊断也不得替换稳定错误或携带连接与密码上下文。
      }
    }
    throw new Error('[db-v2-roles] V2 应用数据库角色配置失败');
  }
}
