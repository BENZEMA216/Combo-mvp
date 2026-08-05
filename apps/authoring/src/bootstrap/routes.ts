// 业务路由聚合：account / task / capability 全环境注册；demo 只在 Test 注册。
import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@cb/shared';
import type { Env } from '../platform/config/env.js';
import { ACCOUNT_ENDPOINTS, registerAccountRoutes } from '../modules/account/routes.js';
import { TASK_ENDPOINTS, registerTaskRoutes } from '../modules/task/routes.js';
import { CAPABILITY_ENDPOINTS, registerCapabilityRoutes } from '../modules/capability/routes.js';
import { DEMO_ENDPOINTS, registerDemoRoutes } from '../modules/demo/routes.js';
import { registerClientEventRoutes } from '../platform/http/client-events.js';
import type { EndpointDecl } from '../platform/http/_helpers.js';

/** 全部业务端点声明汇总，供守门测试核对端点数、方法、来源边界和鉴权链。 */
export const ALL_ENDPOINTS: EndpointDecl[] = [
  ...ACCOUNT_ENDPOINTS,
  ...TASK_ENDPOINTS,
  ...CAPABILITY_ENDPOINTS,
];

/** Test-only 端点不进入常规端点表，避免被其他环境误注册。 */
export function endpointsForEnvironment(env: Pick<Env, 'COMBO_ENVIRONMENT'>): EndpointDecl[] {
  return env.COMBO_ENVIRONMENT === 'test' ? [...ALL_ENDPOINTS, ...DEMO_ENDPOINTS] : ALL_ENDPOINTS;
}

/** 注册全部业务路由（API_PREFIX 子作用域）。 */
export async function registerBusinessRoutes(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(
    async (scoped) => {
      await registerAccountRoutes(scoped);
      await registerTaskRoutes(scoped);
      await registerCapabilityRoutes(scoped);
      if (env.COMBO_ENVIRONMENT === 'test') await registerDemoRoutes(scoped);
      await registerClientEventRoutes(scoped); // 浏览器侧错误/调试事件（只落结构化日志）
    },
    { prefix: API_PREFIX },
  );
}
