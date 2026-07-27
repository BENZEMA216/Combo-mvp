import type { Client } from 'pg';

const APPLICATION_ROLES = [
  { role: 'combo_api', envKey: 'POSTGRES_API_PASSWORD' },
  { role: 'combo_worker', envKey: 'POSTGRES_WORKER_PASSWORD' },
  { role: 'combo_runtime', envKey: 'POSTGRES_RUNTIME_PASSWORD' },
] as const;

/**
 * 0008 先创建无登录应用角色并收口权限。迁移全部成功后，本函数才通过绑定参数设置
 * 三份独立密码并启用登录；密码不进入迁移 SQL、输出或异常消息。
 */
export async function provisionApplicationRoleLogins(client: Client): Promise<boolean> {
  const configured = APPLICATION_ROLES.filter(({ envKey }) => Boolean(process.env[envKey]));
  if (configured.length === 0) return false;

  const missing = APPLICATION_ROLES.filter(({ envKey }) => !process.env[envKey]).map(
    ({ envKey }) => envKey,
  );
  if (missing.length > 0) {
    throw new Error(`[db-roles] 应用数据库角色配置不完整：${missing.join(', ')}`);
  }

  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    for (const { role, envKey } of APPLICATION_ROLES) {
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
    throw new Error('[db-roles] 应用数据库角色配置失败');
  }
}
