import type { Client } from 'pg';

const V2_APPLICATION_ROLES = [
  { role: 'combo_api', envKey: 'POSTGRES_API_PASSWORD' },
  { role: 'combo_worker', envKey: 'POSTGRES_WORKER_PASSWORD' },
  { role: 'combo_runtime', envKey: 'POSTGRES_RUNTIME_PASSWORD' },
  { role: 'combo_authz', envKey: 'POSTGRES_AUTHZ_PASSWORD' },
  { role: 'combo_billing', envKey: 'POSTGRES_BILLING_PASSWORD' },
] as const;

/**
 * combo-v2 先复用 canonical 0008 收口三角色，再由 V2 0012/0013 增加 authz 与 billing。
 * 五份密码必须一起提供，其中前三份必须与共享 PostgreSQL 实例中的正式角色保持一致。
 */
export async function provisionV2ApplicationRoleLogins(client: Client): Promise<boolean> {
  const configured = V2_APPLICATION_ROLES.filter(({ envKey }) => Boolean(process.env[envKey]));
  if (configured.length === 0) return false;

  const missing = V2_APPLICATION_ROLES.filter(({ envKey }) => !process.env[envKey]).map(
    ({ envKey }) => envKey,
  );
  if (missing.length > 0) {
    throw new Error(`[db-v2-roles] V2 应用数据库角色配置不完整：${missing.join(', ')}`);
  }

  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    for (const { role, envKey } of V2_APPLICATION_ROLES) {
      const formatted = await client.query<{ statement: string }>(
        `SELECT format(
           'ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
           $1::text
         ) AS statement`,
        [process.env[envKey]!],
      );
      const statement = formatted.rows[0]?.statement;
      if (!statement) throw new Error('role statement formatting failed');
      await client.query(statement);
    }
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
