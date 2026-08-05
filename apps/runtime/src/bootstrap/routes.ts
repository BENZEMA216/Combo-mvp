// 业务路由聚合：capability、session、artifact 与 agent-project 全部挂在 API_PREFIX 下。
import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@cb/shared';
import { CAPABILITY_ENDPOINTS, registerCapabilityRoutes } from '../modules/capability/routes.js';
import { SESSION_ENDPOINTS, registerSessionRoutes } from '../modules/session/routes.js';
import { ARTIFACT_ENDPOINTS, registerArtifactRoutes } from '../modules/artifact/routes.js';
import {
  AGENT_PROJECT_RUNTIME_ENDPOINTS,
  registerAgentProjectRuntimeRoutes,
} from '../modules/agent-project/routes.js';
import { registerClientEventRoutes } from '../platform/http/client-events.js';
import type { EndpointDecl } from '../platform/http/_helpers.js';

/** 全部业务端点声明汇总（供守门/测试核对端点数、方法、鉴权链）。 */
export const ALL_ENDPOINTS: EndpointDecl[] = [
  ...CAPABILITY_ENDPOINTS,
  ...SESSION_ENDPOINTS,
  ...ARTIFACT_ENDPOINTS,
  ...AGENT_PROJECT_RUNTIME_ENDPOINTS,
];

/** 注册全部业务路由（API_PREFIX 子作用域）。 */
export async function registerBusinessRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (scoped) => {
      await registerCapabilityRoutes(scoped);
      await registerSessionRoutes(scoped);
      await registerArtifactRoutes(scoped);
      await registerAgentProjectRuntimeRoutes(scoped);
      await registerClientEventRoutes(scoped); // 浏览器侧错误/调试事件（只落结构化日志）
    },
    { prefix: API_PREFIX },
  );
}
