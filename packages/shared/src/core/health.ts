// 健康检查契约。/health 提供存活探针，/ready 检查服务运行所需依赖。
import { z } from 'zod';

export const HealthStatusSchema = z.enum(['ok', 'degraded', 'down']);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/** 四个 required 依赖加 llm；llm 只造成 degraded，不计入 ready。 */
export const DependencyNameSchema = z.enum(['db', 'redis_queue', 'redis_hot', 'minio', 'llm']);
export type DependencyName = z.infer<typeof DependencyNameSchema>;

export const DependencyHealthSchema = z.object({
  name: DependencyNameSchema,
  status: HealthStatusSchema,
  required: z.boolean().describe('是否计入 /ready'),
});
export type DependencyHealth = z.infer<typeof DependencyHealthSchema>;

export const ReadyViewSchema = z.object({
  status: HealthStatusSchema.describe(
    '任一 required 依赖 down 时为 down；llm degraded 时为 degraded 但 ready=true',
  ),
  ready: z.boolean(),
  dependencies: z.array(DependencyHealthSchema),
});
export type ReadyView = z.infer<typeof ReadyViewSchema>;

/** /health（liveness）响应。 */
export const HealthViewSchema = z.object({ status: z.literal('ok') });
export type HealthView = z.infer<typeof HealthViewSchema>;

/** 计入 /ready 的依赖。外部邮件供应商不影响已有会话与业务请求，因此不在此列。 */
export const REQUIRED_DEPENDENCIES = ['db', 'redis_queue', 'redis_hot', 'minio'] as const;
