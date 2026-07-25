import { API_PREFIX, releaseMetadataFromEnv, type ReleaseMetadataEnvironment } from '@cb/shared';
import type { FastifyInstance } from 'fastify';

export const RUNTIME_VERSION_PATH = `${API_PREFIX}/runtime/version`;

export async function registerVersionRoute(
  app: FastifyInstance,
  environment: ReleaseMetadataEnvironment,
): Promise<void> {
  const metadata = releaseMetadataFromEnv(environment);

  app.get(RUNTIME_VERSION_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return metadata;
  });
}
