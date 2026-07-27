// Fastify 类型增强：声明中间件注入的请求装饰 + app.infra 基础设施容器。
import type { AuthContext } from '@cb/shared';
import type { InfraContext } from '../infra/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** 数据库、Redis、队列、对象存储、大模型、邮件与认证限流容器。 */
    infra: InfraContext;
  }
  interface FastifyRequest {
    /** requireAuth / requireSseAuth 解出的鉴权上下文。 */
    auth?: AuthContext;
  }
}

export {};
