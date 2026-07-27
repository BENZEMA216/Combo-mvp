// Fastify 类型增强：中间件注入的请求装饰 + app 级容器。
import type { AuthContext } from '@cb/shared';
import type { InfraContext } from '../infra/index.js';
import type { TurnRunner } from '../../modules/agent/run-turn.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** 基础设施容器（数据库、对象存储、事件设施与可选沙箱后端），由 app.decorate('infra') 注入。 */
    infra: InfraContext;
    /** 会话轮次自治编排器，bootstrap 组装后 app.decorate('turns') 注入。 */
    turns: TurnRunner;
  }
  interface FastifyRequest {
    /** requireAuth / requireSseAuth 解出的鉴权上下文。 */
    auth?: AuthContext;
  }
}

export {};
