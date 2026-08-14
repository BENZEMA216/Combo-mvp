import type { Client } from 'pg';

const APPLICATION_ROLE_GROUPS = [
  [
    { role: 'combo_api', envKey: 'POSTGRES_API_PASSWORD' },
    { role: 'combo_worker', envKey: 'POSTGRES_WORKER_PASSWORD' },
    { role: 'combo_runtime', envKey: 'POSTGRES_RUNTIME_PASSWORD' },
  ],
  [
    { role: 'combo_agent_api', envKey: 'POSTGRES_AGENT_API_PASSWORD' },
    { role: 'combo_agent_broker', envKey: 'POSTGRES_AGENT_BROKER_PASSWORD' },
    { role: 'combo_agent_reconciler', envKey: 'POSTGRES_AGENT_RECONCILER_PASSWORD' },
  ],
  // Public Conversation admission is an independent rollout boundary. It must never force an
  // existing Creator/Broker deployment to provision a new credential, and it must never share
  // combo_agent_api's control-plane authority.
  [{ role: 'combo_agent_consumer_api', envKey: 'POSTGRES_AGENT_CONSUMER_API_PASSWORD' }],
] as const;

/**
 * 0008 先创建无登录应用角色并收口权限。迁移全部成功后，本函数才通过绑定参数设置
 * 每组独立密码并启用登录；密码不进入迁移 SQL、输出或异常消息。VNext control-plane
 * 角色组与 Consumer 单角色都是可独立启用的 expand 阶段，因此旧环境不需要在同一个
 * rollout 立即配置新凭据；任何服务都不得共用另一个服务的数据库身份。
 */
export async function provisionApplicationRoleLogins(client: Client): Promise<boolean> {
  const enabledGroups = APPLICATION_ROLE_GROUPS.filter((group) =>
    group.some(({ envKey }) => Boolean(process.env[envKey])),
  );
  if (enabledGroups.length === 0) return false;

  for (const group of enabledGroups) {
    const missing = group.filter(({ envKey }) => !process.env[envKey]).map(({ envKey }) => envKey);
    if (missing.length > 0) {
      throw new Error(`[db-roles] 应用数据库角色配置不完整：${missing.join(', ')}`);
    }
  }

  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    for (const { role, envKey } of enabledGroups.flat()) {
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
